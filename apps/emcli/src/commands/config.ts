// SPDX-License-Identifier: MIT

import {jsonMode,setJsonResult} from '../json-output.js'

import {
  LogLevel,
  MotorCommunicationMode,
  MotorParameter,
  type MotorWrapper,
} from '@encos/encos-driver-native'

import {
  flagBoolean,
  rejectUnknownFlags,
  type ParsedArgs,
} from '../args.js'
import {loadEmcliNative} from '@encos/emcli-native'
import { degreesToRadians, formatCliFloat, radiansToDegrees } from '../format.js'
import {
  adapterTiming,
  disposeTargets,
  openRuntime,
  resolveMotorTargets,
  runtimeOptionsFromArgs,
  type ResolvedMotor,
} from '../runtime.js'
import { parseFloatValue, parseInteger, parseMotorTarget } from '../target.js'

type ConfigItem =
  | 'position'
  | 'kt'
  | 'pvt-kp-range'
  | 'pvt-kd-range'
  | 'pvt-pos-range'
  | 'pvt-spd-range'
  | 'pvt-tor-range'
  | 'pvt-cur-range'
  | 'cur-pi'
  | 'spd-pi'
  | 'pos-pd'
  | 'can-timeout'
  | 'brake'
  | 'id'
  | 'comm'

const ITEMS = new Set<ConfigItem>([
  'position',
  'kt',
  'pvt-kp-range',
  'pvt-kd-range',
  'pvt-pos-range',
  'pvt-spd-range',
  'pvt-tor-range',
  'pvt-cur-range',
  'cur-pi',
  'spd-pi',
  'pos-pd',
  'can-timeout',
  'brake',
  'id',
  'comm',
])

export async function runConfig(args: ParsedArgs): Promise<number> {
  rejectUnknownFlags(args, ['canfd'])
  const [targetValue, rawItem, ...rest] = args.positionals
  if (targetValue === undefined || rawItem === undefined) {
    throw new Error('用法: emcli config [--canfd] <target> <item> [set <values...>]')
  }
  const parts=targetValue.split(':')
  if((parts[0]==='Ethernet'&&(parts.length===2||parts.length===3))||(/ethercat/i.test(parts[0])&&parts.length===2)){
    if([...args.flags.keys()].some(key=>key!=='json'))throw new Error('Options are not supported in slave configuration mode')
    const runtime=await openRuntime(runtimeOptionsFromArgs(args))
    try{const result=loadEmcliNative().slave(['config',...args.positionals]);setJsonResult({kind:'slave',...result});if(!jsonMode)for(const reply of result.replies??[])console.log(reply);return result.code??1}finally{runtime.dispose()}
  }
  const item = normalizeItem(rawItem)
  const target = parseMotorTarget(targetValue)
  const canfd = flagBoolean(args, 'canfd')

  let setting = false
  let values = rest
  if (rest[0] === 'set') {
    setting = true
    values = rest.slice(1)
  } else if (item === 'position' && rest[0] === 'reset') {
    setting = true
    values = []
  } else if (item === 'brake' && rest.length > 0) {
    setting = true
  }

  if (setting && item === 'id' && target.scope !== 'motor') {
    throw new Error('config id set 只支持单个电机目标')
  }

  const runtime = await openRuntime(runtimeOptionsFromArgs(args))
  const resolved = await resolveMotorTargets(runtime, target, adapterTiming(args), LogLevel.Warn)
  try {
    let failed = false
    const results:unknown[]=[];setJsonResult({item,results})
    for (const entry of resolved.motors) {
      try {
        if (canfd) entry.motor.enableCanFd()
        if(jsonMode){
          const readback=setting?await applySet(entry.motor,item,values):true
          const value=readback?await readJsonValue(entry.motor,item):null
          results.push({target:{adapterType:entry.adapterType,interfaceName:entry.adapterId,slaveId:entry.slaveId,busId:entry.busId,motorId:entry.motorId},ok:true,action:setting?'write':'read',value})
          continue
        }
        if (!setting) {
          await printRead(entry, item, target.scope === 'motor')
          continue
        }
        const readback = await applySet(entry.motor, item, values)
        if (target.scope === 'motor') {
          if (readback) {
            await printRead(entry, item, true)
          } else {
            console.log('success')
          }
        } else if (readback) {
          await printRead(entry, item, false)
        } else {
          console.log(`${prefix(entry)} success`)
        }
      } catch (error) {
        failed = true
        if(jsonMode)results.push({target:{adapterType:entry.adapterType,interfaceName:entry.adapterId,slaveId:entry.slaveId,busId:entry.busId,motorId:entry.motorId},ok:false,error:{message:message(error)}})
        if (target.scope === 'motor') throw error
        console.error(`${prefix(entry)} error: ${message(error)}`)
      }
    }
    return failed ? 1 : 0
  } finally {
    disposeTargets(resolved)
    runtime.dispose()
  }
}

