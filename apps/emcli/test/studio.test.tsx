// SPDX-FileCopyrightText: 2026 Encos
// SPDX-License-Identifier: MIT

import assert from 'node:assert/strict'
import test,{afterEach} from 'node:test'
import React from 'react'
import {render,cleanup} from 'ink-testing-library'
import {PassThrough} from 'node:stream'
import {StudioApp} from '../src/studio/app.js'
import {OverlayProvider} from '../src/tui/overlay.js'
import {MouseProvider,type MouseEvent} from '../src/tui/mouse.js'
import {createLogStore} from '../src/tui/log-store.js'
import {validateControl,validateSetting,SETTINGS} from '../src/studio/catalog.js'
import type {Event,Request,SessionState,StudioClient} from '../src/studio/protocol.js'
const settle=()=>new Promise(resolve=>setTimeout(resolve,100))
afterEach(cleanup)
const initial:SessionState={adapters:[{key:'adapter',type:'Fake',interfaceName:'demo',devices:[],buses:[{slaveId:null,busId:0}],motors:[{key:'motor',adapterKey:'adapter',slaveId:null,busId:0,motorId:1,canfd:false,eff:false}]}],selected:'motor',graph:['position']}
function harness(options:{state?:SessionState;request?:(request:Request)=>Promise<void>;preload?:Array<{type:string;id:string}>}={}){
 let quits=0
 const listeners=new Set<(event:Event)=>void>(),requests:Request[]=[]
 let state=structuredClone(options.state??initial)
 const emit=(event:Event)=>{for(const listener of listeners)listener(event)}
 const client:StudioClient={async request<T>(request:Request){
  requests.push(request)
  await options.request?.(request)
  if(request.type==='interfaces'){emit({type:'state',state});return {version:'test',types:[{type:'Fake',interfaces:['demo']},{type:'Manual',interfaces:[]}]} as T}
  if(request.type==='view')state={...state,view:request.view,control:undefined,controlCommand:undefined,batchCommand:undefined}
  if(request.type==='batch-selection')state={...state,batchKeys:request.motorKeys}
  if(request.type==='batch-control')state={...state,batchCommand:structuredClone(request.command)}
  if(request.type==='batch-disable')state={...state,batchCommand:undefined}
  if(request.type==='select')state={...state,selected:request.motorKey,selectedDevice:request.deviceKey,control:undefined,controlCommand:undefined}
  if(request.type==='ranges')return {} as T
  if(request.type==='read')return '12.000000' as T
  if(request.type==='control')state={...state,control:request.mode,controlCommand:{mode:request.mode,values:[...request.values],stopMode:request.stopMode}}
  if(request.type==='disable')state={...state,control:undefined,controlCommand:undefined}
  if(request.type==='graph')state={...state,graph:request.metrics}
  emit({type:'state',state});return state as T
 },subscribe(listener){listeners.add(listener);return()=>{listeners.delete(listener)}},async close(){}}
 let mouse=(_event:MouseEvent)=>{}
 const input={stdin:new PassThrough(),onMouse(listener:typeof mouse){mouse=listener;return()=>{}},dispose(){}}
 const logs=createLogStore({flushIntervalMs:0})
 const app=render(<MouseProvider input={input}><OverlayProvider><StudioApp client={client} logs={logs} preload={options.preload} onQuit={()=>{quits++}}/></OverlayProvider></MouseProvider>)
 Object.defineProperties(app.stdout,{columns:{value:140,configurable:true},rows:{value:42,configurable:true}});app.stdout.emit('resize')
 const click=async(label:string)=>{
  const lines=(app.lastFrame()??'').split('\n'),y=lines.findIndex(line=>line.includes(label));assert.ok(y>=0,`Visible: ${label}`)
  mouse({action:'press',button:'left',x:lines[y].indexOf(label)+1,y});await settle()
  mouse({action:'release',button:'left',x:lines[y].indexOf(label)+1,y});await settle()
 }
 return {app,logs,requests,emit,click,quits:()=>quits,mouse:(event:MouseEvent)=>mouse(event)}
}
test('studio presents legacy control/settings/graph workflow and sends typed operations',async()=>{
 const {app,logs,requests,click,emit}=harness();await settle();await settle()
 assert.match(app.lastFrame()??'',/Devices/);assert.match(app.lastFrame()??'',/─ Status ─/)
 await click('Apply PVT')
 assert.ok(requests.some(request=>request.type==='control'&&request.mode==='pvt'&&request.expectedMotor==='motor'))
 app.stdin.write('\r');await settle();assert.equal(requests.filter(r=>r.type==='control').length,2);assert.doesNotMatch(app.lastFrame()??'',/Add Glove/)
 await click('Settings');await click('Read')
 // The first editable setting is CAN ID; the first Read belongs to Position.
 assert.ok(requests.some(request=>request.type==='read'&&request.item==='position'))
 assert.match(app.lastFrame()??'',/12.000000/)
 await click('Graph')
 emit({type:'telemetry',sample:{motorKey:'motor',timestamp:Date.now(),position:42}});await settle();await settle()
 assert.match(app.lastFrame()??'',/42.0/);assert.match(app.lastFrame()??'',/Live telemetry/)
 assert.doesNotMatch(app.lastFrame()??'',/Metrics/)
 await click('■ Position');assert.ok(requests.some(r=>r.type==='graph'&&!r.metrics.includes('position')))
 await click('□ Position');assert.ok(requests.filter(r=>r.type==='graph').at(-1)?.metrics.includes('position'))
 logs.append({message:'Native stdout captured',source:'driver'});await settle()
 assert.match(app.lastFrame()??'',/Native stdout captured/)
 assert.doesNotMatch(app.lastFrame()??'',/[\u4e00-\u9fff]/)
 logs.dispose()
})
test('studio fits supported terminal sizes without rendering outside its frame',async()=>{
 const {app,logs,click}=harness();await settle();await settle()
 for(const [columns,rows] of [[120,40],[100,30]]){
  Object.defineProperties(app.stdout,{columns:{value:columns,configurable:true},rows:{value:rows,configurable:true}});app.stdout.emit('resize');await settle()
  for(const tab of ['Control','Settings','Graph']){
   await click(tab)
   const lines=(app.lastFrame()??'').split('\n')
   assert.equal(lines.length,rows)
   assert.ok(lines.every(line=>[...line].length<=columns),`${tab} fits ${columns} columns`)
  }
 }
 logs.dispose()
})
test('configuration validation covers old settings and rejects invalid writes before native calls',()=>{
 assert.equal(SETTINGS.length,14)
 assert.throws(()=>validateSetting('id',['1.5']),/integers/)
 assert.throws(()=>validateSetting('id',['0']),/CAN ID/)
 assert.throws(()=>validateSetting('pvt-pos-range',['10','-10']),/Minimum/)
 assert.throws(()=>validateSetting('cur-pi',['','1']),/finite/)
 assert.throws(()=>validateSetting('kt',['1']),/read-only/)
 assert.throws(()=>validateControl('pvt',[1,1,NaN,0,0]),/Invalid/)
 validateSetting('position',[]);validateSetting('comm',['canfd']);validateControl('stop',[0],'full')
})

 test('add adapter offers only discovered interfaces or only manual entry for its type',async()=>{
  const {app,logs,click}=harness();await settle();await settle()
  await click('Add');await click('Add Adapter')
  assert.match(app.lastFrame()??'',/Available interfaces/)
  assert.doesNotMatch(app.lastFrame()??'',/Interface \/ endpoint/)
  // Open the type dropdown and choose the type with no discovered interfaces.
  await click('Fake')
  app.stdin.write('\u001b[B');await settle();app.stdin.write('\r');await settle()
  assert.match(app.lastFrame()??'',/Interface \/ endpoint/)
  assert.doesNotMatch(app.lastFrame()??'',/Available interfaces/)
  await click('Manual');app.stdin.write('\u001b[A');await settle();app.stdin.write('\r');await settle()
  assert.match(app.lastFrame()??'',/Available interfaces/)
  assert.doesNotMatch(app.lastFrame()??'',/Interface \/ endpoint/)
  logs.dispose()
 })


