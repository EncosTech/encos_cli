import assert from 'node:assert/strict'
import test from 'node:test'
import {deviceTree,batchDeviceTree,parseDeviceId,busLabel,availableGloveSlaves,availableDeviceBuses,busSelectionTree,busSelectionKey} from '../src/studio/devices.js'
import type {AdapterInfo} from '../src/studio/protocol.js'

test('tree sorts buses and places auxiliary devices before compact motor labels',()=>{
 const adapter:AdapterInfo={key:'a',type:'Ethercat',interfaceName:'enx123456789',buses:[{slaveId:2,busId:7},{slaveId:1,busId:0}],motors:[{key:'m',adapterKey:'a',slaveId:2,busId:7,motorId:57,canfd:false,eff:false}],devices:[{key:'i',adapterKey:'a',slaveId:2,busId:7,deviceId:0,kind:'imu',origin:'manual'}]}
 const [root]=deviceTree([adapter])
 assert.equal(root.badge,undefined);assert.equal(root.status,undefined)
 assert.equal(root.label,'Ethercat · enx123456789')
 assert.deepEqual(root.children!.map(bus=>bus.label),['Slave 1','Slave 2'])
 assert.deepEqual(root.children![1].children![0].children!.map(node=>node.label),['IMU 0 0x00','Motor 57 0x39'])
 assert.equal(root.children![1].children![0].children![1].status,undefined)
})
test('manual device IDs accept decimal and hex and reject malformed addresses',()=>{
 assert.equal(parseDeviceId('0x39','motor'),57)
 assert.equal(parseDeviceId('57','motor'),57)
 assert.equal(parseDeviceId('0','imu'),0)
 for(const value of ['','-1','0','1.2','1e2','2047'])assert.throws(()=>parseDeviceId(value,'motor'),/Device ID/)
})

test('zero and unencoded slave addresses display Slave 0',()=>{
 assert.equal(busLabel({slaveId:0,busId:7}),'Slave 0 Bus 7')
 assert.equal(busLabel({slaveId:null,busId:7}),'Slave 0 Bus 7')
})

 test('empty buses remain available for devices but occupied slaves cannot host gloves',()=>{
 const adapter:AdapterInfo={key:'a',type:'Ethercat',interfaceName:'eth0',buses:[{slaveId:null,busId:0},{slaveId:1,busId:0},{slaveId:1,busId:1},{slaveId:2,busId:0},{slaveId:3,busId:0}],motors:[{key:'m',adapterKey:'a',slaveId:1,busId:1,motorId:1,canfd:false,eff:false}],devices:[{key:'i',adapterKey:'a',slaveId:2,busId:0,deviceId:1,kind:'imu',origin:'manual'}]}
 assert.deepEqual(availableGloveSlaves(adapter),[0,3])
 assert.equal(availableDeviceBuses(adapter).length,5)
 assert.equal(deviceTree([adapter])[0].children!.length,4)
 adapter.devices.push({key:'g',adapterKey:'a',slaveId:0,busId:null,deviceId:0,kind:'glove',origin:'manual'})
 assert.deepEqual(availableGloveSlaves(adapter),[3])
 assert.equal(availableDeviceBuses(adapter).length,4)
 assert.equal(deviceTree([adapter])[0].children![0].label,'Glove · Slave 0')
 assert.equal(deviceTree([adapter])[0].children![0].children,undefined)
 assert.equal(deviceTree([adapter])[0].children!.length,4)
 assert.deepEqual(availableGloveSlaves({...adapter,type:'Fake'}),[])
 })


test('bus selector keeps adapter/slave addresses distinct and excludes glove slaves',()=>{
 const a:AdapterInfo={key:'a',type:'Ethercat',interfaceName:'eth0',buses:[{slaveId:2,busId:0},{slaveId:null,busId:0},{slaveId:1,busId:0}],motors:[],devices:[{key:'g',adapterKey:'a',slaveId:1,busId:null,deviceId:0,kind:'glove',origin:'manual'}]}
 const b:AdapterInfo={...a,key:'b',interfaceName:'eth1',devices:[]}
 const tree=busSelectionTree([a,b])
 assert.equal(tree[0].selectable,false)
 assert.deepEqual(tree[0].children!.map(n=>n.label),['Slave 0','Slave 2'])
 assert.ok(tree[0].children!.every(n=>n.selectable===false))
 const leaves=tree.flatMap(n=>n.children!.flatMap(s=>s.children!))
 assert.equal(new Set(leaves.map(n=>n.value)).size,5)
 assert.equal(tree[0].children![0].children![0].value,busSelectionKey('a',{slaveId:null,busId:0}))
 assert.equal(tree[1].children![1].children![0].value,busSelectionKey('b',{slaveId:1,busId:0}))
})


test('Batch retains adapter/slave/bus ancestry and motor identity without auxiliary or empty branches',()=>{
 const adapter:AdapterInfo={key:'a',type:'Ethercat',interfaceName:'eth0',buses:[{slaveId:0,busId:1},{slaveId:1,busId:0}],motors:[{key:'m',adapterKey:'a',slaveId:0,busId:1,motorId:1,canfd:true,eff:false}],devices:[{key:'imu',adapterKey:'a',slaveId:0,busId:1,deviceId:1,kind:'imu',origin:'manual'}]}
 const tree=batchDeviceTree([adapter,{...adapter,key:'empty',motors:[]}])
 assert.equal(tree.length,1);assert.equal(tree[0].label,'Ethercat · eth0')
 assert.deepEqual(tree[0].children!.map(n=>n.label),['Slave 0'])
 const bus=tree[0].children![0].children![0]
 assert.equal(bus.label,'Bus 1');assert.equal(bus.children!.length,1)
 assert.equal(bus.children![0].id,'m');assert.equal(bus.children![0].label,'Motor 1 0x01');assert.equal(bus.children![0].badge,'FD')
 assert.equal(adapter.devices.length,1);assert.equal(deviceTree([adapter])[0].children!.length,2)
})
