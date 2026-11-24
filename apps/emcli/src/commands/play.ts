// SPDX-License-Identifier: MIT

import {jsonMode,jsonSample,setJsonResult} from '../json-output.js'

import { loadEmcliNative, type NativePlaySession, type NativePlayMotor } from '@encos/emcli-native'

import {
  flagBoolean,
  flagInteger,
  flagNumberValue,
  flagString,
  rejectUnknownFlags,
  type ParsedArgs,
} from '../args.js'
import {DryPlayback} from '../studio/dry-playback.js'
import {resolve} from 'node:path'
import { Interrupt, sleep } from '../async.js'
import { formatTime } from '../format.js'
import { adapterTiming, openRuntime, runtimeOptionsFromArgs } from '../runtime.js'
import { parseTrajectoryCsv } from '../trajectory.js'

const PHASES = ['startup', 'playback', 'returning', 'finished', 'error'] as const

export async function runPlay(args: ParsedArgs): Promise<number> {
  rejectUnknownFlags(args, [
    'endless',
    'dry-run',
    'stress',
    'log',
    'log-directory',
    'control-frequency',
    'max-speed',
    'max-current',
    'kp',
    'kd',
    'vel',
    'tor',
  ])
  const csvPath = args.positionals[0]
  if (csvPath === undefined) {
    throw new Error('用法: emcli play <trajectory.csv> [options]')
  }
  const trajectory = parseTrajectoryCsv(csvPath)
  const controlFrequency = flagInteger(args, 'control-frequency') ?? 1000
  if(controlFrequency<1||controlFrequency>1_000_000_000)throw new Error('--control-frequency must be between 1 and 1000000000 Hz')
  const kp = flagNumberValue(args, 'kp')
  const kd = flagNumberValue(args, 'kd')
  const velocity = flagNumberValue(args, 'vel')
  const torque = flagNumberValue(args, 'tor')
  const hasAnyPvt = [kp, kd, velocity, torque].some(value => value !== undefined)
  if (hasAnyPvt && [kp, kd, velocity, torque].some(value => value === undefined)) {
    throw new Error('--kp、--kd、--vel、--tor 必须同时提供')
  }
  const usePvt = kp !== undefined && kd !== undefined && velocity !== undefined && torque !== undefined

  const dryRun=flagBoolean(args,'dry-run')
  const maxSpeed=flagNumberValue(args,'max-speed')??20,maxCurrent=flagNumberValue(args,'max-current')??10
  if(maxSpeed<=0||maxCurrent<=0)throw new Error('Maximum speed and current must be positive')
  const timing=adapterTiming(args)
  const requestedLog=flagString(args,'log-directory')??flagString(args,'log')??(flagBoolean(args,'log')?'./logs':undefined)
  if(requestedLog!==undefined&&!requestedLog.trim())throw new Error('Motor log directory must not be empty')
  if(dryRun&&requestedLog!==undefined)throw new Error('Motor logs are unavailable in dry run')
  const runtime = dryRun?undefined:await openRuntime(runtimeOptionsFromArgs(args))
  const native = dryRun?undefined:loadEmcliNative()
  const interrupt = new Interrupt()
  let session: NativePlaySession | undefined
  let logging=false
  let motors:NativePlayMotor[]=[]
  try {
    motors = native?resolveMotors(native, trajectory,timing):trajectory.motors.map((m,i)=>({adapterType:m.adapterType,interfaceName:m.adapterId,slaveId:m.slaveId,busId:m.busId,motorId:m.motorId,trajectoryIndex:i}))
    const names = motors.map((motor, index) =>
      index < trajectory.motors.length
        ? trajectory.motors[index].name
        : `${motor.adapterType}:${motor.interfaceName}:${motor.slaveId === undefined ? '' : `${motor.slaveId}:`}${motor.busId}:${motor.motorId}`,
    )
    const options = {
      timing,
      motors,
      times: trajectory.samples.map(sample => sample.timeSec),
      positions: trajectory.samples.flatMap(sample => sample.positionsDeg),
      motorCount: trajectory.motors.length,
      periodMs: 1000 / controlFrequency,
      startupMs: 2000,
      returnMs: 2000,
      endless: flagBoolean(args, 'endless'),
      returnToInitial: true,
      usePvt,
      kp: kp ?? 0,
      kd: kd ?? 1,
      velocity: velocity ?? 0,
      torque: torque ?? 0,
      maxSpeed,
      maxCurrent,
    }
    session = native?native.play(options):new DryPlayback(options)
    if(requestedLog!==undefined){native!.motorLog(motors,resolve(requestedLog));logging=true}
    session.start()
    let lastPrint = 0
    let returning=false
    while (true) {
      if(interrupt.stopped&&!returning){session.requestReturn();returning=true}
      const current = Date.now()
      if (current - lastPrint >= 500) {
        const update = session.poll()
        if (update.error !== '') throw new Error(update.error)
        if (update.phase === 3) break
        if(jsonMode)jsonSample({phase:PHASES[update.phase],motors:motors.map((m,i)=>({...m,...update.motors[i],slaveId:m.slaveId??null})),elapsedMs:update.elapsedMs,sent:update.sent,received:update.received,final:false});else printStatus(update, names)
        lastPrint = current
      }
      await sleep(100)
    }
    const final = session.stop()
    if (final.error !== '') throw new Error(final.error)
    setJsonResult({phase:PHASES[final.phase],motors:motors.map((m,i)=>({...m,...final.motors[i],slaveId:m.slaveId??null})),elapsedMs:final.elapsedMs,sent:final.sent,received:final.received,final:true,logDirectory:requestedLog===undefined?null:resolve(requestedLog)});if(!jsonMode)printStatus(final,names)
    return 0
  } finally {
    interrupt.dispose()
    try{session?.dispose()}finally{
      try{if(logging)native!.motorLog(motors)}finally{runtime?.dispose()}
    }
  }
}

