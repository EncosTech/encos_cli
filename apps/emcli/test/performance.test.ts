// SPDX-FileCopyrightText: 2026 Encos
// SPDX-License-Identifier: MIT

import assert from 'node:assert/strict'
import test from 'node:test'
import {Performance,scopedMotors,testMotors,testScopeKey} from '../src/studio/performance.js'
import type {AdapterInfo,Event} from '../src/studio/protocol.js'
import type {EmcliNativeApi,NativeStressUpdate} from '@encos/emcli-native'
const adapter:AdapterInfo={key:'a',type:'Ethercat',interfaceName:'eth0',devices:[],buses:[{slaveId:0,busId:0},{slaveId:0,busId:1},{slaveId:1,busId:0}],motors:[0,1,2].map((id)=>({key:String(id),adapterKey:'a',slaveId:id===2?1:0,busId:id===1?1:0,motorId:id+1,canfd:false,eff:false}))}
test('performance targets only the selected bus or slave and excludes glove slaves',()=>{
 assert.deepEqual(testMotors(adapter,{adapterKey:'a',slaveId:0,busId:1}).map(m=>m.motorId),[2])
 assert.deepEqual(testMotors(adapter,{adapterKey:'a',slaveId:0}).map(m=>m.motorId),[1,2])
 assert.throws(()=>testMotors(adapter,{adapterKey:'a',slaveId:4}),/no longer exists/)
 assert.throws(()=>testMotors({...adapter,motors:[]},{adapterKey:'a',slaveId:0}),/No motors/)
 assert.throws(()=>testMotors({...adapter,devices:[{key:'g',adapterKey:'a',slaveId:0,busId:null,deviceId:0,kind:'glove',origin:'manual'}]},{adapterKey:'a',slaveId:0}),/Glove/)
})
test('bench publishes incremental statistics and stops at loss threshold',()=>{
 const events:Event[]=[];let calls=0
 const native={bench(){calls++;return {samples:[100,200,300],attempts:500,lost:calls===2?100:0,error:''}}} as unknown as EmcliNativeApi
 const performance=new Performance(()=>native,e=>events.push(e))
 const result=performance.bench(adapter,{adapterKey:'a',slaveId:0})
 assert.equal(result.kind,'bench')
 if(result.kind!=='bench')throw new Error('Unexpected result')
 assert.equal(result.rows.length,2);assert.equal(result.rows[0].p50Us,200);assert.equal(result.rows[1].status,'Loss limit');assert.equal(result.running,false)
 assert.equal(events.length,4)
})
test('stress starts once, polls, drains, and disposes on stop',()=>{
 const events:Event[]=[];let disposed=0,drain=-1
 const snapshot:NativeStressUpdate={sent:10,received:9,elapsedMs:100,measurementMs:100,drainMs:0,drainAdditional:0,outstandingBefore:1,outstandingAfter:1,motors:[],error:'',final:false}
 const native={stress(){return {start(){},poll(){return snapshot},stop(ms:number){drain=ms;return {...snapshot,received:10,final:true}},dispose(){disposed++}}}} as unknown as EmcliNativeApi
 const performance=new Performance(()=>native,e=>events.push(e)),scope={adapterKey:'a',slaveId:0}
 performance.start(adapter,scope);assert.equal(performance.running,true)
 assert.throws(()=>performance.start(adapter,scope),/already running/)
 performance.poll();performance.stop();performance.stop()
 assert.equal(drain,200);assert.equal(disposed,1);assert.equal(performance.running,false)
 const last=events.at(-1);assert.ok(last?.type==='performance'&&!last.update.running)
})
test('stress poll failure stops and disposes even when draining also fails',()=>{
 const events:Event[]=[];let polls=0,disposed=0
 const native={stress(){return {start(){},poll(){if(++polls>1)throw new Error('poll failed');return {error:''}},stop(){throw new Error('drain failed')},dispose(){disposed++}}}} as unknown as EmcliNativeApi
 const performance=new Performance(()=>native,e=>events.push(e))
 performance.start(adapter,{adapterKey:'a',slaveId:0})
 assert.doesNotThrow(()=>performance.poll());assert.equal(performance.running,false);assert.equal(disposed,1)
 assert.ok(events.some(e=>e.type==='log'&&e.message.includes('poll failed')))
})

test('adapter tests include all regular slaves and use a distinct result key',()=>{
 assert.deepEqual(testMotors(adapter,{adapterKey:'a'}).map(m=>m.motorId),[1,2,3])
 const withGlove={...adapter,devices:[{key:'g',adapterKey:'a',slaveId:1,busId:null,deviceId:1,kind:'glove' as const,origin:'manual' as const}]}
 assert.deepEqual(testMotors(withGlove,{adapterKey:'a'}).map(m=>m.motorId),[1,2])
 assert.notEqual(testScopeKey({adapterKey:'a'}),testScopeKey({adapterKey:'a',slaveId:null}))
 assert.throws(()=>testMotors(adapter,{adapterKey:'a',busId:1}),/slave address/)
})

