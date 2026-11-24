// SPDX-License-Identifier: MIT

import {jsonMode,jsonSample,setJsonResult} from '../json-output.js'

import { LogLevel, PmsCommand } from '@encos/encos-driver-native'

import { rejectUnknownFlags, type ParsedArgs } from '../args.js'
import { Interrupt, sleep } from '../async.js'
import { formatCliFloat } from '../format.js'
import {
  adapterTiming,
  createAdapter,
  openRuntime,
  runtimeOptionsFromArgs,
} from '../runtime.js'
import { parseBusTarget } from '../target.js'

const CHANNELS = ['V48_1', 'V48_2', 'V48_3', 'V48_4', 'V48_5', 'V48_6'] as const

export async function runPms(args: ParsedArgs): Promise<number> {
  rejectUnknownFlags(args, [])
  const [action, targetValue, ...channels] = args.positionals
  if (action === undefined || targetValue === undefined) {
    throw new Error('用法: emcli pms show|enable|disable <target> [V48_x...]')
  }
  if (action !== 'show' && action !== 'enable' && action !== 'disable') {
    throw new Error(`未知 PMS 动作 '${action}'`)
  }
  const target = parseBusTarget(targetValue)
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
    const pms = bus.getPms()
    if (action !== 'show') {
      if (channels.length === 0) {
        throw new Error(`${action} 至少需要一个 V48 通道`)
      }
      let mask = 0
      for (const channel of channels) {
        const index = CHANNELS.indexOf(channel as (typeof CHANNELS)[number])
        if (index < 0) {
          throw new Error(`未知 PMS 通道 '${channel}'，可选 ${CHANNELS.join(', ')}`)
        }
        mask |= action === 'enable' ? PmsCommand.EnableChannel1 << index : PmsCommand.DisableChannel1 << index
      }
      pms.sendCommand(mask)
      setJsonResult({action,target,channels,mask,submitted:true});if(!jsonMode)console.log('success')
      return 0
    }

    const interrupt = new Interrupt()
    try {
      let previousLines = 0
      setJsonResult({action:'show',target:target})
      while (!interrupt.stopped) {
        const status=pms.getStatus()
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

function line(name: string, enabled: string, value: string): string {
  return name.padEnd(12) + enabled.padEnd(10) + value
}

function value(value: number | undefined): string {
  return value === undefined ? '' : formatCliFloat(value)
}

function buildReport(status: {
  v48ChannelEnabled: boolean[]
  v48Currents: number[]
  v19Currents: number[]
  v5Current: number
  batterySoc: number
  batteryVoltage: number
  batteryCurrent: number
} | undefined): string {
  const lines = ['item'.padEnd(12) + 'enabled'.padEnd(10) + 'value']
  for (let index = 0; index < 6; index += 1) {
    lines.push(
      line(
        `V48_${index + 1}`,
        status === undefined ? '' : status.v48ChannelEnabled[index] ? 'yes' : 'no',
        value(status?.v48Currents[index]),
      ),
    )
  }
  const v19 =
    status === undefined
      ? ''
      : `${formatCliFloat(status.v19Currents[0])} / ${formatCliFloat(status.v19Currents[1])}`
  lines.push(line('V19', '', v19))
  lines.push(line('V5', '', value(status?.v5Current)))
  lines.push(line('battery_soc', '', value(status?.batterySoc)))
  lines.push(line('battery_voltage', '', value(status?.batteryVoltage)))
  lines.push(line('battery_current', '', value(status?.batteryCurrent)))
  return `${lines.join('\n')}\n`
}