test('adapter selection swaps motor tabs for performance tabs and the logs panel collapses',async()=>{
 const {app,logs,click,requests}=harness();await settle();await settle()
 assert.doesNotMatch(app.lastFrame()??'',/Control:|Adapters & motors|Read.*Rescan/)
 assert.match(app.lastFrame()??'',/Motor 1 0x01/)
 logs.append({message:'Persistent session log'});await settle()
 assert.match(app.lastFrame()??'',/Persistent session log/)
 await click('Logs');assert.doesNotMatch(app.lastFrame()??'',/Persistent session log/)
 await click('Logs');assert.match(app.lastFrame()??'',/Persistent session log/)
 await click('Fake · demo')
 assert.match(app.lastFrame()??'',/Bench  Stress/);assert.doesNotMatch(app.lastFrame()??'',/─ Status ─/)
 assert.ok(requests.some(request=>request.type==='select'&&request.motorKey===undefined))
 await click('Motor 1')
 assert.match(app.lastFrame()??'',/─ Status ─/)
 await click('Add');assert.match(app.lastFrame()??'',/Adapter/);assert.match(app.lastFrame()??'',/ReScan Motors/)
 assert.doesNotMatch(app.lastFrame()??'',/Rescan all|Disconnect adapter|Keyboard and controls/)
 await click('Add IMU');assert.match(app.lastFrame()??'',/Add IMU/);assert.match(app.lastFrame()??'',/Slave 0 \/ Bus 0/)
 app.stdin.write('\u001b');await settle()
 logs.dispose()
})

test('device context menu targets the clicked motor and opens from Ctrl+Space',async()=>{
 const {app,logs,click,mouse,requests}=harness();await settle();await settle()
 const point=(label:string)=>{const lines=(app.lastFrame()??'').split('\n'),y=lines.findIndex(line=>line.includes(label));assert.ok(y>=0,`Visible: ${label}`);return {x:lines[y].indexOf(label)+1,y}}
 mouse({action:'press',button:'right',...point('Motor 1')});await settle();await settle()
 assert.match(app.lastFrame()??'',/CAN FD/);assert.match(app.lastFrame()??'',/Delete/)
 await click('CAN FD');assert.ok(requests.some(request=>request.type==='canfd'&&request.motorKey==='motor'))
 await click('Motor 1');app.stdin.write('\u0000');await settle();await settle()
 assert.match(app.lastFrame()??'',/Delete/)
 await click('Delete');assert.ok(requests.some(request=>request.type==='remove-device'&&request.deviceKey==='motor'))
 logs.dispose()
})


test('footer lists context shortcuts using caret notation and Ctrl+C twice quits',async()=>{
 const h=harness();await settle();await settle()
 const footer=(h.app.lastFrame()??'').split('\n').at(-1)!
 assert.match(footer,/\^n/);assert.match(footer,/\^Space Item Menu/);assert.doesNotMatch(footer,/ctrl\+/i)
 h.app.stdin.write('\x03');await settle();assert.match(h.app.lastFrame()??'',/Close motor session/);assert.equal(h.quits(),0)
 h.app.stdin.write('\x03');await settle();assert.equal(h.quits(),1)
 h.logs.dispose()
})

