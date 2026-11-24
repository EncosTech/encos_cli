import assert from 'node:assert/strict'
import test from 'node:test'
import {Peripherals} from '../src/studio/peripherals.js'
import {timingEnvelope,validateTiming,TIMING_FIELDS} from '../src/studio/bus-timing.js'
import type {AdapterWrapper} from '@encos/encos-driver-native'
import type {DeviceAddress} from '../src/studio/protocol.js'

test('peripheral actions dispatch to their native handles with validated addresses and masks',async()=>{
 const calls:unknown[][]=[]
 const imuStatus={acceleration:{x:1,y:2,z:3}}
 const bus:any={adapter:{commit(){calls.push(['commit'])}},startImu(){calls.push(['start']);return true},stopImu(){return false}}
 bus.getImu=(id:number)=>{calls.push(['imu',id]);return {bus,getStatus:()=>imuStatus}}
 bus.getBattery=(id:number)=>({bus,getStatus:()=>({}),clearFault(){calls.push(['clear',id])},requestCharging(v:boolean){calls.push(['charge',v])},allowDischarge(v:boolean){calls.push(['discharge',v])},sendPassiveCommands(v:unknown){calls.push(['flags',v])}})
 bus.getPms=()=>({getStatus:()=>undefined,sendCommand(mask:number){calls.push(['pms',mask])}})
 let calibration=160
 const adapter={getBus(...args:number[]){calls.push(['bus',...args]);return bus},getGlove(slave:number){calls.push(['glove',slave]);return {getStatus:()=>undefined,async calibrateAll(){return calibration},async calibrateByMask(finger:number,mask:number){calls.push(['calibrate',finger,mask]);return calibration}}}} as unknown as AdapterWrapper
 const devices=new Peripherals()
 for(const kind of ['imu','battery','pms','glove'] as const)devices.add({key:kind,adapterKey:'a',kind,slaveId:0,busId:kind==='glove'?null:2,deviceId:5,origin:'manual'},adapter)
 assert.ok(calls.some(c=>JSON.stringify(c)===JSON.stringify(['bus',0,2])))
 assert.ok(calls.some(c=>JSON.stringify(c)===JSON.stringify(['glove',0])))
 assert.deepEqual(devices.sample('imu').status,imuStatus)
 await devices.action('imu',{kind:'imu',operation:'start'})
 await assert.rejects(devices.action('imu',{kind:'imu',operation:'stop'}),/rejected/)
 await assert.rejects(devices.action('imu',{kind:'battery',operation:'clear'}),/type/)
 await devices.action('battery',{kind:'battery',operation:'charge',enabled:true})
 assert.deepEqual(calls.at(-1),['charge',true]);assert.ok(!calls.some(call=>call[0]==='commit'))
 await devices.action('pms',{kind:'pms',operation:'channels',channels:[0,5,5],enabled:true})
 assert.deepEqual(calls.at(-1),['pms',256|(256<<5)])
 await assert.rejects(devices.action('pms',{kind:'pms',operation:'channels',channels:[6],enabled:true}),/channels/)
 await devices.action('glove',{kind:'glove',operation:'mask',finger:4,mask:512})
 assert.deepEqual(calls.at(-1),['calibrate',4,512])
 await assert.rejects(devices.action('glove',{kind:'glove',operation:'mask',finger:5,mask:1}),/Finger/)
 calibration=0
 await assert.rejects(devices.action('glove',{kind:'glove',operation:'all'}),/timed out/)
 devices.forget(['imu']);assert.throws(()=>devices.sample('imu'),/no longer exists/)
})
test('timing validates values and scopes updates to the selected slave and bus',()=>{
 assert.equal(timingEnvelope(0,3,{bitrate:1000000,dbitrate:5000000,sample_point:.875,dsample_point:.8}),'{"buses":{"0:3":{"bitrate":1000000,"dbitrate":5000000,"sample_point":0.875,"dsample_point":0.8}}}')
 for(const timing of [{bitrate:-1},{dbitrate:1.5},{sample_point:0},{dsample_point:1.1},{bitrate:NaN}])assert.throws(()=>validateTiming(timing),/Invalid/)
 assert.throws(()=>validateTiming({},true),/Choose/)
})

test('both arbitration and data sample presets include 88.2 percent',()=>{
 for(const field of TIMING_FIELDS.filter(f=>!f.rate))assert.ok((field.values as readonly number[]).includes(.882))
})