test('explicit motor selection reaches native bench and stress, and rejects empty or stale selections',()=>{
 const calls:number[][]=[]
 const native={bench(options:{motors:Array<{motorId:number}>}){calls.push(options.motors.map(m=>m.motorId));return {samples:[100],attempts:500,lost:0,error:''}},stress(options:{motors:Array<{motorId:number}>}){calls.push(options.motors.map(m=>m.motorId));return {start(){},poll(){return {error:''}},stop(){return {error:''}},dispose(){}}}} as unknown as EmcliNativeApi
 const performance=new Performance(()=>native,()=>{})
 performance.bench(adapter,{adapterKey:'a'},['1'])
 assert.equal(calls.length,5);assert.ok(calls.every(ids=>ids.length===1&&ids[0]===2))
 performance.start(adapter,{adapterKey:'a'},['0','2']);assert.deepEqual(calls.at(-1),[1,3]);performance.stop()
 assert.throws(()=>performance.start(adapter,{adapterKey:'a'},[]),/No motors/)
 assert.throws(()=>performance.bench(adapter,{adapterKey:'a',slaveId:0},['2']),/no longer exists/)
 assert.throws(()=>performance.start(adapter,{adapterKey:'a'},['missing']),/no longer exists/)
 assert.equal(calls.length,6)
})

test('stress converts frequency to a fractional period, defaults to 1000 Hz and rejects invalid input',()=>{
 const periods:number[]=[]
 const native={stress(options:{periodMs:number}){periods.push(options.periodMs);return {start(){},poll(){return {error:''}},stop(){return {error:''}},dispose(){}}}} as unknown as EmcliNativeApi
 const performance=new Performance(()=>native,()=>{}),scope={adapterKey:'a'}
 for(const hz of [undefined,250,750,2000]){performance.start(adapter,scope,undefined,hz);performance.stop()}
 assert.deepEqual(periods,[1,4,1000/750,.5])
 for(const hz of [0,-1,NaN,Infinity])assert.throws(()=>performance.start(adapter,scope,undefined,hz),/Frequency/)
 assert.equal(periods.length,4)
})

const handChildren = (dexHandKey: string, baseId: number) => Array.from({length:20}, (_, i) => ({
 key:`${dexHandKey}:${i}`,adapterKey:'a',slaveId:0,busId:0,
 motorId:(baseId+Math.floor(i/7))|((i%7+1)<<29),canfd:true,eff:false,dexHandKey,
}))
const hand = handChildren('hand',11), otherHand = handChildren('other-hand',17)
const withHands: AdapterInfo = {...adapter,motors:[...adapter.motors,...hand,...otherHand]}
const handScope = {adapterKey:'a',slaveId:0,busId:0,dexHandKey:'hand'}

test('DexHand stress addresses only its own children, including signed CAN FD addresses',()=>{
 const address = {...handScope,dexHandKey:undefined}
 assert.notEqual(testScopeKey(handScope),testScopeKey(address))
 assert.notEqual(testScopeKey(handScope),testScopeKey({...handScope,dexHandKey:'other-hand'}))
 assert.deepEqual(scopedMotors(withHands,handScope),hand)
 assert.equal(scopedMotors(withHands,{adapterKey:'a'}).length,43)
 assert.equal(scopedMotors(withHands,{adapterKey:'a',slaveId:0}).length,42)
 assert.equal(scopedMotors(withHands,address).length,41)
 const native={stress(options:{motors:ReturnType<typeof testMotors>}){
  assert.deepEqual(options.motors.map(m=>m.motorId),hand.map(m=>m.motorId))
  assert.ok(options.motors.every(m=>m.canfd))
  assert.ok(options.motors.some(m=>m.motorId<0))
  return {start(){},poll(){return {error:''}},stop(){return {error:''}},dispose(){}}
 }} as unknown as EmcliNativeApi
 const performance=new Performance(()=>native,()=>{})
 performance.start(withHands,handScope)
 performance.stop()
 assert.throws(()=>performance.start(withHands,handScope,[otherHand[0].key]),/no longer exists/)
})

test('Studio bench rejects a direct DexHand scope and reports child-only upstream load without probes',()=>{
 let calls=0
 const native={bench(options:{motors:ReturnType<typeof testMotors>}){
  calls++
  if(options.motors.some(m=>m.motorId===1)){
   assert.deepEqual(options.motors.map(m=>m.motorId),[1,...hand.map(m=>m.motorId),...otherHand.map(m=>m.motorId)])
   return {samples:[100],attempts:1,lost:0,error:'',probeMotorCount:1}
  }
  assert.deepEqual(options.motors.map(m=>m.motorId),hand.map(m=>m.motorId))
  return {samples:[],attempts:0,lost:0,error:'',probeMotorCount:0}
 }} as unknown as EmcliNativeApi
 const performance=new Performance(()=>native,()=>{})
 assert.throws(()=>performance.bench(withHands,handScope),/DexHand/)
 assert.equal(calls,0)
 const busScope = {adapterKey:'a',slaveId:0,busId:0}
 const mixed = performance.bench(withHands,busScope)
 if(mixed.kind!=='bench')throw new Error('Unexpected result')
 assert.ok(mixed.rows.every(r=>r.status==='OK'&&r.attempts===1))
 const childOnly = performance.bench(withHands,busScope,hand.map(m=>m.key))
 if(childOnly.kind!=='bench')throw new Error('Unexpected result')
 assert.equal(childOnly.rows.length,5)
 assert.ok(childOnly.rows.every(r=>r.status==='No probes'&&r.attempts===0&&Number.isNaN(r.meanUs)))
})