test('collapsed logs span the entire panel on one row and expand by clicking the far edge',async()=>{
 const h=harness();await settle();await settle()
 h.logs.append({message:'Still recording while collapsed'});await settle()
 await h.click('Logs')
 const lines=(h.app.lastFrame()??'').split('\n'),y=lines.findIndex(line=>line.includes('▶ Logs'))
 assert.equal(y,40);assert.equal(lines[y].length,140)
 assert.doesNotMatch(h.app.lastFrame()??'',/Still recording while collapsed/)
 h.mouse({action:'press',button:'left',x:138,y});await settle()
 assert.match(h.app.lastFrame()??'',/Still recording while collapsed/)
 h.logs.dispose()
})

test('empty device messages are centered horizontally and vertically within their cards',async()=>{
 const h=harness({state:{adapters:[],graph:['position']}});await settle();await settle()
 const lines=(h.app.lastFrame()??'').split('\n')
 const leftY=lines.findIndex(line=>line.includes('No devices')),rightY=lines.findIndex(line=>line.includes('No device selected'))
 const deviceRight=lines[leftY].indexOf('│',1)
 assert.ok(Math.abs(lines[leftY].indexOf('No devices')+5-(deviceRight+1)/2)<=1)
 const rightStart=deviceRight+2,rightEnd=139
 assert.ok(Math.abs(lines[rightY].indexOf('No device selected')+9-(rightStart+rightEnd)/2)<=1)
 assert.ok(Math.abs(leftY-22)<=1);assert.ok(Math.abs(rightY-17)<=1)
 h.logs.dispose()
})

test('rescan uses an animated loading modal, blocks the menu and clears on completion',async()=>{
 let finish!:()=>void
 const pending=new Promise<void>(resolve=>{finish=resolve})
 const h=harness({request:request=>request.type==='scan'?pending:Promise.resolve()});await settle();await settle()
 await h.click('Add')
 const menu=(h.app.lastFrame()??'').split('\n'),scanRow=menu.findIndex(line=>line.includes('ReScan Motors'))
 assert.ok(menu[scanRow-1].includes('────'))
 for(const item of ['Add Adapter','Add Motor','Add IMU','Add Battery','Add PMS'])assert.match(h.app.lastFrame()??'',new RegExp(item))
 h.app.stdin.write('\u001b[A');await settle();h.app.stdin.write('\r');await settle();assert.match(h.app.lastFrame()??'',/Scanning motors\.\.\./)
 await settle();await settle()
 assert.ok(new Set(h.app.frames.flatMap(frame=>frame.match(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g)??[])).size>1)
 h.app.stdin.write('\u001b');await settle();assert.match(h.app.lastFrame()??'',/Scanning motors/)
 await h.click('Add');assert.equal(h.requests.filter(request=>request.type==='scan').length,1)
 finish();await settle();await settle();assert.doesNotMatch(h.app.lastFrame()??'',/Scanning motors/)
 h.logs.dispose()
})

test('adapter loading modal clears on failure and preserves the form for retry',async()=>{
 let fail!:(error:Error)=>void
 const pending=new Promise<void>((_,reject)=>{fail=reject})
 const h=harness({request:request=>request.type==='add'?pending:Promise.resolve()});await settle();await settle()
 await h.click('Add');await h.click('Add Adapter');await h.click('Connect')
 assert.match(h.app.lastFrame()??'',/Adding adapter\.\.\./)
 fail(new Error('Test connection failure'));await settle();await settle()
 assert.doesNotMatch(h.app.lastFrame()??'',/Adding adapter/)
 assert.match(h.app.lastFrame()??'',/Test connection failure/);assert.match(h.app.lastFrame()??'',/Available interfaces/)
 await h.click('Cancel');assert.doesNotMatch(h.app.lastFrame()??'',/Available interfaces/)
 await h.click('Add');await h.click('Add Adapter');await h.click('Connect')
 assert.equal(h.requests.filter(request=>request.type==='add').length,2,'clicks must still work after a failed connection')
 h.logs.dispose()
})


test('driver timeout clears stale controls and leaves mouse-operated quit available',async()=>{
 let offline=false
 let fail!:(error:Error)=>void
 const pending=new Promise<void>((_,reject)=>{fail=reject})
 const h=harness({request:request=>offline?Promise.reject(new Error('Driver process is offline')):request.type==='add'?pending:Promise.resolve()});await settle();await settle()
 await h.click('Add');await h.click('Add Adapter');await h.click('Connect')
 const message='Driver process request timed out; the session was terminated.'
 offline=true
 h.emit({type:'log',level:'error',message});fail(new Error(message));await settle();await settle()
 assert.doesNotMatch(h.app.lastFrame()??'',/Adding adapter|Available interfaces|Apply PVT/)
 await h.click('Quit');assert.match(h.app.lastFrame()??'',/Close motor session/)
 await h.click('Cancel');assert.doesNotMatch(h.app.lastFrame()??'',/Close motor session/)
 h.logs.dispose()
})

test('preloaded adapters also show loading until completion',async()=>{
 let finish!:()=>void
 const pending=new Promise<void>(resolve=>{finish=resolve})
 const h=harness({preload:[{type:'Fake',id:'demo'}],request:request=>request.type==='add'?pending:Promise.resolve()});await settle();await settle()
 assert.match(h.app.lastFrame()??'',/Adding adapter\.\.\./)
 finish();await settle();await settle()
 assert.doesNotMatch(h.app.lastFrame()??'',/Adding adapter/)
 assert.match(h.app.lastFrame()??'',/─ Status ─/)
 h.logs.dispose()
})

