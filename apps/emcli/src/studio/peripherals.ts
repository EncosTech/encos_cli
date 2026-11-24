// SPDX-License-Identifier: MIT
import {GloveCalibrationStatus, PmsCommand, type AdapterWrapper, type Runtime, type ImuWrapper, type BatteryWrapper, type PmsWrapper, type GloveWrapper} from '@encos/encos-driver-native'
import type {DeviceAddress,DeviceAction,DeviceSample} from './protocol.js'
type DeviceHandle = {kind:'imu';handle:ImuWrapper}|{kind:'battery';handle:BatteryWrapper}|{kind:'pms';handle:PmsWrapper}|{kind:'glove';handle:GloveWrapper}
export class Peripherals {
 private handles=new Map<string,DeviceHandle>()
 add(address:DeviceAddress,adapter:AdapterWrapper){
  if(address.kind==='glove')this.handles.set(address.key,{kind:'glove',handle:adapter.getGlove(address.slaveId!)})
  else{
   const bus=address.slaveId===null?adapter.getBus(address.busId!):adapter.getBus(address.slaveId,address.busId!)
   if(address.kind==='imu')this.handles.set(address.key,{kind:'imu',handle:bus.getImu(address.deviceId)})
   if(address.kind==='battery')this.handles.set(address.key,{kind:'battery',handle:bus.getBattery(address.deviceId)})
   if(address.kind==='pms')this.handles.set(address.key,{kind:'pms',handle:bus.getPms()})
  }
 }
 has(key:string){return this.handles.has(key)}
 sample(key:string):DeviceSample {
  const device=this.get(key),base={deviceKey:key,timestamp:Date.now()}
  switch(device.kind){
   case 'imu':return {...base,kind:'imu',status:device.handle.getStatus()}
   case 'battery':return {...base,kind:'battery',status:device.handle.getStatus()}
   case 'pms':return {...base,kind:'pms',status:device.handle.getStatus()}
   case 'glove':return {...base,kind:'glove',status:device.handle.getStatus()}
  }
 }
 async action(key:string,action:DeviceAction){
  const device=this.get(key)
  if(device.kind!==action.kind)throw new Error('Operation does not match the device type')
  if(device.kind==='imu'&&action.kind==='imu'){
   if(action.operation!=='start'&&action.operation!=='stop')throw new Error('Unknown IMU operation')
   if(!(action.operation==='start'?device.handle.bus.startImu():device.handle.bus.stopImu()))throw new Error('Driver rejected the IMU command')
  }else if(device.kind==='battery'&&action.kind==='battery'){
   if(action.operation==='clear')device.handle.clearFault()
   else if(action.operation==='commands'){
    const names=['allowShutdown','allowDischarge','parallelDischarge','forceShutdown','requestCharging','faultShutdownBroadcast','configureFaultThresholds','clearFault','factoryMode','debug']
    if(!action.commands||Object.entries(action.commands).some(([key,value])=>!names.includes(key)||typeof value!=='boolean'))throw new Error('Invalid battery command flags')
    device.handle.sendPassiveCommands(action.commands)
   }else{
    if(typeof action.enabled!=='boolean')throw new Error('Choose enabled or disabled')
    if(action.operation==='charge')device.handle.requestCharging(action.enabled)
    else if(action.operation==='discharge')device.handle.allowDischarge(action.enabled)
    else throw new Error('Unknown battery operation')
   }
  }else if(device.kind==='pms'&&action.kind==='pms'){
   if(action.operation!=='channels'||typeof action.enabled!=='boolean'||!Array.isArray(action.channels)||!action.channels.length||action.channels.some(c=>!Number.isInteger(c)||c<0||c>5))throw new Error('Select PMS channels 1–6')
   const mask=[...new Set(action.channels)].reduce((mask,c)=>mask|((action.enabled?PmsCommand.EnableChannel1:PmsCommand.DisableChannel1)<<c),0)
   device.handle.sendCommand(mask)
  }else if(device.kind==='glove'&&action.kind==='glove'){
   if(action.operation!=='all'&&action.operation!=='mask')throw new Error('Unknown calibration operation')
   if(action.operation==='mask'&&(!Number.isInteger(action.finger)||action.finger<0||action.finger>4||!Number.isInteger(action.mask)||action.mask<1||action.mask>1023))throw new Error('Finger must be 0–4; encoder mask must be 1–1023')
   const status=action.operation==='all'?await device.handle.calibrateAll():await device.handle.calibrateByMask(action.finger,action.mask)
   if(status!==GloveCalibrationStatus.Success)throw new Error(status===GloveCalibrationStatus.Timeout?'Calibration timed out':status===GloveCalibrationStatus.Limited?'Calibration failed: current limited':'Calibration failed')
   return 'Calibration succeeded'
  }
  return 'Command submitted'
 }
 remove(key:string,runtime:Runtime){
  const device=this.handles.get(key);if(!device)return
  const removed=device.kind==='imu'?runtime.deleteImu(device.handle):device.kind==='battery'?runtime.deleteBattery(device.handle):device.kind==='pms'?runtime.deletePms(device.handle):runtime.deleteGlove(device.handle)
  if(!removed)throw new Error('Could not delete device')
  this.handles.delete(key)
 }
 forget(keys:string[]){for(const key of keys)this.handles.delete(key)}
 private get(key:string){const handle=this.handles.get(key);if(!handle)throw new Error('Device no longer exists');return handle}
}
