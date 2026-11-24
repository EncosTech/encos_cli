// SPDX-License-Identifier: MIT

import {jsonMode,jsonSample,setJsonResult} from '../json-output.js'

import {
  LogLevel,
  MotorParameter,
  MotorStopMode,
  type ControlResult,
} from '@encos/encos-driver-native'

import { flagBoolean, rejectUnknownFlags, type ParsedArgs } from '../args.js'
import { Interrupt, sleep } from '../async.js'
import {
  degreesToRadians,
  formatBatchControlHeader,
  formatBatchControlRow,
  formatControlHeader,
  formatControlRow,
  formatMotorError,
  radiansToDegrees,
} from '../format.js'
import {
  adapterTiming,
  disposeTargets,
  openRuntime,
  resolveMotorTargets,
  runtimeOptionsFromArgs,
  type ResolvedMotor,
} from '../runtime.js'
import { parseFloatValue, parseMotorTarget } from '../target.js'

type ControlMode = 'pvt' | 'position' | 'speed' | 'current' | 'torque' | 'stop' | 'brake'

const MODES = new Set<ControlMode>(['pvt', 'position', 'speed', 'current', 'torque', 'stop', 'brake'])

interface ControlPlan {
  mode: ControlMode
  values: number[]
  stopMode?: number
  brakeEnabled?: boolean
}

export async function runControl(args: ParsedArgs): Promise<number> {
  rejectUnknownFlags(args, ['canfd', 'wait-feedback'])
  const [rawMode, targetValue, ...rawValues] = args.positionals
  if (rawMode === undefined || targetValue === undefined) {
    throw new Error('用法: emcli control [--canfd] <mode> <target> <values>')
  }
  const mode = rawMode as ControlMode
  if (!MODES.has(mode)) {
    throw new Error(`未知控制模式 '${rawMode}'`)
  }
  const target = parseMotorTarget(targetValue)
  const plan = parsePlan(mode, rawValues)
  const canfd = flagBoolean(args, 'canfd')
  const feedbackType = flagBoolean(args, 'wait-feedback') ? 1 : 0
  const runtime = await openRuntime(runtimeOptionsFromArgs(args))
  const resolved = await resolveMotorTargets(runtime, target, adapterTiming(args), LogLevel.Warn)
  const interrupt = new Interrupt()

  try {
    const kts = new Map<number, number>()
    for (const entry of resolved.motors) {
      if (canfd) entry.motor.enableCanFd()
      entry.motor.setOnStatus(() => {})
      if (plan.mode !== 'brake') {
        kts.set(entry.motor.handle, await entry.motor.getParameter(MotorParameter.Kt))
      }
    }

    if (plan.mode === 'brake') {
      let failed = false
      const results:unknown[]=[];setJsonResult({mode,results})
      for (const entry of resolved.motors) {
        try {
          const acknowledged = await entry.motor.brake(plan.brakeEnabled === true, true)
          if (!acknowledged) throw new Error('机械抱闸未收到确认')
          results.push({target:address(entry),ok:true,acknowledged,state:plan.brakeEnabled?'engage':'release'});if(!jsonMode)console.log(`${prefix(entry)} ${plan.brakeEnabled ? 'brake engaged' : 'brake released'}`)
        } catch (error) {
          failed = true;results.push({target:address(entry),ok:false,error:{message:message(error)}})
          if (target.scope === 'motor') throw error
          console.error(`${prefix(entry)} error: ${message(error)}`)
        }
      }
      return failed ? 1 : 0
    }

    const batch = target.scope !== 'motor'
    const summary={mode,values:plan.values,stopMode:plan.stopMode,targets:resolved.motors.map(address),stopped:false};setJsonResult(summary)
    let lastPrint = 0
    let lines = 0
    while (!interrupt.stopped) {
      const results: Array<{ entry: ResolvedMotor; result: ControlResult }> = []
      for (const entry of resolved.motors) {
        try {
          const result = await sendControl(entry, plan, feedbackType)
          results.push({ entry, result })
        } catch (error) {
          if (target.scope === 'motor') throw error
          if(jsonMode)throw error
          console.error(`${prefix(entry)} error: ${message(error)}`)
          return 1
        }
      }
      const current = Date.now()
      if (current - lastPrint >= 500) {
        if (!jsonMode&&lines % 10 === 0) {
          console.log(batch ? formatBatchControlHeader() : formatControlHeader())
        }
        for (const { entry, result } of results) {
          const feedback=await readFeedback(entry,result,kts.get(entry.motor.handle)??0)
          if(jsonMode){jsonSample({mode,target:address(entry),feedback});continue}
          const row = formatControlRow(feedback)
          console.log(batch ? formatBatchControlRow(entry.slaveId, entry.busId, entry.motorId, row) : row)
          lines += 1
        }
        lastPrint = current
      }
      await sleep(100)
    }
    summary.stopped=true
    return 0
  } finally {
    interrupt.dispose()
    for (const entry of resolved.motors) {
      try {
        entry.motor.setOnStatus(null)
      } catch {
        // ignore
      }
    }
    disposeTargets(resolved)
    runtime.dispose()
  }
}