test('peripheral selection shows live status and sends commands to that device',async()=>{
 const state=structuredClone(initial)
 state.adapters[0].devices=[{key:'imu',adapterKey:'adapter',slaveId:null,busId:0,deviceId:1,kind:'imu',origin:'manual'}]
 const {app,logs,requests,click,emit}=harness({state});await settle();await settle()
 await click('IMU 1 0x01')
 assert.match(app.lastFrame()??'',/Acceleration.*Angular velocity/)
 assert.doesNotMatch(app.lastFrame()??'',/─ Status ─/)
 emit({type:'device-status',sample:{deviceKey:'imu',kind:'imu',timestamp:Date.now(),status:{acceleration:{x:12.345,y:2,z:3}}}});await settle()
 assert.match(app.lastFrame()??'',/12.345/)
 await click('Start')
 assert.ok(requests.some(r=>r.type==='device-action'&&r.deviceKey==='imu'&&r.action.kind==='imu'&&r.action.operation==='start'))
 logs.dispose()
})

test('Add DexHand asks only for the base ID on the selected bus', async () => {
 const h = harness()
 await settle()
 await settle()
 await h.click('Slave 0 Bus 0')
 await h.click('Add')
 await h.click('Add DexHand')
 assert.match(h.app.lastFrame() ?? '', /Base ID/)
 assert.doesNotMatch(h.app.lastFrame() ?? '', /Select bus|Select Bus/)
 const lines = (h.app.lastFrame() ?? '').split('\n')
 const y = lines.findIndex((line) => /Cancel.*Add/.test(line))
 assert.ok(y >= 0)
 const x = lines[y].lastIndexOf('Add') + 1
 h.mouse({ action: 'press', button: 'left', x, y })
 await settle()
 h.mouse({ action: 'release', button: 'left', x, y })
 await settle()
 assert.deepEqual(h.requests.find((request) => request.type === 'add-device'), {
  type: 'add-device', kind: 'dexhand', adapterKey: 'adapter', slaveId: null, busId: 0, deviceId: 1,
 })
 h.logs.dispose()
})

test('DexHand exposes Settings and Stress while its joints omit CAN settings', async () => {
 const state = structuredClone(initial)
 const [adapter] = state.adapters
 adapter.devices = [{ key: 'hand', adapterKey: 'adapter', slaveId: null, busId: 0, deviceId: 1, kind: 'dexhand', origin: 'manual' }]
 adapter.motors.push({ key: 'joint', adapterKey: 'adapter', slaveId: null, busId: 0,
  motorId: (1 << 29) | 1, canfd: true, eff: false, dexHandKey: 'hand', jointLabel: 'Thumb 1' })
 const h = harness({ state })
 await settle()
 await settle()
 await h.click('DexHand 1')
 assert.match(h.app.lastFrame() ?? '', /DexHand settings/)
 assert.match(h.app.lastFrame() ?? '', /Sample points/)
 assert.doesNotMatch(h.app.lastFrame() ?? '', /Bench/)
 await h.click('Read')
 assert.ok(h.requests.some((request) => request.type === 'dex-hand-setting' && request.item === 'base-id'))
 await h.click('Stress')
 await h.click('Start test')
 const stress = h.requests.find((request) => request.type === 'stress-start')
 assert.ok(stress?.type === 'stress-start')
 assert.equal(stress.scope.dexHandKey, 'hand')
 assert.deepEqual(stress.motorKeys, ['joint'])

 h.emit({ type: 'state', state: { ...state, selected: 'joint' } })
 await settle()
 const lines = (h.app.lastFrame() ?? '').split('\n')
 if (!lines.some((line) => line.includes('Thumb 1'))) {
  h.app.stdin.write('\u001b[C')
  await settle()
 }
 await h.click('Thumb 1')
 await h.click('Settings')
 assert.doesNotMatch(h.app.lastFrame() ?? '', /CAN ID|CAN timeout|Communication mode/)
 assert.match(h.app.lastFrame() ?? '', /Torque constant/)
 h.logs.dispose()
})

test('bus timing and performance tabs send scoped commands and display native results',async()=>{
 const {app,logs,requests,click,emit}=harness();await settle();await settle()
 await click('Slave 0 Bus 0')
 assert.match(app.lastFrame()??'',/Arbitration bitrate/)
 assert.match(app.lastFrame()??'',/Apply timing/)
 const frame=app.lastFrame()??''
 assert.ok(frame.indexOf('Apply timing')>frame.indexOf('Data bitrate'))
 await click('Bench');assert.doesNotMatch(app.lastFrame()??'',/Frequency \(Hz\)/);await click('Start test')
 const request=requests.find(r=>r.type==='bench')
 assert.ok(request?.type==='bench');assert.deepEqual(request.scope,{adapterKey:'adapter',slaveId:null,busId:0})
 emit({type:'performance',update:{kind:'bench',scope:request.scope,running:false,rows:[{periodMs:10,attempts:500,lost:1,status:'OK',count:499,meanUs:123,p1Us:100,p5Us:105,p50Us:120,p95Us:140,p99Us:150,opsPerSecond:8333,errorPercent:1}]}});await settle()
 assert.match(app.lastFrame()??'',/123.00/)
 await click('Stress');await click('Start test')
 assert.ok(requests.some(r=>r.type==='stress-start'))
 emit({type:'performance',update:{kind:'stress',scope:request.scope,running:true,snapshot:{sent:100,received:90,elapsedMs:500,measurementMs:500,drainMs:0,drainAdditional:0,outstandingBefore:10,outstandingAfter:10,final:false,error:'',motors:[{slaveId:null,busId:0,motorId:1,sent:100,received:90}]}}});await settle()
 assert.match(app.lastFrame()??'',/10\/100 \(10.00%\)/)
 await click('Stop test');assert.ok(requests.some(r=>r.type==='stress-stop'))
 emit({type:'performance',update:{kind:'stress',scope:request.scope,running:false,snapshot:{sent:100,received:95,elapsedMs:700,measurementMs:500,drainMs:200,drainAdditional:5,outstandingBefore:10,outstandingAfter:5,final:true,error:'',motors:[]}}});await settle()
 assert.doesNotMatch(app.lastFrame()??'',/Late replies|Reply wait|Drain replies/)
 logs.dispose()
})
test('EtherCAT slave offers only Bench and Stress while glove hides its buses',async()=>{
 const state=structuredClone(initial)
 state.adapters[0].type='Ethercat'
 state.adapters[0].buses.push({slaveId:1,busId:0})
 state.adapters[0].devices.push({key:'g',kind:'glove',adapterKey:'adapter',slaveId:1,busId:null,deviceId:1,origin:'manual'})
 const {app,logs,click}=harness({state});await settle();await settle()
 await click('Slave 0')
 assert.match(app.lastFrame()??'',/Bench/);assert.match(app.lastFrame()??'',/Stress/)
 assert.doesNotMatch(app.lastFrame()??'',/Apply timing|Arbitration bitrate/)
 await click('Glove · Slave 1')
 assert.match(app.lastFrame()??'',/Encoder angles/)
 assert.match(app.lastFrame()??'',/F0/)
 logs.dispose()
})

