// SPDX-License-Identifier: MIT

import {jsonMode,jsonSample,setJsonResult} from '../json-output.js'

import {
  loadEmcliNative,
  type EmcliNativeApi,
  type NativeStressUpdate,
} from '@encos/emcli-native'

import { flagInteger, rejectUnknownFlags, type ParsedArgs } from '../args.js'
import { Interrupt, sleep } from '../async.js'
import { formatStatsLine, type StatsTotals } from '../format.js'
import { adapterTiming, openRuntime, runtimeOptionsFromArgs } from '../runtime.js'
import { dropRate } from '../stats.js'
import {
  parseAdapterSpec,
  parseMotorTarget,
  splitColonSeparated,
} from '../target.js'

interface NativeMotorConfig {
  adapterType: string
  interfaceName: string
  slaveId?: number
  busId: number
  motorId: number
}

export async function runStress(args: ParsedArgs): Promise<number> {
  rejectUnknownFlags(args, ['loop-period-ms', 'warmup-delay-ms', 'drain-delay-ms'])
  if (args.positionals.length === 0) {
    throw new Error('用法: emcli stress <Type:Id...>')
  }
  const loopPeriodMs = flagInteger(args, 'loop-period-ms') ?? 1
  const warmupDelayMs = flagInteger(args, 'warmup-delay-ms') ?? 100
  const drainDelayMs = flagInteger(args, 'drain-delay-ms') ?? 200
  if (loopPeriodMs <= 0) throw new Error('--loop-period-ms 必须大于 0')

  const runtime = await openRuntime(runtimeOptionsFromArgs(args))
  const native = loadEmcliNative()
  const interrupt = new Interrupt()
  let session: ReturnType<EmcliNativeApi['stress']> | undefined

  try {
    const motors = resolveMotors(native, args.positionals,adapterTiming(args))
    if (warmupDelayMs > 0) await sleep(warmupDelayMs)
    session = native.stress({timing:adapterTiming(args), motors, periodMs: loopPeriodMs })
    session.start()
    let lastPrint = 0
    let hasReport = false
    while (!interrupt.stopped) {
      const current = Date.now()
      if (current - lastPrint >= 500) {
        const snapshot = session.poll()
        if (snapshot.error !== '') throw new Error(snapshot.error)
        if (!jsonMode&&hasReport) console.log('')
        if(jsonMode)jsonSample(jsonReport(motors,snapshot));else printReport('===== LIVE STATUS (Press Ctrl+C to stop) =====', motors, snapshot)
        hasReport = true
        lastPrint = current
      }
      await sleep(100)
    }
    const final = session.stop(drainDelayMs)
    if (final.error !== '') throw new Error(final.error)
    if(!jsonMode)console.log(
      `\nDrain wait: ${final.drainMs} ms; additional replies: ${final.drainAdditional}; ` +
        `outstanding before/after: ${final.outstandingBefore}/${final.outstandingAfter}`,
    )
    setJsonResult(jsonReport(motors,final));if(!jsonMode)printReport('================ FINAL RESULT ================', motors, final)
    return 0
  } finally {
    interrupt.dispose()
    session?.dispose()
    runtime.dispose()
  }
}

function resolveMotors(native: EmcliNativeApi, links: string[],timing:ReturnType<typeof adapterTiming>): NativeMotorConfig[] {
  const result: NativeMotorConfig[] = []
  const seen = new Set<string>()
  const append = (motor: NativeMotorConfig): void => {
    const key = `${motor.adapterType}:${motor.interfaceName}:${motor.slaveId}:${motor.busId}:${motor.motorId}`
    if (seen.has(key)) return
    seen.add(key)
    result.push(motor)
  }
  const scan = (
    type: string,
    interfaceName: string,
    slaveId?: number,
    busId?: number,
  ): void => {
    for (const row of native.scan({timing,
      type,
      interfaceName,
      ...(slaveId === undefined ? {} : { slaveId }),
      ...(busId === undefined ? {} : { busId }),
    })) {
      append({
        adapterType: type,
        interfaceName,
        ...(row.slaveId === null ? {} : { slaveId: row.slaveId }),
        busId: row.busId,
        motorId: row.motorId,
      })
    }
  }

  for (const link of links) {
    const parts = splitColonSeparated(link)
    if (parts.length <= 3) {
      const spec = parseAdapterSpec(link)
      if (parts.length === 3 && parts[2] !== 'ALL') {
        throw new Error(`stress 的适配器链路不支持总线选择: '${link}'，请使用 Type:Id 或 Type:Id:ALL`)
      }
      scan(spec.type, spec.id)
      continue
    }
    const target = parseMotorTarget(link)
    if (target.scope === 'motor' && target.motorId !== undefined && target.busId !== undefined) {
      append({
        adapterType: target.adapterType,
        interfaceName: target.adapterId,
        ...(target.slaveId === undefined ? {} : { slaveId: target.slaveId }),
        busId: target.busId,
        motorId: target.motorId,
      })
    } else {
      scan(target.adapterType, target.adapterId, target.slaveId, target.busId)
    }
  }
  if (result.length === 0) throw new Error('没有匹配到电机')
  return result
}

function printReport(
  title: string,
  motors: NativeMotorConfig[],
  snapshot: NativeStressUpdate,
): void {
  const seconds = (snapshot.final ? snapshot.measurementMs : snapshot.elapsedMs) / 1000
  console.log(title)
  console.log(`Measurement seconds: ${seconds.toFixed(3)}`)
  const total: StatsTotals = { sent: snapshot.sent, received: snapshot.received }
  console.log(formatStatsLine('Overview', total, seconds, 0))

  const adapters = new Map<string, number[]>()
  motors.forEach((motor, index) => {
    const key = `${motor.adapterType}:${motor.interfaceName}`
    const list = adapters.get(key) ?? []
    list.push(index)
    adapters.set(key, list)
  })
  for (const [label, indices] of adapters) {
    const adapterTotals = totalsOf(snapshot, indices)
    console.log(formatStatsLine(`Adapter ${label}`, adapterTotals, seconds, 1))

    const buses = new Map<string, number[]>()
    for (const index of indices) {
      const motor = motors[index]
      const key = `${motor.slaveId ?? ''}:${motor.busId}`
      const list = buses.get(key) ?? []
      list.push(index)
      buses.set(key, list)
    }
    for (const [busKey, busIndices] of buses) {
      const [slaveText, busText] = busKey.split(':')
      const busLabel =
        slaveText === '' ? `Bus ${busText}` : `Slave ${slaveText} Bus ${busText}`
      console.log(formatStatsLine(busLabel, totalsOf(snapshot, busIndices), seconds, 2))
      for (const index of busIndices) {
        const motor = snapshot.motors[index]
        if (motor === undefined) continue
        console.log(
          formatStatsLine(
            `Motor ${motor.motorId}`,
            { sent: motor.sent, received: motor.received },
            seconds,
            3,
          ),
        )
      }
    }
  }
}

function totalsOf(snapshot: NativeStressUpdate, indices: number[]): StatsTotals {
  let sent = 0
  let received = 0
  for (const index of indices) {
    const motor = snapshot.motors[index]
    if (motor === undefined) continue
    sent += motor.sent
    received += motor.received
  }
  return { sent, received }
}

function jsonReport(motors:NativeMotorConfig[],snapshot:NativeStressUpdate){
 return {...snapshot,measurementMs:snapshot.final?snapshot.measurementMs:snapshot.elapsedMs,motors:motors.map((motor,i)=>({...motor,...snapshot.motors[i],slaveId:motor.slaveId??null}))}

}
