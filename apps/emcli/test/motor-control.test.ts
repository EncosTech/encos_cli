import assert from 'node:assert/strict'
import test from 'node:test'
import type {MotorWrapper} from '@encos/encos-driver-native'
import {MotorControlLoop} from '../src/studio/motor-control.js'
import type {Telemetry} from '../src/studio/protocol.js'
const wait=(ms=165)=>new Promise(resolve=>setTimeout(resolve,ms))
function fake(){
 let callback:((s:any)=>void)|null=null
 const calls:Array<{mode:string;value:any}>=[]
 const motor={getProperties:()=>({kt:2}),setOnStatus:(fn:typeof callback)=>{callback=fn},bus:{adapter:{commit(){throw new Error('Ordinary control must not commit')}}},...Object.fromEntries(['pvt','pos','spd','cur','tor'].map(mode=>[`${mode}Control`,async(value:any)=>{calls.push({mode,value});return {ok:true}}])),stop:async(value:any)=>{calls.push({mode:'stop',value});return {ok:true}}} as unknown as MotorWrapper
 return {motor,calls,feedback:()=>callback?.({position:Math.PI,speed:3,current:4,motorTemperature:25,mosTemperature:30,error:0}),callback:()=>callback}
}
test('control runs at 20Hz, snapshots Apply values, requests full asynchronous feedback and stops on motor selection',async()=>{
 const a=fake(),b=fake(),samples:Telemetry[]=[],errors:unknown[]=[]
 const loop=new MotorControlLoop(s=>samples.push(s),e=>errors.push(e))
 try{
  loop.select('a',a.motor);const values=[1,2,90,3,4];loop.apply({mode:'pvt',values});values[0]=99
  await wait();assert.ok(a.calls.length>=2&&a.calls.length<=4)
  assert.equal(samples.length,0)
  assert.deepEqual(a.calls[0].value,{kp:1,kd:2,position:Math.PI/2,speed:3,torque:4,feedbackType:0,feedback:1})
  a.feedback();assert.equal(samples[0].position,180);assert.equal(samples[0].power,24)
  const oldCallback=a.callback();loop.select('b',b.motor);const count=a.calls.length
  await wait();assert.equal(a.calls.length,count);assert.equal(b.calls.length,0);assert.equal(loop.command,undefined)
  oldCallback?.({position:0});assert.equal(samples.length,1);assert.deepEqual(errors,[])
 }finally{loop.dispose()}
})
test('Graph uses zero-gain PVT at 20Hz, leaving Graph stops only its own loop',async()=>{
 const a=fake(),loop=new MotorControlLoop(()=>{},error=>{throw error})
 try{
  loop.select('a',a.motor);loop.setGraphActive(true);await wait()
  assert.deepEqual(a.calls[0].value,{kp:0,kd:0,position:0,speed:0,torque:0,feedbackType:0,feedback:1})
  loop.setGraphActive(false);const stopped=a.calls.length;await wait();assert.equal(a.calls.length,stopped)
  loop.apply({mode:'current',values:[2]});loop.setGraphActive(true);loop.setGraphActive(false);await wait()
  assert.equal(a.calls.at(-1)?.mode,'cur');assert.equal(loop.command?.mode,'current')
  loop.disable();const disabled=a.calls.length;await wait();assert.equal(a.calls.length,disabled)
 }finally{loop.dispose()}
})

test('batch sends to checked motors only, reconciles selection, and stops every loop',async()=>{
 const {BatchControl}=await import('../src/studio/batch-control.js')
 const a=fake(),b=fake(),c=fake(),motors=new Map([['a',a.motor],['b',b.motor],['c',c.motor]])
 const batch=new BatchControl(key=>motors.get(key),()=>{},error=>{throw error},task=>task())
 try{
  batch.setSelection(['a','b']);batch.apply({mode:'current',values:[2]});await wait()
  assert.ok(a.calls.length>=2&&b.calls.length>=2);assert.equal(c.calls.length,0)
  batch.setSelection(['b','c']);const stopped=a.calls.length;await wait()
  assert.equal(a.calls.length,stopped);assert.ok(c.calls.length>=2)
  batch.stop();const counts=[a.calls.length,b.calls.length,c.calls.length];await wait()
  assert.deepEqual([a.calls.length,b.calls.length,c.calls.length],counts);assert.equal(batch.command,undefined)
  batch.setSelection([]);assert.throws(()=>batch.apply({mode:'current',values:[0]}),/at least one/)
  assert.throws(()=>batch.setSelection(['missing']),/no longer exists/)
 }finally{batch.stop()}
})

test('eight batch motors send at 20Hz without adapter commits',async()=>{
 const {BatchControl}=await import('../src/studio/batch-control.js')
 const motors=Array.from({length:8},()=>fake()),errors:unknown[]=[]
 let commits=0
 for(const item of motors)item.motor.bus.adapter={commit(){commits++}} as any
 const lookup=new Map(motors.map((item,i)=>[String(i),item.motor]))
 const batch=new BatchControl(key=>lookup.get(key),()=>{},(_key,error)=>errors.push(error),task=>task())
 try{
  batch.setSelection([...lookup.keys()]);batch.apply({mode:'pvt',values:[1,1,0,0,0]});await wait()
  assert.ok(motors.every(m=>m.calls.length>=2));assert.equal(commits,0);assert.deepEqual(errors,[])
 }finally{batch.stop()}
})