test('adapter offers Bench and Stress for the entire adapter',async()=>{
 const {app,logs,requests,click}=harness();await settle();await settle()
 await click('Fake · demo');await click('Start test')
 assert.ok(requests.some(r=>r.type==='bench'&&r.scope.adapterKey==='adapter'&&r.scope.slaveId===undefined&&r.scope.busId===undefined))
 await click('Stress');await click('Start test')
 assert.ok(requests.some(r=>r.type==='stress-start'&&r.scope.slaveId===undefined))
 assert.doesNotMatch(app.lastFrame()??'',/Apply timing/)
 logs.dispose()
})
test('PMS aligns Channels with medium Enable and Disable buttons with two parameter columns',async()=>{
 const state=structuredClone(initial)
 state.adapters[0].devices=[{key:'p',adapterKey:'adapter',slaveId:null,busId:0,deviceId:1,kind:'pms',origin:'manual'}]
 const {app,logs,requests,click}=harness({state});await settle();await settle();await click('PMS 1 0x01')
 const frame=app.lastFrame()??'',lines=frame.split('\n')
 assert.match(frame,/48 V channels.*Power/)
 const buttons=lines.find(line=>line.includes('Enable')&&line.includes('Disable'))
 assert.ok(buttons&&buttons.indexOf('Enable')<buttons.indexOf('Disable'))
 assert.ok(buttons?.includes('V48_1')||buttons?.includes('selected'),buttons)
 assert.ok(frame.indexOf('Channels')<frame.indexOf('Enable'))
 await click('Enable')
 assert.ok(requests.some(r=>r.type==='device-action'&&r.action.kind==='pms'&&r.action.operation==='channels'&&r.action.enabled))
 logs.dispose()
})

test('glove uses a finger-by-encoder matrix and calibration controls stack on narrow screens',async()=>{
 const state=structuredClone(initial)
 state.adapters[0].type='Ethercat'
 state.adapters[0].devices=[{key:'g',adapterKey:'adapter',slaveId:0,busId:null,deviceId:0,kind:'glove',origin:'scan'}]
 state.adapters[0].motors=[]
 const {app,logs,click,emit,requests}=harness({state});await settle();await settle()
 Object.defineProperties(app.stdout,{columns:{value:220,configurable:true},rows:{value:70,configurable:true}});app.stdout.emit('resize');await settle()
 await click('Glove · Slave 0')
 const status=Array.from({length:5},(_,f)=>Array.from({length:10},(_,e)=>(f*10+e)*Math.PI/180))
 emit({type:'device-status',sample:{kind:'glove',deviceKey:'g',timestamp:Date.now(),status}});await settle()
 let lines=(app.lastFrame()??'').split('\n')
 assert.ok(lines.some(line=>/Enc 0.*Enc 9/.test(line)))
 assert.ok(lines.some(line=>/F4\s+.*40\.00.*49\.00/.test(line)))
 const all=lines.findIndex(l=>l.includes('Calibrate all')),encoder=lines.findIndex(l=>l.includes('Calibrate encoder')),mask=lines.findIndex(l=>l.includes('Calibrate mask'))
 assert.ok(all>=0&&encoder>all);assert.equal(mask,encoder)
 await click('Calibrate encoder')
 assert.ok(requests.some(r=>r.type==='device-action'&&r.action.kind==='glove'&&r.action.operation==='mask'&&r.action.finger===0&&r.action.mask===1))
 Object.defineProperty(app.stdout,'columns',{value:120,configurable:true});app.stdout.emit('resize');await settle();await settle()
 lines=(app.lastFrame()??'').split('\n')
 assert.ok(lines.findIndex(l=>l.includes('Calibrate mask'))>lines.findIndex(l=>l.includes('Calibrate encoder')))
 logs.dispose()
})

