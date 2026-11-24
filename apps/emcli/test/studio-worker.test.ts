import assert from 'node:assert/strict'
import test from 'node:test'
import {fork} from 'node:child_process'
import {connectWorker} from '../src/studio/client.js'
import {createLogStore} from '../src/tui/log-store.js'
import type {Interfaces,SessionState,Telemetry,DeviceSample} from '../src/studio/protocol.js'

test('native Fake session scans, controls, configures, switches targets and shuts down over isolated IPC', {timeout:40000},async()=>{
 const logs=createLogStore({flushIntervalMs:0})
 const worker=fork(new URL('../src/studio/driver-worker.ts',import.meta.url),[],{stdio:['ignore','pipe','pipe','ipc'],execArgv:['--import','tsx'],env:{...process.env,EMCLI_STUDIO_OPTIONS:JSON.stringify({demo:true})}})
 const client=connectWorker(worker,logs)
 try{
  const interfaces=await client.request<Interfaces>({type:'interfaces'});assert.ok(interfaces.types.some(item=>item.type==='Fake'))
  const state=await client.request<SessionState>({type:'add',adapterType:'Fake',interfaceName:'studio-test'})
  assert.equal(state.adapters[0].motors.length,8)
  assert.ok(state.adapters[0].motors[0].properties?.position)
  assert.deepEqual(state.graph,['position','speed','current','power'])
  const first=state.adapters[0].motors[0].key,second=state.adapters[0].motors[1].key
  await client.request({type:'select',motorKey:first})
  const ranges=await client.request<Record<string,number[]>>({type:'ranges'});assert.equal(Object.keys(ranges).length,6)
  await client.request({type:'write',item:'position',values:['12.5'],expectedMotor:first})
  assert.ok(Math.abs(Number(await client.request({type:'read',item:'position'}))-12.5)<.001)
  await client.request({type:'write',item:'can-timeout',values:['500']})
  assert.equal(Number(await client.request({type:'read',item:'can-timeout'})),500)
  await assert.rejects(client.request({type:'write',item:'pvt-kp-range',values:['5','1']}),/Minimum/)
  await assert.rejects(client.request({type:'write',item:'id',values:['2']}),/already exists/)
  let sample:Telemetry|undefined
  const unsubscribe=client.subscribe(event=>{if(event.type==='telemetry')sample=event.sample})
  await client.request({type:'graph',metrics:['position','speed','current','power']})
  await client.request({type:'control',mode:'position',values:[25,1,1]})
  await new Promise(resolve=>setTimeout(resolve,700))
  assert.ok(sample&&Math.abs(sample.position!-25)<.02);assert.equal(typeof sample.power,'number')
  const switched=await client.request<SessionState>({type:'select',motorKey:second});assert.equal(switched.control,undefined)
  await assert.rejects(client.request({type:'write',item:'position',values:['99'],expectedMotor:first}),/selected motor changed/)
  for(const [mode,values] of [['pvt',[1,1,0,0,0]],['speed',[0,1]],['current',[0]],['torque',[0]],['stop',[0]]] as const){
   const result=await client.request<SessionState>({type:'control',mode,values:[...values],stopMode:'full'});assert.equal(result.control,mode)
   await new Promise(resolve=>setTimeout(resolve,150))
  }
  await client.request({type:'disable'})
  for(const [item,values] of [
   ['pvt-kp-range',['0','400']],['pvt-kd-range',['0','4']],['pvt-pos-range',['-10','10']],
   ['pvt-spd-range',['-20','20']],['pvt-tor-range',['-5','5']],['pvt-cur-range',['-5','5']],
   ['cur-pi',['0.1','0.2']],['spd-pi',['0.1','0.2']],['pos-pd',['0.1','0.2']],
  ] as const){
   await client.request({type:'write',item,values:[...values]})
   const readback=String(await client.request({type:'read',item})).split(/\s+/).map(Number)
   assert.equal(readback.length,values.length);readback.forEach((value,i)=>assert.ok(Math.abs(value-Number(values[i]))<.0001,`${item}: ${value}`))
  }
  await client.request({type:'write',item:'position',values:[]})
  assert.ok(Math.abs(Number(await client.request({type:'read',item:'position'})))<.001)
  const fd=await client.request<SessionState>({type:'canfd',enabled:true});assert.equal(fd.adapters[0].motors[1].canfd,true)
  await client.request({type:'canfd',enabled:false})
  await client.request({type:'brake',engaged:true});await client.request({type:'brake',engaged:false})
  // Driver 4.1.2 Fake ACKs SetId but does not migrate the simulated device.
  // Verify the application's address/state transition without pretending post-ID reads work.
  let renamed:SessionState|undefined
  const stopState=client.subscribe(event=>{if(event.type==='state')renamed=event.state})
  await client.request({type:'write',item:'id',values:['9']})
  assert.ok(renamed?.adapters[0].motors.some(motor=>motor.motorId===9&&motor.key===renamed?.selected));stopState()
  const removed=await client.request<SessionState>({type:'remove',adapterKey:state.adapters[0].key});assert.equal(removed.adapters.length,0);assert.equal(removed.selected,undefined)
  assert.ok(logs.getSnapshot().some(entry=>entry.message.includes('Scan complete')))
  unsubscribe()
 }finally{await client.close();logs.dispose()}
})