function resolveMotors(
  native: ReturnType<typeof loadEmcliNative>,
  trajectory: ReturnType<typeof parseTrajectoryCsv>,
  timing:ReturnType<typeof adapterTiming>,
): NativePlayMotor[] {
  const motors: NativePlayMotor[] = trajectory.motors.map((connection, index) => ({
    adapterType: connection.adapterType,
    interfaceName: connection.adapterId,
    ...(connection.slaveId === undefined ? {} : { slaveId: connection.slaveId }),
    busId: connection.busId,
    motorId: connection.motorId,
    trajectoryIndex: index,
  }))
  const used = new Set(
    motors.map(
      motor =>
        `${motor.adapterType}:${motor.interfaceName}:${motor.slaveId ?? ''}:${motor.busId}:${motor.motorId}`,
    ),
  )

  // 同总线但不参与轨迹的电机保持初始位置（与旧实现一致）。
  const scanned = new Set<string>()
  for (const motor of [...motors]) {
    const key = `${motor.adapterType}:${motor.interfaceName}:${motor.slaveId ?? ''}:${motor.busId}`
    if (scanned.has(key)) continue
    scanned.add(key)
    for (const row of native.scan({timing,
      type: motor.adapterType,
      interfaceName: motor.interfaceName,
      ...(motor.slaveId === undefined ? {} : { slaveId: motor.slaveId }),
      busId: motor.busId,
    })) {
      const id = `${motor.adapterType}:${motor.interfaceName}:${row.slaveId ?? ''}:${row.busId}:${row.motorId}`
      if (used.has(id)) continue
      used.add(id)
      motors.push({
        adapterType: motor.adapterType,
        interfaceName: motor.interfaceName,
        ...(row.slaveId === null ? {} : { slaveId: row.slaveId }),
        busId: row.busId,
        motorId: row.motorId,
        holding: true,
      })
    }
  }
  return motors
}

function printStatus(
  update: {
    elapsedMs: number
    motors: Array<{
      sent: number
      received: number
    }>
  },
  names: string[],
): void {
  console.log('===== PLAY STATUS (Ctrl+C: return and stop; again: exit) =====')
  console.log(`Measurement seconds: ${formatTime(update.elapsedMs / 1000)}`)
  update.motors.forEach((motor, index) => {
    const lost = Math.max(0, motor.sent - motor.received)
    const loss = motor.sent === 0 ? 0 : (lost / motor.sent) * 100
    console.log(
      `Motor ${names[index] ?? index}: sent=${motor.sent} received=${motor.received} ` +
        `lost=${lost} loss=${loss.toFixed(2)}%`,
    )
  })
}