test('startup focuses Add after loading and Add adapter focuses its first field without a click',async()=>{
 const h=harness();await settle();await settle()
 h.app.stdin.write('\r');await settle()
 assert.match(h.app.lastFrame()??'',/Add Adapter/)
 h.app.stdin.write('\r');await settle();await settle()
 assert.match(h.app.lastFrame()??'',/Adapter type/)
 // Enter opens the type picker; Down + Enter changes Fake to Manual.
 h.app.stdin.write('\r');await settle();h.app.stdin.write('\u001b[B');await settle();h.app.stdin.write('\r');await settle()
 assert.match(h.app.lastFrame()??'',/Interface \/ endpoint/)
 assert.doesNotMatch(h.app.lastFrame()??'',/Available interfaces/)
 h.app.stdin.write('\u001b');await settle()
 assert.doesNotMatch(h.app.lastFrame()??'',/Adapter type/)
 h.app.stdin.write('\r');await settle();assert.match(h.app.lastFrame()??'',/Add Adapter/)
 h.logs.dispose()
})
test('preload completion restores Add focus and failed adapter creation returns to the first form field',async()=>{
 let finish!:()=>void
 const pending=new Promise<void>(resolve=>{finish=resolve});let preload=true
 let fail!:(e:Error)=>void;const failed=new Promise<void>((_,reject)=>{fail=reject})
 const h=harness({preload:[{type:'Fake',id:'demo'}],request:r=>r.type==='add'?(preload?pending:failed):Promise.resolve()})
 await settle();await settle();finish();await settle();await settle();preload=false
 h.app.stdin.write('\r');await settle();assert.match(h.app.lastFrame()??'',/Add Adapter/)
 h.app.stdin.write('\r');await settle();await settle();await h.click('Connect');await settle();fail(new Error('Connect failed'));await settle();await settle()
 assert.match(h.app.lastFrame()??'',/Connect failed/)
 h.app.stdin.write('\r');await settle();h.app.stdin.write('\u001b[B');await settle();h.app.stdin.write('\r');await settle()
 assert.match(h.app.lastFrame()??'',/Interface \/ endpoint/)
 h.logs.dispose()
})

test('Add Motor initially focuses the bus tree and Add Glove focuses its adapter picker',async()=>{
 const state=structuredClone(initial)
 state.adapters.push({key:'e1',type:'Ethercat',interfaceName:'eth1',buses:[{slaveId:3,busId:0}],devices:[],motors:[]},{key:'e2',type:'Ethercat',interfaceName:'eth2',buses:[{slaveId:5,busId:0}],devices:[],motors:[]})
 const h=harness({state});await settle();await settle()
 await h.click('Add');await h.click('Add Motor')
 h.app.stdin.write('\r');await settle();h.app.stdin.write('\u001b[F');await settle();h.app.stdin.write('\r');await settle()
 assert.match(h.app.lastFrame()??'',/Slave 5 \/ Bus 0/)
 h.app.stdin.write('\u001b');await settle();await h.click('Add');await h.click('Add Glove')
 h.app.stdin.write('\r');await settle();h.app.stdin.write('\u001b[B');await settle();h.app.stdin.write('\r');await settle()
 assert.match(h.app.lastFrame()??'',/Slave 5/)
 h.logs.dispose()
})

test('device table groups leave exactly one blank row and battery actions are grouped and aligned',async()=>{
 const state=structuredClone(initial)
 state.adapters[0].devices=[{key:'i',adapterKey:'adapter',slaveId:null,busId:0,deviceId:1,kind:'imu',origin:'manual'},{key:'b',adapterKey:'adapter',slaveId:null,busId:0,deviceId:2,kind:'battery',origin:'manual'}]
 const h=harness({state});await settle();await settle();await h.click('IMU 1 0x01')
 let lines=(h.app.lastFrame()??'').split('\n')
 const euler=lines.findIndex(l=>l.includes('Euler angles'))
 const bottom=lines.slice(0,euler).findLastIndex(l=>/[└┗][─━]+[┘┛]/.test(l))
 assert.ok(bottom>=0);assert.equal(euler-bottom,2)
 await h.click('Battery 2 0x02')
 lines=(h.app.lastFrame()??'').split('\n')
 assert.ok(lines.some(l=>/Clear fault {7}Charge on {5}Charge off {7}Discharge on {5}Discharge off/.test(l)))
 assert.ok(lines.some(l=>/none.*Send flags/.test(l)))
 await h.click('Send flags')
 assert.ok(h.requests.some(r=>r.type==='device-action'&&r.action.kind==='battery'&&r.action.operation==='commands'))
 h.logs.dispose()
})

test('all bus-device forms select adapter and bus from one tree and submit the leaf address',async()=>{
 const state=structuredClone(initial)
 state.adapters.push({key:'e',type:'Ethercat',interfaceName:'eth2',buses:[{slaveId:5,busId:3}],devices:[],motors:[]})
 const h=harness({state});await settle();await settle()
 for(const [label,kind] of [['Motor','motor'],['IMU','imu'],['Battery','battery'],['PMS','pms']] as const){
  await h.click('Add');await h.click(`Add ${label}`)
  h.app.stdin.write('\r');await settle();h.app.stdin.write('\u001b[F');await settle();h.app.stdin.write('\r');await settle()
  assert.match(h.app.lastFrame()??'',/Slave 5 \/ Bus 3/)
  // Shift+Tab from the first field wraps to the dialog's Add button.
  h.app.stdin.write('\u001b[Z');await settle();h.app.stdin.write('\r');await settle()
  assert.ok(h.requests.some(r=>r.type==='add-device'&&r.kind===kind&&r.adapterKey==='e'&&r.slaveId===5&&r.busId===3))
 }
 h.logs.dispose()
})