test('device registry preserves manual entries on rescan and deletes individual devices', {timeout:40000},async()=>{
 const logs=createLogStore({flushIntervalMs:0})
 const worker=fork(new URL('../src/studio/driver-worker.ts',import.meta.url),[],{stdio:['ignore','pipe','pipe','ipc'],execArgv:['--import','tsx'],env:{...process.env,EMCLI_STUDIO_OPTIONS:JSON.stringify({demo:true})}})
 const client=connectWorker(worker,logs)
 try {
  const initial=await client.request<SessionState>({type:'add',adapterType:'Fake',interfaceName:'device-test'})
  const adapterKey=initial.adapters[0].key
  const add={type:'add-device',adapterKey,slaveId:null,busId:0,deviceId:1} as const
  const manual=await client.request<SessionState>({...add,kind:'motor'})
  assert.equal(manual.adapters[0].motors.find(m=>m.motorId===1)?.origin,'manual')
  const eighth=initial.adapters[0].motors.find(m=>m.motorId===8)!
  await client.request({type:'remove-device',deviceKey:eighth.key})
  const created=await client.request<SessionState>({...add,kind:'motor',deviceId:8})
  assert.equal(created.adapters[0].motors.find(m=>m.motorId===8)?.origin,'manual')
  for(const kind of ['imu','battery','pms'] as const) await client.request({...add,kind})
  await assert.rejects(client.request({...add,kind:'imu'}),/already exists/)
  const withDevices=await client.request<SessionState>({type:'select'})
  const imuKey=withDevices.adapters[0].devices.find(d=>d.kind==='imu')!.key
  let peripheral:DeviceSample|undefined
  const stopPeripheral=client.subscribe(event=>{if(event.type==='device-status')peripheral=event.sample})
  await client.request({type:'select',deviceKey:imuKey})
  await new Promise(resolve=>setTimeout(resolve,450))
  assert.equal(peripheral?.deviceKey,imuKey);assert.equal(peripheral?.kind,'imu');stopPeripheral()
  await assert.rejects(client.request({type:'add-glove',adapterKey,slaveId:0}),/EtherCAT/)
  await assert.rejects(client.request({...add,kind:'pms',deviceId:2}),/one PMS/)
  await assert.rejects(client.request({type:'bus-timing',adapterKey,slaveId:null,busId:0,timing:{bitrate:1000000}}),/does not support/)

  await assert.rejects(client.request({...add,kind:'motor',deviceId:-1}),/ID/)
  await assert.rejects(client.request({...add,kind:'imu',busId:999}),/Bus/)
  await client.request({type:'select',motorKey:manual.adapters[0].motors[0].key})
  await client.request({type:'control',mode:'position',values:[0,1,1]})
  await client.request({type:'canfd',enabled:true})
  const scan=await client.request<SessionState>({type:'scan'})
  assert.equal(scan.control,undefined)
  assert.equal(scan.adapters[0].motors.find(m=>m.origin==='manual')?.canfd,true)
  assert.equal(typeof await client.request({type:'read',item:'position'}),'string')
  // Native drivers skip motor discovery on buses hosting external devices.
  assert.equal(scan.adapters[0].motors.length,2)
  assert.equal(scan.adapters[0].motors.filter(m=>m.origin==='manual').length,2)
  assert.deepEqual(scan.adapters[0].devices.map(d=>d.kind).sort(),['battery','imu','pms'])
  const motor=scan.adapters[0].motors[0]
  const changed=await client.request<SessionState>({type:'canfd',motorKey:motor.key,enabled:true})
  assert.equal(changed.adapters[0].motors.find(m=>m.key===motor.key)?.canfd,true)
  await client.request({type:'remove-device',deviceKey:motor.key})
  const imu=scan.adapters[0].devices.find(d=>d.kind==='imu')!
  const removed=await client.request<SessionState>({type:'remove-device',deviceKey:imu.key})
  assert.equal(removed.adapters[0].motors.length,1)
  assert.equal(removed.adapters[0].devices.length,2)
  assert.equal(removed.selected,undefined)
  const again=await client.request<SessionState>({type:'scan'})
  assert.equal(again.adapters[0].motors.length,1)
  assert.equal(again.adapters[0].devices.length,2)
 } finally {await client.close();logs.dispose()}
})

