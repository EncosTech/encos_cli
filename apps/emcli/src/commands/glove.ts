// SPDX-License-Identifier: MIT

import {jsonMode,jsonSample,setJsonResult} from '../json-output.js'

import { GloveCalibrationStatus, LogLevel, type GloveStatus, type GloveWrapper } from '@encos/encos-driver-native'

import { rejectUnknownFlags, type ParsedArgs } from '../args.js'
import { Interrupt, sleep } from '../async.js'
import { radiansToDegrees } from '../format.js'
import {
  adapterTiming,
  createAdapter,
  openRuntime,
  runtimeOptionsFromArgs,
} from '../runtime.js'
import { parseGloveTarget, parseInteger } from '../target.js'

export async function runGlove(args: ParsedArgs): Promise<number> {
  rejectUnknownFlags(args, [])
  const [action, targetValue, ...rest] = args.positionals
  if (action === undefined || targetValue === undefined) {
    throw new Error('用法: emcli glove show|calibrate <Type:Id:Slave> ...')
  }
  if (action !== 'show' && action !== 'calibrate') {
    throw new Error(`未知手套动作 '${action}'`)
  }
  const target = parseGloveTarget(targetValue)
  const runtime = await openRuntime(runtimeOptionsFromArgs(args))
  const adapter = await createAdapter(
    runtime,
    { type: target.adapterType, id: target.adapterId },
    adapterTiming(args),
    LogLevel.Warn,
  )
  try {
    const glove = adapter.getGlove(target.slaveId)
    if (action === 'calibrate') {
      return await calibrate(glove, rest,target)
    }
    const interrupt = new Interrupt()
    try {
      let previousLines = 0
      setJsonResult({action:'show',target:target})
      while (!interrupt.stopped) {
        const status=glove.getStatus()
        if(jsonMode){jsonSample({target:target,status});await sleep(20);continue}
        const report = buildReport(status)
        if(previousLines!==0)process.stdout.write('\n')
        process.stdout.write(report)
        previousLines = 12
        await sleep(20)
      }
      return 0
    } finally {
      interrupt.dispose()
    }
  } finally {
    adapter.dispose()
    runtime.dispose()
  }
}

async function calibrate(glove: GloveWrapper, rest: string[],target:unknown): Promise<number> {
  if (rest.length === 0) {
    throw new Error('用法: glove calibrate <target> all | <finger> <encoder> | <finger> mask <mask>')
  }
  if (rest[0] === 'all') {
    const status = await glove.calibrateAll()
    setJsonResult({action:'calibrate',target,scope:'all',status,message:calibrationText(status)});if(!jsonMode)console.log(calibrationText(status))
    return status === GloveCalibrationStatus.Success ? 0 : 1
  }
  const finger = parseInteger(rest[0], 'Finger')
  if (finger > 4) throw new Error('Finger 必须在 0..4')
  let status: number
  if (rest[1] === 'mask') {
    status = await glove.calibrateByMask(finger, parseInteger(rest[2] ?? '', 'Mask'))
  } else {
    const encoder = parseInteger(rest[1] ?? '', 'Encoder')
    if (encoder > 9) throw new Error('Encoder 必须在 0..9')
    status = await glove.calibrateByMask(finger, 1 << encoder)
  }
  setJsonResult({action:'calibrate',target,finger,selection:rest.slice(1),status,message:calibrationText(status)});if(!jsonMode)console.log(`F${finger}: ${calibrationText(status)}`)
  return status === GloveCalibrationStatus.Success ? 0 : 1
}

function calibrationText(status: number): string {
  switch (status) {
    case GloveCalibrationStatus.Success:
      return 'Calibration succeeded'
    case GloveCalibrationStatus.Failed:
      return 'Calibration failed'
    case GloveCalibrationStatus.Limited:
      return 'Calibration failed: current limited'
    case GloveCalibrationStatus.Timeout:
      return 'Calibration timed out'
    default:
      return 'Calibration returned unknown status'
  }
}

function buildReport(status: GloveStatus): string {
  let online = 0
  for (const finger of status) {
    for (const encoder of finger) {
      if (encoder !== undefined) online += 1
    }
  }
  const lines = [`online: ${online}/50`]
  let header = 'enc'.padEnd(4)
  for (let finger = 0; finger < 5; finger += 1) {
    header += `F${finger}`.padStart(9)
  }
  lines.push(header)
  for (let encoder = 0; encoder < 10; encoder += 1) {
    let row = `E${encoder}`.padEnd(4)
    for (let finger = 0; finger < 5; finger += 1) {
      const value = status[finger][encoder]
      row +=
        value === undefined
          ? 'OFF'.padStart(9)
          : radiansToDegrees(value).toFixed(2).padStart(9)
    }
    lines.push(row)
  }
  return `${lines.join('\n')}\n`
}