test('performance selectors default to all scope motors, send subsets and disable empty starts',async()=>{
 const state=structuredClone(initial)
 state.adapters[0].motors.push({...state.adapters[0].motors[0],key:'motor2',motorId:2})
 const {app,logs,requests,click}=harness({state});await settle();await settle()
 await click('Fake · demo')
 assert.match(app.lastFrame()??'',/2 selected.*Start test/)
 await click('Start test')
 assert.deepEqual(requests.find(r=>r.type==='bench')?.motorKeys,['motor','motor2'])
 await click('2 selected');app.stdin.write(' ');await settle();app.stdin.write('\u001b');await settle()
 assert.match(app.lastFrame()??'',/1 selected.*Start test/)
 await click('Start test')
 assert.deepEqual(requests.filter(r=>r.type==='bench').at(-1)?.motorKeys,['motor2'])
 await click('Stress');assert.match(app.lastFrame()??'',/2 selected.*Start test.*Stop test/)
 assert.match(app.lastFrame()??'',/Frequency \(Hz\)/)
 assert.match(app.lastFrame()??'',/1000/)
 await click('1000');app.stdin.write('\u0001');await settle();app.stdin.write('750');await settle()
 await click('2 selected');app.stdin.write(' ');await settle();app.stdin.write('\u001b');await settle()
 await click('Start test')
 assert.deepEqual(requests.find(r=>r.type==='stress-start')?.motorKeys,['motor2'])
 assert.equal((requests.find(r=>r.type==='stress-start') as Extract<Request,{type:'stress-start'}>)?.frequencyHz,750)
 await click('1 selected');app.stdin.write(' ');await settle();app.stdin.write('\u001b');await settle()
 const before=requests.filter(r=>r.type==='stress-start').length
 await click('Start test');assert.equal(requests.filter(r=>r.type==='stress-start').length,before)
 await click('Bench');assert.match(app.lastFrame()??'',/1 selected/)
 logs.dispose()
})


test('Graph tab starts and stops its own capture while preserving the applied command',async()=>{
 const {app,logs,requests,click}=harness();await settle();await settle()
 await click('Apply PVT')
 await click('Graph');assert.ok(requests.some(r=>r.type==='graph-active'&&r.active&&r.expectedMotor==='motor'))
 await click('Settings');assert.equal(requests.filter(r=>r.type==='graph-active').at(-1)?.active,false)
 assert.equal(requests.filter(r=>r.type==='disable').length,0)
 const lines=(app.lastFrame()??'').split('\n'),id=lines.findIndex(l=>l.includes('CAN ID')),position=lines.findIndex(l=>l.includes('Position (deg)'))
 assert.equal(position-id,3)
 await click('Control');assert.doesNotMatch(app.lastFrame()??'',/Read ranges/)
 assert.ok(requests.every(r=>r.type!=='ranges'))
 logs.dispose()
})

test('Batch view toggles only motors, retains item menus, uses batch controls and retains Position reset',async()=>{
 const state=structuredClone(initial)
 state.adapters[0].motors.push({...state.adapters[0].motors[0],key:'motor2',motorId:2})
 state.adapters[0].devices.push({key:'imu',adapterKey:'adapter',slaveId:null,busId:0,deviceId:1,kind:'imu',origin:'manual'})
 const {app,logs,requests,click}=harness({state});await settle();await settle()
 await click('View');await click('Batch')
 assert.match(app.lastFrame()??'',/\[ \] Motor 1/);assert.doesNotMatch(app.lastFrame()??'',/IMU 1|Motor temperature/)
 assert.match(app.lastFrame()??'',/Fake · demo/);assert.match(app.lastFrame()??'',/Slave 0 Bus 0/)
 await click('Slave 0 Bus 0');assert.match(app.lastFrame()??'',/\[✓\] Motor 1/)
 assert.deepEqual(requests.filter(r=>r.type==='batch-selection').at(-1)?.motorKeys,['motor','motor2'])
 app.stdin.write('\r');await settle();assert.doesNotMatch(app.lastFrame()??'',/Motor 1/)
 app.stdin.write(' ');await settle();assert.deepEqual(requests.filter(r=>r.type==='batch-selection').at(-1)?.motorKeys,[])
 app.stdin.write('\r');await settle();assert.match(app.lastFrame()??'',/\[ \] Motor 1/)

 await click('Motor 1');assert.match(app.lastFrame()??'',/\[✓\] Motor 1/)
 const selectedRequests=requests.filter(r=>r.type==='batch-selection').length
 app.stdin.write('\u001b[B');await settle();assert.equal(requests.filter(r=>r.type==='batch-selection').length,selectedRequests)
 app.stdin.write('\u0000');await settle();assert.match(app.lastFrame()??'',/CAN FD/);assert.equal(requests.filter(r=>r.type==='batch-selection').length,selectedRequests)
 app.stdin.write('\u001b');await settle();await click('Motor 2')
 await click('Apply PVT');assert.ok(requests.some(r=>r.type==='batch-control'&&r.command.mode==='pvt'))
 await click('Settings');assert.doesNotMatch(app.lastFrame()??'',/CAN ID|Communication mode|Torque constant| Read /)
 await click('Reset zero');assert.ok(requests.some(r=>r.type==='batch-write'&&r.item==='position'&&!r.values.length))
 await click('Graph');assert.match(app.lastFrame()??'',/By motor/);assert.match(app.lastFrame()??'',/Grouping/)
 await click('By motor');await click('By metric');assert.match(app.lastFrame()??'',/Metric/)
 await click('View');await click('Play');assert.match(app.lastFrame()??'',/CSV file/)
 const footer=(app.lastFrame()??'').split('\n').at(-1)!
 assert.match(footer,/\^c Quit/);assert.doesNotMatch(footer,/Item Menu|Add adapter/);assert.doesNotMatch(footer,/\^d|\^q|F10/)
 app.stdin.write('\x11');app.stdin.write('\x04');await settle();assert.doesNotMatch(app.lastFrame()??'',/Close motor session/)
 await click('View');await click('Single');assert.match(app.lastFrame()??'',/Fake · demo/)
 logs.dispose()
})