test('native Fake performance tests publish bench results and stop stress on target changes', {timeout:90000},async()=>{
 const logs=createLogStore({flushIntervalMs:0})
 const worker=fork(new URL('../src/studio/driver-worker.ts',import.meta.url),[],{stdio:['ignore','pipe','pipe','ipc'],execArgv:['--import','tsx'],env:{...process.env,EMCLI_STUDIO_OPTIONS:JSON.stringify({demo:true})}})
 const client=connectWorker(worker,logs)
 const updates:import('../src/studio/protocol.js').PerformanceUpdate[]=[]
 const unsubscribe=client.subscribe(e=>{if(e.type==='performance')updates.push(e.update)})
 try{
  const state=await client.request<SessionState>({type:'add',adapterType:'Fake',interfaceName:'perf-test'})
  const scope={adapterKey:state.adapters[0].key,slaveId:null,busId:0}
  const verifyImmediateControl=async()=>{
   const samples:Telemetry[]=[]
   const off=client.subscribe(e=>{if(e.type==='telemetry')samples.push(e.sample)})
   try{
    await client.request({type:'select',motorKey:state.adapters[0].motors[0].key})
    await client.request({type:'control',mode:'position',values:[37,1,1]})
    await new Promise(r=>setTimeout(r,250))
    assert.ok(samples.some(s=>Math.abs(s.position!-37)<.02),'ordinary control must receive feedback after test cleanup without commit')
    await client.request({type:'disable'})
   }finally{off()}
  }
  await client.request({type:'stress-start',scope:{adapterKey:scope.adapterKey}})
  await new Promise(resolve=>setTimeout(resolve,450))
  assert.ok(updates.some(u=>u.kind==='stress'&&u.running&&u.snapshot.sent>0))
  await client.request({type:'stress-stop'})
  assert.ok(updates.at(-1)?.kind==='stress'&&!updates.at(-1)?.running)
  await verifyImmediateControl()
  await client.request({type:'stress-start',scope})
  await client.request({type:'select',motorKey:state.adapters[0].motors[0].key})
  assert.equal(updates.at(-1)?.running,false)
  await verifyImmediateControl()
  const bench=await client.request<import('../src/studio/protocol.js').PerformanceUpdate>({type:'bench',scope:{adapterKey:scope.adapterKey}})
  assert.equal(bench.kind,'bench');assert.equal(bench.running,false)
  if(bench.kind==='bench'){assert.ok(bench.rows.length>0);assert.ok(bench.rows[0].attempts>0);assert.equal(bench.error,undefined)}
  await verifyImmediateControl()
 }finally{unsubscribe();await client.close();logs.dispose()}
})

test('native Batch controls only selected motors, logs writes per address, and view changes stop capture', {timeout:30000},async()=>{
 const logs=createLogStore({flushIntervalMs:0})
 const worker=fork(new URL('../src/studio/driver-worker.ts',import.meta.url),[],{stdio:['ignore','pipe','pipe','ipc'],execArgv:['--import','tsx'],env:{...process.env,EMCLI_STUDIO_OPTIONS:JSON.stringify({demo:true})}})
 const client=connectWorker(worker,logs),samples:Telemetry[]=[]
 const unsubscribe=client.subscribe(event=>{if(event.type==='telemetry')samples.push(event.sample)})
 try{
  const initial=await client.request<SessionState>({type:'add',adapterType:'Fake',interfaceName:'batch-test'})
  const keys=initial.adapters[0].motors.slice(0,2).map(m=>m.key)
  await client.request({type:'select',motorKey:keys[0]});await client.request({type:'control',mode:'current',values:[1]})
  const batch=await client.request<SessionState>({type:'view',view:'batch'});assert.equal(batch.control,undefined);samples.length=0
  await client.request({type:'batch-selection',motorKeys:keys})
  await client.request({type:'batch-control',command:{mode:'position',values:[15,1,1]}})
  await new Promise(r=>setTimeout(r,350))
  assert.deepEqual(new Set(samples.map(s=>s.motorKey)),new Set(keys))
  assert.ok(samples.every(s=>Math.abs(s.position!-15)<.02))
  await client.request({type:'batch-write',item:'can-timeout',values:['650']})
  for(const id of [1,2])assert.ok(logs.getSnapshot().some(entry=>entry.message.includes(`Motor ${id} (0x0${id}): write can-timeout = 650 OK`)))
  await assert.rejects(client.request({type:'batch-write',item:'id',values:['9']}),/unavailable/)
  await client.request({type:'batch-write',item:'position',values:[]})
  for(const id of [1,2])assert.ok(logs.getSnapshot().some(entry=>entry.message.includes(`Motor ${id} (0x0${id}): write position = reset zero OK`)))
  samples.length=0;await client.request({type:'graph-active',active:true,expectedView:'batch'});await new Promise(r=>setTimeout(r,200))
  assert.deepEqual(new Set(samples.map(s=>s.motorKey)),new Set(keys))
  await client.request({type:'view',view:'play'});await new Promise(r=>setTimeout(r,80));const count=samples.length
  await new Promise(r=>setTimeout(r,150));assert.equal(samples.length,count)
  await assert.rejects(client.request({type:'graph-active',active:true,expectedView:'batch'}),/view changed/)
  await client.request({type:'view',view:'single'})
  for(const key of keys){await client.request({type:'select',motorKey:key});assert.equal(Number(await client.request({type:'read',item:'can-timeout'})),650)}
 }finally{unsubscribe();await client.close();logs.dispose()}
})