function normalizeItem(value: string): ConfigItem {
  const item = (value === 'barke' ? 'brake' : value) as ConfigItem
  if (!ITEMS.has(item)) {
    throw new Error(`未知配置项 '${value}'`)
  }
  return item
}

function prefix(entry: ResolvedMotor): string {
  return `${entry.adapterType}:${entry.adapterId}:${entry.slaveId === null ? '' : `${entry.slaveId}:`}${
    entry.busId
  }:${entry.motorId}`
}

async function printRead(entry: ResolvedMotor, item: ConfigItem, single: boolean): Promise<void> {
  const text = `${item} ${await readValue(entry.motor, item)}`
  console.log(single ? text : `${prefix(entry)} ${text}`)
}

export async function readValue(motor: MotorWrapper, item: ConfigItem): Promise<string> {
  switch (item) {
    case 'position':
      return formatCliFloat(radiansToDegrees(await motor.getParameter(MotorParameter.Position)))
    case 'kt':
      return formatCliFloat(await motor.getParameter(MotorParameter.Kt))
    case 'pvt-kp-range':
      return intRangeText(await motor.getParameter(MotorParameter.PVTKpRange))
    case 'pvt-kd-range':
      return intRangeText(await motor.getParameter(MotorParameter.PVTKdRange))
    case 'pvt-pos-range':
      return rangeText(await motor.getParameter(MotorParameter.PVTPosRange))
    case 'pvt-spd-range':
      return rangeText(await motor.getParameter(MotorParameter.PVTSpdRange))
    case 'pvt-tor-range':
      return rangeText(await motor.getParameter(MotorParameter.PVTTorRange))
    case 'pvt-cur-range':
      return rangeText(await motor.getParameter(MotorParameter.PVTCurRange))
    case 'cur-pi': {
      const gains = await motor.getParameter(MotorParameter.CurKpKi)
      return `${formatCliFloat(gains.kp)} ${formatCliFloat(gains.ki)}`
    }
    case 'spd-pi': {
      const gains = await motor.getParameter(MotorParameter.SpdKpKi)
      return `${formatCliFloat(gains.kp)} ${formatCliFloat(gains.ki)}`
    }
    case 'pos-pd': {
      const gains = await motor.getParameter(MotorParameter.PosKpKd)
      return `${formatCliFloat(gains.kp)} ${formatCliFloat(gains.kd)}`
    }
    case 'can-timeout':
      return String(await motor.getParameter(MotorParameter.CanTimeout))
    case 'brake': {
      const state = await motor.getParameter(MotorParameter.BrakeStatus)
      if (state > 1) throw new Error(`未知机械抱闸状态: ${state}`)
      return state === 0 ? 'engage' : 'release'
    }
    case 'id':
      throw new Error("配置项 'id' 不可读取")
    case 'comm':
      throw new Error("配置项 'comm' 不可读取")
  }
}

function rangeText(range: { min: number; max: number }): string {
  return `${formatCliFloat(range.min)} ${formatCliFloat(range.max)}`
}

function intRangeText(range: { min: number; max: number }): string {
  return `${Math.trunc(range.min)} ${Math.trunc(range.max)}`
}