test('leaving the Stress tab requests test cleanup',async()=>{
 const {logs,requests,click,emit}=harness();await settle();await settle()
 await click('Fake · demo');await click('Stress')
 emit({type:'performance',update:{kind:'stress',scope:{adapterKey:'adapter'},running:true,snapshot:{sent:1,received:1,elapsedMs:1,measurementMs:1,drainMs:0,drainAdditional:0,outstandingBefore:0,outstandingAfter:0,error:'',final:false,motors:[]}}})
 await settle();await click('Bench')
 assert.ok(requests.some(r=>r.type==='stress-stop'));logs.dispose()
})

test('IMU Graph selects three measurement groups and toggles their components in the legend',async()=>{
 const state=structuredClone(initial)
 state.adapters[0].devices=[{key:'imu',adapterKey:'adapter',slaveId:null,busId:0,deviceId:1,kind:'imu',origin:'manual'}]
 const {app,logs,click,emit}=harness({state});await settle();await settle();await click('IMU 1 0x01')
 emit({type:'device-status',sample:{deviceKey:'imu',kind:'imu',timestamp:Date.now(),status:{acceleration:{x:12,y:2,z:3},angularVelocity:{x:45,y:5,z:6},eulerAngle:{pitch:70,roll:8,heading:9}}}});await settle()
 await click('Graph');assert.match(app.lastFrame()??'',/IMU graph/);assert.match(app.lastFrame()??'',/X \(m\/s²\).*12.0/)
 await click('■ X');assert.match(app.lastFrame()??'',/□ X/)
 await click('Acceleration');assert.doesNotMatch(app.lastFrame()??'',/Quaternion/);await click('Angular velocity')
 assert.match(app.lastFrame()??'',/■ X \(deg\/s\).*45.0/)
 await click('Angular velocity');await click('Euler angles');assert.match(app.lastFrame()??'',/Pitch \(deg\).*70.0/)
 await click('Euler angles');await click('Acceleration');assert.match(app.lastFrame()??'',/□ X/)
 await click('Parameters');assert.match(app.lastFrame()??'',/Quaternion/);await click('Graph');assert.match(app.lastFrame()??'',/□ X/)
 logs.dispose()
})

test('Play hides Devices, disables Add, and exposes table and graph controls',async()=>{
 const state=structuredClone(initial);state.view='play';state.play={config:{path:'/tmp/test.csv',frequency:1000,maxSpeed:20,maxCurrent:10,endless:false},motors:state.adapters[0].motors,phase:'Ready',logging:false}
 const {app,logs,click,requests}=harness({state});await settle();await settle()
 assert.doesNotMatch(app.lastFrame()??'',/Devices|Item Menu|Add adapter/)
 assert.match(app.lastFrame()??'',/Motor log on/)
 const lines=(app.lastFrame()??'').split('\n'),playbackTop=lines.findIndex(line=>line.includes('Playback')),logsTop=lines.findIndex(line=>line.includes('▼ Logs'))
 assert.ok(logsTop-playbackTop>15,'Playback card retains the available panel height')
 const cardBottom=lines.findLastIndex((line,index)=>index<logsTop&&line.trimStart().startsWith('└'))
 assert.ok(logsTop-cardBottom<=2,'Playback border extends down to the Logs panel')
 const tableBottom=lines.findIndex((line,index)=>index>playbackTop&&/│\s+[└┗]/.test(line))
 assert.ok(tableBottom>playbackTop&&tableBottom-playbackTop<8,'Inner table ends after its rows')
 assert.match(app.lastFrame()??'',/Playback/);assert.doesNotMatch(app.lastFrame()??'',/Tab\/Shift\+Tab|Space\/l\/q|Enter Order/)
 await click('Add');assert.doesNotMatch(app.lastFrame()??'',/Add Motor/)
 await click('Position (deg)');assert.match(app.lastFrame()??'',/Position \(deg\) ▲/)
 await click('Position (deg)');assert.match(app.lastFrame()??'',/Position \(deg\) ▼/)
 const prior=requests.length;app.stdin.write(' ');app.stdin.write('l');app.stdin.write('q');await settle();assert.equal(requests.length,prior)
 await click('Start');assert.ok(requests.some(r=>r.type==='play-start'))
 await click('Graph');assert.match(app.lastFrame()??'',/By motor/);assert.doesNotMatch(app.lastFrame()??'',/Tab\/Shift\+Tab/)
 await click('Table');assert.match(app.lastFrame()??'',/Playback/)
 logs.dispose()
})

test('Play setup keeps CSV label adjacent, uses large numeric inputs and ends with separate checkboxes',async()=>{
 const state=structuredClone(initial);state.view='play'
 const {app,logs,click}=harness({state});await settle();await settle()
 Object.defineProperties(app.stdout,{columns:{value:140,configurable:true},rows:{value:60,configurable:true}});app.stdout.emit('resize');await settle()
 const lines=(app.lastFrame()??'').split('\n'),csv=lines.findIndex(line=>line.includes('CSV file'))
 assert.match(lines[csv+1],/[┌┏]/)
 const fields=lines.findIndex(line=>line.includes('Control frequency'))
 assert.match(lines[fields+1],/[┌┏]/);assert.match(lines[fields+2],/1000/);assert.match(lines[fields+3],/[└┗]/)
 const endless=lines.findIndex(line=>line.includes('Endless')),dry=lines.findIndex(line=>line.includes('Dry run'))
 assert.ok(endless>fields+3&&dry>endless)
 await click('Dry run');assert.match(app.lastFrame()??'',/\[✓\] Dry run/)
 logs.dispose()
})