function parsePlan(mode: ControlMode, raw: string[]): ControlPlan {
  const number = (index: number, field: string): number => {
    if (raw[index] === undefined) throw new Error(`控制模式 '${mode}' 缺少 ${field}`)
    return parseFloatValue(raw[index], field)
  }
  switch (mode) {
    case 'pvt':
      if (raw.length !== 5) {
        throw new Error('用法: control pvt <target> <kp> <kd> <position_deg> <speed> <torque>')
      }
      return {
        mode,
        values: [
          number(0, 'Kp'),
          number(1, 'Kd'),
          degreesToRadians(number(2, 'Position')),
          number(3, 'Speed'),
          number(4, 'Torque'),
        ],
      }
    case 'position':
      if (raw.length !== 3) {
        throw new Error('用法: control position <target> <position_deg> <speed> <current>')
      }
      return {
        mode,
        values: [degreesToRadians(number(0, 'Position')), number(1, 'Speed'), number(2, 'Current')],
      }
    case 'speed':
      if (raw.length !== 2) throw new Error('用法: control speed <target> <speed> <current>')
      return { mode, values: [number(0, 'Speed'), number(1, 'Current')] }
    case 'current':
      if (raw.length !== 1) throw new Error('用法: control current <target> <current>')
      return { mode, values: [number(0, 'Current')] }
    case 'torque':
      if (raw.length !== 1) throw new Error('用法: control torque <target> <torque>')
      return { mode, values: [number(0, 'Torque')] }
    case 'stop': {
      const name = raw[0]
      const mapped =
        name === 'full'
          ? MotorStopMode.FullBrake
          : name === 'dynamic'
            ? MotorStopMode.DynamicBrake
            : name === 'regenerative'
              ? MotorStopMode.RegenerativeBrake
              : undefined
      if (mapped === undefined) {
        throw new Error('用法: control stop <target> full|dynamic|regenerative [current]')
      }
      return {
        mode,
        values: [],
        stopMode: mapped,
        ...(raw[1] === undefined ? {} : { values: [number(1, 'Current')] }),
      }
    }
    case 'brake': {
      if (raw[0] !== 'engage' && raw[0] !== 'release') {
        throw new Error('用法: control brake <target> engage|release')
      }
      return { mode, values: [], brakeEnabled: raw[0] === 'engage' }
    }
  }
}

async function sendControl(
  entry: ResolvedMotor,
  plan: ControlPlan,
  feedbackType: 0 | 1,
): Promise<ControlResult> {
  switch (plan.mode) {
    case 'pvt':
      return entry.motor.pvtControl({
        kp: plan.values[0],
        kd: plan.values[1],
        position: plan.values[2],
        speed: plan.values[3],
        torque: plan.values[4],
        feedbackType,
      })
    case 'position':
      return entry.motor.posControl({
        position: plan.values[0],
        speed: plan.values[1],
        current: plan.values[2],
        feedbackType,
      })
    case 'speed':
      return entry.motor.spdControl({
        speed: plan.values[0],
        current: plan.values[1],
        feedbackType,
      })
    case 'current':
      return entry.motor.curControl({ current: plan.values[0], feedbackType: 1 })
    case 'torque':
      return entry.motor.torControl({ torque: plan.values[0], feedbackType: 1 })
    case 'stop':
      return entry.motor.stop({
        mode: plan.stopMode ?? MotorStopMode.FullBrake,
        current: plan.values[0] ?? 0,
        feedbackType,
      })
    case 'brake':
      throw new Error('brake 不应进入连续控制循环')
  }
}

async function readFeedback(
  entry: ResolvedMotor,
  result: ControlResult,
  kt: number,
) {
  const feedback = result.feedback ?? entry.motor.getStatus().status
  let position = feedback?.position
  if (position === undefined) {
    try {
      position = await entry.motor.getParameter(MotorParameter.Position)
    } catch {
      position = Number.NaN
    }
  }
  return {
    positionDeg: radiansToDegrees(position),
    speed: feedback?.speed ?? Number.NaN,
    torque: feedback === undefined ? Number.NaN : feedback.current * kt,
    current: feedback?.current ?? Number.NaN,
    motorTemperature: feedback?.motorTemperature ?? Number.NaN,
    mosTemperature: feedback?.mosTemperature ?? Number.NaN,
    error: feedback === undefined ? 'NoResponse' : formatMotorError(feedback.error),
  }
}

function prefix(entry: ResolvedMotor): string {
  return `${entry.adapterType}:${entry.adapterId}:${entry.slaveId === null ? '' : `${entry.slaveId}:`}${
    entry.busId
  }:${entry.motorId}`
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function address(entry:ResolvedMotor){return {adapterType:entry.adapterType,interfaceName:entry.adapterId,slaveId:entry.slaveId,busId:entry.busId,motorId:entry.motorId}}
