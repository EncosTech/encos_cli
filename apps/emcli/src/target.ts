// SPDX-License-Identifier: MIT

export interface MotorTarget {
  adapterType: string
  adapterId: string
  scope: 'adapter' | 'bus' | 'motor'
  slaveId?: number
  busId?: number
  motorId?: number
}

export interface ScanTarget {
  adapterType: string
  adapterId?: string
  slaveId?: number
  busId?: number
}

export interface AdapterSpec {
  type: string
  id: string
}

/** 支持用 @...@ 包裹含冒号的接口名，例如 Ethernet:@10.0.0.2:5000@:0:1。 */
export function splitColonSeparated(value: string): string[] {
  const parts: string[] = []
  let current = ''
  let quoted = false
  for (const character of value) {
    if (character === '@') {
      quoted = !quoted
      current += character
    } else if (character === ':' && !quoted) {
      parts.push(current)
      current = ''
    } else {
      current += character
    }
  }
  parts.push(current)
  if (quoted) {
    throw new Error(`无效目标 '${value}'，@ 未闭合`)
  }
  return parts.map(part =>
    part.length >= 2 && part.startsWith('@') && part.endsWith('@') ? part.slice(1, -1) : part,
  )
}

export function parseInteger(value: string, field: string, nonNegative = true): number {
  if (value === '') {
    throw new Error(`${field} 不能为空`)
  }
  if (nonNegative && value.startsWith('-')) {
    throw new Error(`${field} 必须是非负数: '${value}'`)
  }
  let base = 10
  let digits = value
  if (/^0[xX]/.test(value)) {
    base = 16
    digits = value.slice(2)
  } else if (/^0[bB]/.test(value)) {
    base = 2
    digits = value.slice(2)
  }
  if (digits === '' || !/^[0-9a-fA-F]+$/.test(digits)) {
    throw new Error(`${field} 含有非法字符: '${value}'`)
  }
  const parsed = Number.parseInt(digits, base)
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${field} 超出范围: '${value}'`)
  }
  if (nonNegative && parsed < 0) {
    throw new Error(`${field} 必须是非负数: '${value}'`)
  }
  return parsed
}

export function parseFloatValue(value: string, field: string): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    throw new Error(`${field} 不是有效数字: '${value}'`)
  }
  return parsed
}

export function parseAdapterSpec(value: string): AdapterSpec {
  const separator = value.indexOf(':')
  if (separator <= 0 || separator + 1 >= value.length) {
    throw new Error(`无效链路 '${value}'，期望 Type:Id`)
  }
  return { type: value.slice(0, separator), id: value.slice(separator + 1) }
}

export function parseMotorTarget(value: string): MotorTarget {
  const parts = splitColonSeparated(value)
  if (parts.length < 3 || parts.length > 5) {
    throw new Error(
      `无效目标 '${value}'，期望 Type:Id:ALL、Type:Id:BusId:ALL、Type:Id:BusId:MotorId、` +
        'Type:Id:SlaveId:BusId:ALL 或 Type:Id:SlaveId:BusId:MotorId',
    )
  }
  if (parts.some(part => part === '')) {
    throw new Error(`无效目标 '${value}'，各部分不能为空`)
  }
  const target: MotorTarget = {
    adapterType: parts[0],
    adapterId: parts[1],
    scope: 'motor',
  }
  if (parts.length === 3) {
    if (parts[2] !== 'ALL') {
      throw new Error(`无效目标 '${value}'，3 段目标只支持 Type:Id:ALL`)
    }
    target.scope = 'adapter'
    return target
  }
  if (parts.length === 4) {
    target.busId = parseInteger(parts[2], 'BusId')
    if (parts[3] === 'ALL') {
      target.scope = 'bus'
    } else {
      target.motorId = parseInteger(parts[3], 'MotorId')
    }
    return target
  }
  target.slaveId = parseInteger(parts[2], 'SlaveId')
  target.busId = parseInteger(parts[3], 'BusId')
  if (parts[4] === 'ALL') {
    target.scope = 'bus'
  } else {
    target.motorId = parseInteger(parts[4], 'MotorId')
  }
  return target
}

export function parseScanTarget(value: string): ScanTarget {
  const parts = splitColonSeparated(value)
  if (parts.length < 1 || parts.length > 4) {
    throw new Error(`无效扫描目标 '${value}'，期望 Type、Type:Id、Type:Id:BusId 或 Type:Id:SlaveId:BusId`)
  }
  if (parts.some(part => part === '')) {
    throw new Error(`无效扫描目标 '${value}'，各部分不能为空`)
  }
  const target: ScanTarget = { adapterType: parts[0] }
  if (parts.length >= 2) target.adapterId = parts[1]
  if (parts.length === 3) target.busId = parseInteger(parts[2], 'BusId')
  if (parts.length === 4) {
    target.slaveId = parseInteger(parts[2], 'SlaveId')
    target.busId = parseInteger(parts[3], 'BusId')
  }
  return target
}

export function parseMotorConnection(value: string): {
  adapterType: string
  adapterId: string
  slaveId?: number
  busId: number
  motorId: number
} {
  const parts = splitColonSeparated(value)
  if (parts.length !== 4 && parts.length !== 5) {
    throw new Error(
      `无效电机连接 '${value}'，期望 Type:Id:BusId:MotorId 或 Type:Id:SlaveId:BusId:MotorId`,
    )
  }
  const base = {
    adapterType: parts[0],
    adapterId: parts[1],
    busId: 0,
    motorId: 0,
  }
  if (parts.length === 4) {
    base.busId = parseInteger(parts[2], 'BusId')
    base.motorId = parseInteger(parts[3], 'MotorId')
    return base
  }
  return {
    adapterType: parts[0],
    adapterId: parts[1],
    slaveId: parseInteger(parts[2], 'SlaveId'),
    busId: parseInteger(parts[3], 'BusId'),
    motorId: parseInteger(parts[4], 'MotorId'),
  }
}

export function decodeAdapterBusId(rawIndex: number): {
  slaveId: number | null
  busId: number
} {
  if (rawIndex > 0xffff) {
    return { slaveId: Math.floor(rawIndex / 0x10000), busId: rawIndex & 0xffff }
  }
  return { slaveId: null, busId: rawIndex }
}

export function formatMotorPrefix(
  adapterType: string,
  adapterId: string,
  slaveId: number | null,
  busId: number,
  motorId: number,
): string {
  return `${adapterType}:${adapterId}:${slaveId === null ? '' : `${slaveId}:`}${busId}:${motorId}`
}

export function formatTargetPrefix(target: MotorTarget, slaveId: number | null, busId: number): string {
  const tail = target.scope === 'adapter' ? 'ALL' : `${slaveId === null ? '' : `${slaveId}:`}${busId}`
  return `${target.adapterType}:${target.adapterId}:${tail}`
}

export interface BusTarget {
  adapterType: string
  adapterId: string
  slaveId?: number
  busId: number
}

/** Type:Id:Bus 或 Type:Id:Slave:Bus。 */
export function parseBusTarget(value: string): BusTarget {
  const parts = splitColonSeparated(value)
  if (parts.length !== 3 && parts.length !== 4) {
    throw new Error(`无效总线目标 '${value}'，期望 Type:Id:Bus 或 Type:Id:Slave:Bus`)
  }
  if (parts.length === 3) {
    return {
      adapterType: parts[0],
      adapterId: parts[1],
      busId: parseInteger(parts[2], 'BusId'),
    }
  }
  return {
    adapterType: parts[0],
    adapterId: parts[1],
    slaveId: parseInteger(parts[2], 'SlaveId'),
    busId: parseInteger(parts[3], 'BusId'),
  }
}

export interface DeviceTarget extends BusTarget {
  index: number
}

/** Type:Id:Bus:Index 或 Type:Id:Slave:Bus:Index。 */
export function parseDeviceTarget(value: string): DeviceTarget {
  const parts = splitColonSeparated(value)
  if (parts.length !== 4 && parts.length !== 5) {
    throw new Error(`无效设备目标 '${value}'，期望 Type:Id:Bus:Index 或 Type:Id:Slave:Bus:Index`)
  }
  if (parts.length === 4) {
    return {
      adapterType: parts[0],
      adapterId: parts[1],
      busId: parseInteger(parts[2], 'BusId'),
      index: parseInteger(parts[3], 'Index'),
    }
  }
  return {
    adapterType: parts[0],
    adapterId: parts[1],
    slaveId: parseInteger(parts[2], 'SlaveId'),
    busId: parseInteger(parts[3], 'BusId'),
    index: parseInteger(parts[4], 'Index'),
  }
}

export interface GloveTarget {
  adapterType: string
  adapterId: string
  slaveId: number
}

/** Type:Id:Slave。 */
export function parseGloveTarget(value: string): GloveTarget {
  const parts = splitColonSeparated(value)
  if (parts.length !== 3) {
    throw new Error(`无效手套目标 '${value}'，期望 Type:Id:Slave`)
  }
  return {
    adapterType: parts[0],
    adapterId: parts[1],
    slaveId: parseInteger(parts[2], 'SlaveId'),
  }
}

/** Legacy IMU forwarding addresses may include an ignored device ID. */
export function parseImuControlTarget(value:string):BusTarget {
 const parts=splitColonSeparated(value)
 if(parts.length===4||parts.length===5){
  const target=parseDeviceTarget(value)
  return {adapterType:target.adapterType,adapterId:target.adapterId,busId:target.busId,...(target.slaveId===undefined?{}:{slaveId:target.slaveId})}
 }
 return parseBusTarget(value)
}
