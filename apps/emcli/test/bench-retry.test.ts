// SPDX-FileCopyrightText: 2026 Encos
// SPDX-License-Identifier: MIT

import assert from 'node:assert/strict'
import test from 'node:test'
import {openRuntime,createAdapter} from '../src/runtime.js'
import {loadEmcliNative} from '@encos/emcli-native'
import {BusWrapper,CanFrameFlag,FakeReplyMode,FakeCommandKind,MotorModel,MotorParameter} from '@encos/encos-driver-native'

test('bench counts unanswered reads once and restores ordinary parameter retries',{timeout:15000},async()=>{
 const runtime=await openRuntime()
 try{
  const adapter=await createAdapter(runtime,{type:'Fake',id:'bench-retries'})
  const motor=await adapter.getBus(0).getMotor(1),fake=adapter.getFakeAdapterControl()!
  fake.enableCommandRecording(true);fake.setReplyMode(FakeReplyMode.Manual)
  fake.clearCommandRecords()
  const result=loadEmcliNative().bench({motors:[{adapterType:'Fake',interfaceName:'bench-retries',busId:0,motorId:1}],periodMs:10,attempts:3,warmupMs:0,sampleGapMs:0,jitterUs:0})
  const reads=()=>fake.getCommandRecords().filter(r=>r.kind===FakeCommandKind.GetParameter).length
  assert.equal(result.attempts,3);assert.equal(result.lost,3);assert.equal(result.samples.length,0)
  assert.equal(reads(),3,'each lost sample must send only one parameter query')
  fake.clearCommandRecords()
  await assert.rejects(async()=>motor.getParameter(MotorParameter.Position))
  assert.equal(reads(),2,'ordinary reads must retain the driver default retry after bench')
 }finally{runtime.dispose()}
})

test('native stress accepts sub-millisecond periods without integer truncation',{timeout:15000},async()=>{
 const runtime=await openRuntime()
 const session=loadEmcliNative().stress({motors:[{adapterType:'Fake',interfaceName:'stress-frequency',busId:0,motorId:1}],periodMs:.5})
 try{
  session.start();await new Promise(resolve=>setTimeout(resolve,50))
  assert.ok(session.poll().sent>0)
  session.stop(0)
 }finally{session.dispose();runtime.dispose()}
})

const dexHandTestOptions = {
 timeout: 15000,
 skip: 'getDexHand' in BusWrapper.prototype ? false : 'Requires the native driver with DexHand support',
}

test('native bench drives a signed CAN FD child but probes only ordinary motors',dexHandTestOptions,async()=>{
 const runtime=await openRuntime()
 try{
  const interfaceName='bench-dexhand',adapter=await createAdapter(runtime,{type:'Fake',id:interfaceName})
  const bus=adapter.getBus(0),fake=adapter.getFakeAdapterControl()!
  const physicalId=11,slot=5,childId=physicalId|(slot<<29),slotOffset=(slot-1)*9
  await bus.getMotor(1)
  await bus.getMotor(childId,MotorModel.EC_A4310_P2,true)
  fake.enableCommandRecording(true)
  fake.clearCommandRecords()
  const native=loadEmcliNative()
  const target={adapterType:'Fake',interfaceName,busId:0}
  const child={...target,motorId:childId,canfd:true}
  const timing={periodMs:1,attempts:5,warmupMs:10,sampleGapMs:3,jitterUs:0}
  const reads=()=>fake.getCommandRecords().filter(r=>r.kind===FakeCommandKind.GetParameter)
  const childFrames=()=>fake.getRawMessageRecords().filter(r=>r.canId===physicalId&&(r.frameFlags&CanFrameFlag.FdMask)===CanFrameFlag.FdMask)
  const assertChildLoad=()=>{
   const frames=childFrames()
   assert.ok(frames.length>0,'bench must send CAN FD load to the child')
   assert.ok(frames.every(r=>r.data[slotOffset]===8),'all child traffic must be PVT control')
  }
  const mixed=native.bench({...timing,motors:[{...target,motorId:1},child]})
  assert.equal(mixed.error,'');assert.equal(mixed.attempts,5);assert.equal(mixed.probeMotorCount,1)
  assert.deepEqual(reads().map(r=>r.motorIndex),Array(5).fill(1))
  assert.ok(fake.getCommandRecords().some(r=>r.kind===FakeCommandKind.PVTControl&&r.motorIndex===1))
  assertChildLoad()
  fake.clearCommandRecords()
  const childOnly=native.bench({...timing,motors:[child]})
  assert.deepEqual(childOnly,{samples:[],attempts:0,lost:0,error:'',probeMotorCount:0})
  assert.deepEqual(reads(),[])
  assertChildLoad()
 }finally{runtime.dispose()}
})

test('native stress counts grouped PVT feedback under the signed child address',dexHandTestOptions,async()=>{
 const runtime=await openRuntime()
 try{
  const interfaceName='stress-dexhand',adapter=await createAdapter(runtime,{type:'Fake',id:interfaceName})
  const bus=adapter.getBus(0),fake=adapter.getFakeAdapterControl()!
  const physicalId=11,slot=5,childId=physicalId|(slot<<29),slotOffset=(slot-1)*9
  await bus.getMotor(childId,MotorModel.EC_A4310_P2,true)
  fake.enableCommandRecording(true)
  fake.clearCommandRecords()
  const native=loadEmcliNative()
  const session=native.stress({motors:[{adapterType:'Fake',interfaceName,busId:0,motorId:childId,canfd:true}],periodMs:1})
  try{
   session.start()
   const deadline=Date.now()+1000
   while(fake.getLastRawCommand()?.canId!==physicalId&&Date.now()<deadline){
    await new Promise(resolve=>setTimeout(resolve,5))
   }
   assert.equal(fake.getLastRawCommand()?.data[slotOffset],8)
   const reply=Array<number>(54).fill(0)
   reply[slotOffset]=8
   reply[slotOffset+1]=0x20
   fake.injectRawMessage(0,physicalId,reply,CanFrameFlag.FdMask)
   const snapshot=session.stop(0)
   assert.equal(snapshot.error,'');assert.equal(snapshot.motors.length,1)
   assert.equal(snapshot.motors[0].motorId,childId);assert.equal(snapshot.motors[0].received,1)
   assert.ok(snapshot.motors[0].sent>0)
  }finally{session.dispose()}
 }finally{runtime.dispose()}
})
