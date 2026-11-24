// SPDX-License-Identifier: MIT

import {jsonMode,jsonSample,setJsonResult} from '../json-output.js'

import { LogLevel } from '@encos/encos-driver-native'

import { rejectUnknownFlags, type ParsedArgs } from '../args.js'
import { Interrupt, sleep } from '../async.js'
import { formatCliFloat } from '../format.js'
import {
  adapterTiming,
  createAdapter,
  openRuntime,
  runtimeOptionsFromArgs,
} from '../runtime.js'
import { parseDeviceTarget } from '../target.js'

const ERROR_LABELS: Array<[string, string]> = [
  ['couldNotCharge', 'could not charge'],
  ['couldNotDischarge', 'could not discharge'],
  ['lowBattery', 'low battery'],
  ['overCurrentSteady', 'over current steady'],
  ['overCurrentPeak', 'over current peak'],
  ['overCurrentCharge', 'over current charge'],
  ['batteryOverTemp', 'battery over temp'],
  ['mosOverTemp', 'mos over temp'],
  ['couldNotCommunicate', 'could not communicate'],
  ['stoppedEmergency', 'emergency stop'],
  ['chargerFault', 'charger fault'],
  ['commTimeout', 'communication timeout'],
]

export async function runBattery(args: ParsedArgs): Promise<number> {
  rejectUnknownFlags(args, [])
  const [action, targetValue] = args.positionals
  if (action === undefined || targetValue === undefined) {
    throw new Error('用法: emcli battery show|clear <target>')
  }
  if (action !== 'show' && action !== 'clear') {
    throw new Error(`未知电池动作 '${action}'`)
  }
  const target = parseDeviceTarget(targetValue)
  const runtime = await openRuntime(runtimeOptionsFromArgs(args))
  const adapter = await createAdapter(
    runtime,
    { type: target.adapterType, id: target.adapterId },
    adapterTiming(args),
    LogLevel.Warn,
  )
  try {
    const bus =
      target.slaveId === undefined
        ? adapter.getBus(target.busId)
        : adapter.getBus(target.slaveId, target.busId)
    const battery = bus.getBattery(target.index)
    if (action === 'clear') {
      battery.clearFault()
      setJsonResult({action,target,submitted:true});if(!jsonMode)console.log('success')
      return 0
    }
    const interrupt = new Interrupt()
    try {
      let previousLines = 0
      setJsonResult({action:'show',target:target})
      while (!interrupt.stopped) {
        const status=battery.getStatus()
        if(jsonMode){jsonSample({target:target,status});await sleep(20);continue}
        const report = buildReport(status)
        if(previousLines!==0)process.stdout.write('\n')
        process.stdout.write(report)
        previousLines = report.split('\n').length - 1
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

function valueLine(key: string, value: number | undefined): string {
  return key.padEnd(22) + (value === undefined ? '' : formatCliFloat(value))
}

function textLine(key: string, value: string): string {
  return key.padEnd(22) + value
}

function buildReport(status: {
  state?: { soc: number; voltage: number }
  temp?: { battery: number; mos: number; dischargeCurrent: number }
  error: Record<string, boolean>
}): string {
  const lines = [
    'item'.padEnd(22) + 'value',
    valueLine('soc', status.state?.soc),
    valueLine('battery_temp_c', status.temp?.battery),
    valueLine('mos_temp_c', status.temp?.mos),
    valueLine('voltage_v', status.state?.voltage),
    valueLine('discharge_current_a', status.temp?.dischargeCurrent),
  ]
  let anyError = false
  for (const [key, label] of ERROR_LABELS) {
    if (status.error[key] === true) {
      lines.push(textLine('error', label))
      anyError = true
    }
  }
  if (!anyError) lines.push(textLine('error', 'none'))
  return `${lines.join('\n')}\n`
}
