// SPDX-FileCopyrightText: 2026 Encos
// SPDX-License-Identifier: MIT

import type {TreeNode} from '../tui/components/TreeList.js'
import type {AdapterInfo, DeviceKind, MotorAddress} from './protocol.js'

export const deviceLabel = (kind: DeviceKind) => ({motor:'Motor',imu:'IMU',battery:'Battery',pms:'PMS',glove:'Glove',dexhand:'DexHand'})[kind]
export const hexId = (id: number) => `0x${id.toString(16).toUpperCase().padStart(2,'0')}`
export const motorDisplayLabel = (motor: Pick<MotorAddress, 'motorId' | 'jointLabel'>) =>
 motor.jointLabel ?? `Motor ${motor.motorId} ${hexId(motor.motorId)}`
type MotorDisplayAddress = Pick<MotorAddress, 'motorId' | 'dexHandKey' | 'jointDisplayOrder'>
export function compareMotorDisplay(a: MotorDisplayAddress, b: MotorDisplayAddress) {
 if (a.dexHandKey !== b.dexHandKey)
  return (a.dexHandKey ?? '').localeCompare(b.dexHandKey ?? '')
 const tail = Number.MAX_SAFE_INTEGER
 return (a.jointDisplayOrder ?? tail) - (b.jointDisplayOrder ?? tail) || a.motorId - b.motorId
}
export const busKey = (bus: {slaveId:number|null;busId:number}) => JSON.stringify([bus.slaveId,bus.busId])
export const busLabel = (bus: {slaveId:number|null;busId:number}) => `Slave ${bus.slaveId ?? 0} Bus ${bus.busId}`
export function parseDeviceId(value: string, kind: DeviceKind) {
 const trimmed=value.trim(),id=Number(trimmed)
 const min = kind === 'motor' || kind === 'dexhand' ? 1 : 0
 const max = kind === 'dexhand' ? 247 : 2046
 if(!/^(?:0x[\da-f]+|\d+)$/i.test(trimmed)||!Number.isInteger(id)||id<min||id>max)
  throw new Error(`${kind === 'dexhand' ? 'Base ID' : 'Device ID'} must be ${min}–${max} (decimal or hexadecimal)`)
 return id
}
export const isEthercat = (type:string) => /^ethercat(?:igh)?$/i.test(type)
export const availableSlaves = (adapter:AdapterInfo) => isEthercat(adapter.type) ? [...new Set(adapter.buses.map(bus=>bus.slaveId??0))].sort((a,b)=>a-b) : []
export const availableDeviceBuses = (adapter:AdapterInfo) => adapter.buses.filter(bus=>!(adapter.devices??[]).some(d=>d.kind==='glove'&&d.slaveId===(bus.slaveId??0)))
export const availableGloveSlaves = (adapter:AdapterInfo) => availableSlaves(adapter).filter(slave=>
 !adapter.motors.some(m=>(m.slaveId??0)===slave)&&!(adapter.devices??[]).some(d=>(d.slaveId??0)===slave))
export function deviceTree(adapters:AdapterInfo[]):TreeNode[] {
 const motorNode = (motor: MotorAddress): TreeNode => ({
  id: motor.key, label: motorDisplayLabel(motor), kind: 'motor', badge: motor.canfd ? 'FD' : undefined,
 })
 return adapters.map(adapter=>{
  const gloves:TreeNode[]=(adapter.devices??[]).filter(d=>d.kind==='glove').sort((a,b)=>a.slaveId!-b.slaveId!).map(d=>({id:d.key,label:`Glove · Slave ${d.slaveId}`,kind:'glove'}))
  const buses:TreeNode[]=availableDeviceBuses(adapter).sort((a,b)=>(a.slaveId??-1)-(b.slaveId??-1)||a.busId-b.busId).map(bus=>({
   id:JSON.stringify({adapterKey:adapter.key,...bus}),label:busLabel(bus),kind:'bus' as const,children:[
    ...(adapter.devices??[]).filter(d=>d.kind!=='glove'&&d.busId===bus.busId&&d.slaveId===bus.slaveId).sort((a,b)=>['imu','pms','battery','dexhand'].indexOf(a.kind)-['imu','pms','battery','dexhand'].indexOf(b.kind)||a.deviceId-b.deviceId).map(d=>({
     id:d.key,label:`${deviceLabel(d.kind)} ${d.deviceId} ${hexId(d.deviceId)}`,kind:d.kind,
     ...(d.kind === 'dexhand' ? {children:adapter.motors.filter(m=>m.dexHandKey===d.key).sort(compareMotorDisplay).map(motorNode)} : {}),
    })),
    ...adapter.motors.filter(m=>m.busId===bus.busId&&m.slaveId===bus.slaveId&&!m.dexHandKey).sort((a,b)=>a.motorId-b.motorId).map(motorNode),
   ],
  }))
  const children=isEthercat(adapter.type)?availableSlaves(adapter).flatMap(slave=>{
   const glove=gloves.find(g=>(adapter.devices??[]).some(d=>d.key===g.id&&d.slaveId===slave))
   return glove?[glove]:[{id:JSON.stringify({adapterKey:adapter.key,slaveId:slave}),label:`Slave ${slave}`,kind:'slave' as const,children:buses.filter(b=>(JSON.parse(b.id).slaveId??0)===slave).map(b=>({...b,label:`Bus ${JSON.parse(b.id).busId}`}))}]
  }):buses
  return {id:adapter.key,label:`${adapter.type} · ${adapter.interfaceName}`,kind:'adapter',children}
 })
}
export function findNode(nodes:TreeNode[],id?:string):TreeNode|undefined {
 for(const node of nodes){if(node.id===id)return node;const found=findNode(node.children??[],id);if(found)return found}
}

export const busSelectionKey=(adapterKey:string,bus:{slaveId:number|null;busId:number})=>JSON.stringify([adapterKey,bus.slaveId,bus.busId])
export function busSelectionTree(adapters:AdapterInfo[]):import('../tui/components/TreeSelect.js').TreeSelectNode[]{
 return adapters.map(adapter=>{
  const buses=availableDeviceBuses(adapter),slaves=[...new Set(buses.map(b=>b.slaveId??0))].sort((a,b)=>a-b)
  return {value:JSON.stringify(['adapter',adapter.key]),label:`${adapter.type} · ${adapter.interfaceName}`,selectable:false,children:slaves.map(slave=>({value:JSON.stringify(['slave',adapter.key,slave]),label:`Slave ${slave}`,selectable:false,children:buses.filter(b=>(b.slaveId??0)===slave).sort((a,b)=>a.busId-b.busId).map(bus=>({value:busSelectionKey(adapter.key,bus),label:`Bus ${bus.busId}`}))}))}
 })
}

/** Keep transport ancestry while excluding auxiliary devices and empty branches. */
export function batchDeviceTree(adapters:AdapterInfo[]):TreeNode[]{
 const motorsOnly=(nodes:TreeNode[]):TreeNode[]=>nodes.flatMap(node=>{
  if(node.kind==='motor')return [node]
  const children=motorsOnly(node.children??[])
  return children.length?[{...node,children}]:[]
 })
 return motorsOnly(deviceTree(adapters))
}
