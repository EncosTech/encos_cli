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
import { parseImuControlTarget, parseDeviceTarget } from '../target.js'

export async function runImu(args: ParsedArgs): Promise<number> {
  rejectUnknownFlags(args, [])
  const [action, targetValue] = args.positionals
  if (action === undefined || targetValue === undefined) {
    throw new Error('用法: emcli imu show|start|stop <target>')
  }
  if (action !== 'show' && action !== 'start' && action !== 'stop') {
    throw new Error(`未知 IMU 动作 '${action}'`)
  }
  const runtime = await openRuntime(runtimeOptionsFromArgs(args))
  const boot = action === 'show' ? parseDeviceTarget(targetValue) : parseImuControlTarget(targetValue)
  const adapter = await createAdapter(
    runtime,
    { type: boot.adapterType, id: boot.adapterId },
    adapterTiming(args),
    LogLevel.Warn,
  )
  try {
    const bus =
      boot.slaveId === undefined
        ? adapter.getBus(boot.busId)
        : adapter.getBus(boot.slaveId, boot.busId)
    if (action === 'start' || action === 'stop') {
      const submitted = action === 'start' ? bus.startImu() : bus.stopImu()
      if (!submitted) throw new Error('Failed to submit IMU control command')
      setJsonResult({action,target:boot,submitted});if(!jsonMode)console.log(`IMU ${action} command submitted`)
      return 0
    }
    const imu = bus.getImu((boot as ReturnType<typeof parseDeviceTarget>).index)
    const interrupt = new Interrupt()
    try {
      let previousLines = 0
      setJsonResult({action:'show',target:boot})
      while (!interrupt.stopped) {
        const status=imu.getStatus()
        if(jsonMode){jsonSample({target:boot,status});await sleep(20);continue}
        const report = buildImuReport(status)
        if(previousLines!==0)process.stdout.write('\n')
        process.stdout.write(report)
        previousLines = 4
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

function buildImuReport(status: {
  acceleration?: { x: number; y: number; z: number }
  angularVelocity?: { x: number; y: number; z: number }
  eulerAngle?: { pitch: number; roll: number; heading: number }
}): string {
  const cell = (value: number | undefined): string =>
    value === undefined ? '' : formatCliFloat(value)
  const row = (name: string, x?: number, y?: number, z?: number): string =>
    name.padEnd(8) +
    cell(x).padStart(14) +
    cell(y).padStart(14) +
    cell(z).padStart(14) +
    '\n'
  return (
    'group'.padEnd(8) + 'x'.padStart(14) + 'y'.padStart(14) + 'z'.padStart(14) + '\n' +
    row('accel', status.acceleration?.x, status.acceleration?.y, status.acceleration?.z) +
    row('gyro', status.angularVelocity?.x, status.angularVelocity?.y, status.angularVelocity?.z) +
    row('euler', status.eulerAngle?.pitch, status.eulerAngle?.roll, status.eulerAngle?.heading)
  )
}