async function applySet(motor: MotorWrapper, item: ConfigItem, values: string[]): Promise<boolean> {
  const need = (count: number, usage: string): void => {
    if (values.length !== count) {
      throw new Error(`配置项 '${item}' 需要 ${count} 个值。用法: ${usage}`)
    }
  }
  switch (item) {
    case 'id':
      need(1, 'config <target> id set <new_id>')
      await motor.setId(parseInteger(values[0], 'NewId'), true)
      return false
    case 'kt':
      throw new Error("配置项 'kt' 只读")
    case 'position':
      if (values.length === 0) {
        await motor.resetZeroPosition(true)
        return true
      }
      need(1, 'config <target> position [set <deg>|reset]')
      await motor.setPosition(degreesToRadians(parseFloatValue(values[0], 'Position')))
      return true
    case 'pvt-kp-range':
    case 'pvt-kd-range': {
      need(2, `config <target> ${item} set <min> <max>`)
      const range = { min: parseInteger(values[0], 'Min'), max: parseInteger(values[1], 'Max') }
      if (item === 'pvt-kp-range') await motor.setPvtKpRange(range, true)
      else await motor.setPvtKdRange(range, true)
      return true
    }
    case 'pvt-pos-range':
    case 'pvt-spd-range':
    case 'pvt-tor-range':
    case 'pvt-cur-range': {
      need(2, `config <target> ${item} set <min> <max>`)
      const range = { min: parseFloatValue(values[0], 'Min'), max: parseFloatValue(values[1], 'Max') }
      if (item === 'pvt-pos-range') await motor.setPvtPosRange(range, true)
      else if (item === 'pvt-spd-range') await motor.setPvtSpdRange(range, true)
      else if (item === 'pvt-tor-range') await motor.setPvtTorRange(range, true)
      else await motor.setPvtCurRange(range, true)
      return true
    }
    case 'cur-pi':
    case 'spd-pi': {
      need(2, `config <target> ${item} set <kp> <ki>`)
      const gains = { kp: parseFloatValue(values[0], 'Kp'), ki: parseFloatValue(values[1], 'Ki') }
      if (item === 'cur-pi') await motor.setCurPi(gains, true)
      else await motor.setSpdPi(gains, true)
      return true
    }
    case 'pos-pd': {
      need(2, 'config <target> pos-pd set <kp> <kd>')
      await motor.setPosPd(
        { kp: parseFloatValue(values[0], 'Kp'), kd: parseFloatValue(values[1], 'Kd') },
        true,
      )
      return true
    }
    case 'can-timeout':
      need(1, 'config <target> can-timeout set <timeout_ms>')
      await motor.setCanTimeout(parseInteger(values[0], 'Timeout'), true)
      return true
    case 'brake': {
      need(1, 'config <target> brake engage|release')
      const state = values[0]
      if (state !== 'engage' && state !== 'release') {
        throw new Error("brake 只接受 engage 或 release")
      }
      const acknowledged = await motor.brake(state === 'engage', true)
      if (!acknowledged) throw new Error('机械抱闸未收到确认')
      return false
    }
    case 'comm': {
      need(1, 'config <target> comm set can|canfd|canopen')
      const mode = values[0]
      const mapped =
        mode === 'can'
          ? MotorCommunicationMode.ClassicCan
          : mode === 'canfd'
            ? MotorCommunicationMode.CanFd
            : mode === 'canopen'
              ? MotorCommunicationMode.CanOpen
              : undefined
      if (mapped === undefined) throw new Error(`不支持的通信模式 '${mode}'`)
      await motor.setCommunicationMode(mapped, true)
      return false
    }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function readJsonValue(motor:MotorWrapper,item:ConfigItem):Promise<unknown>{
 const parameters:Partial<Record<ConfigItem,(typeof MotorParameter)[keyof typeof MotorParameter]>>={
  kt:MotorParameter.Kt,'pvt-kp-range':MotorParameter.PVTKpRange,'pvt-kd-range':MotorParameter.PVTKdRange,
  'pvt-pos-range':MotorParameter.PVTPosRange,'pvt-spd-range':MotorParameter.PVTSpdRange,'pvt-tor-range':MotorParameter.PVTTorRange,'pvt-cur-range':MotorParameter.PVTCurRange,
  'cur-pi':MotorParameter.CurKpKi,'spd-pi':MotorParameter.SpdKpKi,'pos-pd':MotorParameter.PosKpKd,'can-timeout':MotorParameter.CanTimeout,
 }
 if(item==='position')return {positionDeg:radiansToDegrees(await motor.getParameter(MotorParameter.Position))}
 if(item==='brake')return {state:await readValue(motor,item)}
 const parameter=parameters[item]
 if(parameter===undefined)throw new Error(`Cannot read ${item}`)
 return motor.getParameter(parameter)
}
