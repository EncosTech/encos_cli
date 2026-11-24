// SPDX-License-Identifier: MIT
import type {AdapterInfo,DeviceAddress} from './protocol.js'
import {availableGloveSlaves,isEthercat} from './devices.js'
/** Classify before motor discovery so encoder buses never receive motor probes. */
export function discoverGloves(adapter:AdapterInfo,create:(address:DeviceAddress)=>void):DeviceAddress[]{
 if(!isEthercat(adapter.type))return []
 const candidates=availableGloveSlaves(adapter).filter(slave=>new Set(adapter.buses.filter(b=>(b.slaveId??0)===slave).map(b=>b.busId)).size===5)
 const added:DeviceAddress[]=[]
 for(const slaveId of candidates){
  const address:DeviceAddress={key:JSON.stringify([adapter.key,'glove',slaveId]),adapterKey:adapter.key,slaveId,busId:null,deviceId:slaveId,kind:'glove',origin:'scan'}
  create(address)
  adapter.devices.push(address);added.push(address)
 }
 return added
}
