import assert from 'node:assert/strict'
import test from 'node:test'
import {discoverGloves} from '../src/studio/glove-discovery.js'
import {availableDeviceBuses,availableGloveSlaves,deviceTree} from '../src/studio/devices.js'
import type {AdapterInfo} from '../src/studio/protocol.js'
const adapter=():AdapterInfo=>({key:'a',type:'Ethercat',interfaceName:'eth0',motors:[],devices:[],buses:[...Array.from({length:5},(_,busId)=>({slaveId:null,busId})),...Array.from({length:8},(_,busId)=>({slaveId:1,busId})),...Array.from({length:5},(_,busId)=>({slaveId:2,busId}))]})
test('five-bus EtherCAT slaves are registered once before motor scan and hidden from scan targets',()=>{
 const info=adapter(),created:number[]=[]
 const found=discoverGloves(info,d=>created.push(d.slaveId!))
 assert.deepEqual(created,[0,2]);assert.ok(found.every(d=>d.origin==='scan'&&d.kind==='glove'))
 assert.deepEqual(discoverGloves(info,()=>assert.fail('duplicate handle')),[])
 assert.equal(availableDeviceBuses(info).length,8)
 assert.ok(availableDeviceBuses(info).every(b=>b.slaveId===1))
 assert.deepEqual(availableGloveSlaves(info),[1]) // Other eligible slaves still support manual Add Glove.
 assert.equal(deviceTree([info])[0].children![0].label,'Glove · Slave 0')
 assert.equal(deviceTree([info])[0].children![0].children,undefined)
})
test('detection preserves existing manual devices, only uses unique buses, and requires EtherCAT',()=>{
 const info=adapter()
 info.devices.push({key:'manual',adapterKey:'a',slaveId:2,busId:0,deviceId:1,kind:'imu',origin:'manual'})
 info.buses.push({slaveId:null,busId:0})
 assert.deepEqual(discoverGloves(info,()=>{}).map(d=>d.slaveId),[0])
 assert.ok(info.devices.some(d=>d.key==='manual'))
 const other=adapter();other.type='Fake'
 assert.deepEqual(discoverGloves(other,()=>assert.fail('wrong adapter')),[])
 const igh=adapter();igh.type='EthercatIGH'
 assert.equal(discoverGloves(igh,()=>{}).length,2)
})
test('failed native glove registration is not committed to device state',()=>{
 const info=adapter()
 assert.throws(()=>discoverGloves(info,()=>{throw new Error('native failure')}),/native failure/)
 assert.equal(info.devices.length,0)
})
