// SPDX-FileCopyrightText: 2026 Encos
// SPDX-License-Identifier: MIT

import assert from 'node:assert/strict'
import test from 'node:test'
import {stressTree,motorSelectionTree} from '../src/studio/ScopePanel.js'
import {batchMotorTree} from '../src/studio/BatchPanel.js'
import {deviceTree} from '../src/studio/devices.js'
import {dexHandJoints} from '../src/studio/dex-hand.js'
import type {PerformanceUpdate,AdapterInfo} from '../src/studio/protocol.js'
const update:Extract<PerformanceUpdate,{kind:'stress'}>={kind:'stress',scope:{adapterKey:'a'},running:true,snapshot:{sent:300,received:260,elapsedMs:100,measurementMs:100,drainMs:0,drainAdditional:0,outstandingBefore:40,outstandingAfter:40,error:'',final:false,motors:[{slaveId:1,busId:2,motorId:2,sent:100,received:90},{slaveId:1,busId:2,motorId:1,sent:100,received:80},{slaveId:2,busId:0,motorId:1,sent:100,received:90}]}}
test('stress aggregates adapter, slave and bus loss; motors are compact leaves',()=>{
 const tree=stressTree(update),root=tree[0]
 assert.equal(root.label,'Adapter  40/300 (13.33%)')
 assert.equal(root.children![0].label,'Slave 1  30/200 (15.00%)')
 const bus=root.children![0].children![0]
 assert.equal(bus.label,'Bus 2  30/200 (15.00%)')
 assert.equal(bus.children![0].label,'Motor 1 0x01  20/100 (20.00%)')
 assert.equal(bus.children![0].children,undefined)
 assert.equal(bus.children![1].children,undefined)
})
test('scope hides parent layers and zero traffic has a finite loss percentage',()=>{
 const slave={...update,scope:{adapterKey:'a',slaveId:1},snapshot:{...update.snapshot,motors:update.snapshot.motors.slice(0,2)}}
 assert.match(stressTree(slave)[0].label,/^Slave 1/)
 assert.match(stressTree({...slave,scope:{...slave.scope,busId:2}})[0].label,/^Bus 2/)
 const empty={...update,snapshot:{...update.snapshot,motors:[{slaveId:null,busId:0,motorId:1,sent:0,received:0}]}}
 assert.equal(stressTree(empty)[0].label,'Adapter  0/0 (0.00%)')
})


test('motor selector hides ancestor levels and includes only motors inside its scope',()=>{
 const adapter:AdapterInfo={key:'a',type:'Ethercat',interfaceName:'eth0',devices:[],buses:[{slaveId:0,busId:0},{slaveId:1,busId:0}],motors:[0,1].map(slaveId=>({key:`motor-${slaveId}`,adapterKey:'a',slaveId,busId:0,motorId:1,canfd:false,eff:false}))}
 const all=motorSelectionTree(adapter,{adapterKey:'a'})
 assert.equal(all[0].label,'Ethercat · eth0')
 assert.deepEqual(all[0].children!.map(n=>n.label),['Slave 0','Slave 1'])
 const slave=motorSelectionTree(adapter,{adapterKey:'a',slaveId:1})
 assert.equal(slave[0].label,'Slave 1');assert.equal(slave[0].selectable,true)
 const bus=motorSelectionTree(adapter,{adapterKey:'a',slaveId:1,busId:0})
 assert.equal(bus[0].label,'Bus 0')
 assert.deepEqual(bus[0].children,[{value:'motor-1',label:'Motor 1 0x01'}])
})

test('DexHand display groups joints by finger across the device, stress and batch lists', () => {
 const scope = { adapterKey: 'a', slaveId: 1, busId: 2, dexHandKey: 'hand' }
 const hand = { key: 'hand', adapterKey: 'a', slaveId: 1, busId: 2, deviceId: 1, kind: 'dexhand' as const, origin: 'manual' as const }
 const motors = dexHandJoints(1).map((joint) => ({ ...scope, ...joint, key: String(joint.motorId), canfd: true, eff: false }))
 const adapter: AdapterInfo = {
  key: 'a', type: 'Ethercat', interfaceName: 'eth0', devices: [hand],
  buses: [{ slaveId: 1, busId: 2 }], motors,
 }
 const expected = ['Thumb', 'Index', 'Middle', 'Ring', 'Little'].flatMap((finger) =>
  [1, 2, 3, 4].map((joint) => `${finger} ${joint}`))
 const [root] = deviceTree([adapter])
 assert.deepEqual(root.children![0].children![0].children![0].children!.map((motor) => motor.label), expected)
 assert.deepEqual(motorSelectionTree(adapter, scope).map((motor) => motor.label), expected)
 assert.deepEqual(motorSelectionTree(adapter, { ...scope, dexHandKey: undefined })[0].children!.map((motor) => motor.label), expected)
 const snapshot = { ...update.snapshot, motors: motors.map(({ motorId, slaveId, busId }) => ({ motorId, slaveId, busId, sent: 1, received: 1 })) }
 assert.deepEqual(stressTree({ ...update, scope, snapshot }, adapter)[0].children!.map((motor) => motor.label.split('  ')[0]), expected)
 const [batch] = batchMotorTree({ adapters: [adapter], graph: [] }, motors)
 assert.deepEqual(batch.children![0].children![0].children!.map((motor) => motor.label), expected)
})
