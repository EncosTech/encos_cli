import assert from 'node:assert/strict'
import test,{afterEach} from 'node:test'
import React from 'react'
import {Box} from 'ink'
import {render,cleanup} from 'ink-testing-library'
import {SettingEditor,ControlPanel} from '../src/studio/MotorPanels.js'
import {SETTINGS} from '../src/studio/catalog.js'
import {NotificationProvider} from '../src/tui/index.js'
import {OverlayProvider} from '../src/tui/overlay.js'
const settle=()=>new Promise(r=>setTimeout(r,100))
afterEach(cleanup)
test('settings use two lines including fields and buttons; communication is a compact selector',async()=>{
 for(const setting of SETTINGS){
  const app=render(<Box width={110} flexDirection="column"><NotificationProvider><SettingEditor setting={setting} values={setting.fields.map(()=>setting.id==='comm'?'can':'1')} onChange={()=>{}} run={async()=>{}} enabled width={110}/></NotificationProvider></Box>);await settle()
  assert.equal(app.lastFrame()?.split('\n').length,2,setting.id+': '+app.lastFrame())
  if(setting.id==='comm')assert.match(app.lastFrame()??'',/CAN.*▼.*Apply/)
  app.unmount()
 }
})
test('Status shows applied command rather than drafts and a missing reply as a dash',async()=>{
 const props={run:async()=>{},enabled:true,width:100,drafts:{pvt:[99,99,99,99,99]},setDrafts:()=>{},motor:{key:'m',adapterKey:'a',slaveId:null,busId:0,motorId:1,canfd:false,eff:false}}
 const app=render(<Box width={100} height={45}><OverlayProvider><ControlPanel {...props} command={{mode:'pvt',values:[1,2,3,4,5]}}/></OverlayProvider></Box>);await settle()
 assert.match(app.lastFrame()??'',/Command Kp\s+1.000/)
 assert.match(app.lastFrame()??'',/Position \(deg\)\s+-/)
 assert.match(app.lastFrame()??'',/Disable/);assert.doesNotMatch(app.lastFrame()??'',/Read ranges/)
})

test('Batch Position retains Reset zero without a Read button',async()=>{
 const setting=SETTINGS.find(s=>s.id==='position')!
 const app=render(<Box width={110}><NotificationProvider><SettingEditor setting={setting} batch values={['0']} onChange={()=>{}} run={async()=>{}} enabled width={110}/></NotificationProvider></Box>)
 await settle();assert.match(app.lastFrame()??'',/Reset zero/);assert.doesNotMatch(app.lastFrame()??'',/Read/)
})
