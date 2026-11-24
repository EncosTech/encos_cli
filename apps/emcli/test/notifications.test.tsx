import assert from 'node:assert/strict'
import test,{afterEach} from 'node:test'
import React from 'react'
import {Box,Text} from 'ink'
import {PassThrough} from 'node:stream'
import {render,cleanup} from 'ink-testing-library'
import {NotificationProvider,useNotifications,NavigationProvider,Dialog,DialogHost} from '../src/tui/index.js'
import {MouseProvider,type MouseEvent} from '../src/tui/mouse.js'
const wait=(ms=70)=>new Promise(resolve=>setTimeout(resolve,ms))
afterEach(cleanup)
function setup(){
 let notify!:ReturnType<typeof useNotifications>['notify'],mouse=(_event:MouseEvent)=>{}
 let underlyingCloses=0
 function Probe(){({notify}=useNotifications());return <DialogHost dialog={<Dialog title="Underlying dialog" onClose={()=>underlyingCloses++}><Text>Form</Text></Dialog>}><Text>Background</Text></DialogHost>}
 const input={stdin:new PassThrough(),onMouse(listener:typeof mouse){mouse=listener;return()=>{}},dispose(){}}
 const app=render(<MouseProvider input={input}><NavigationProvider><Box width={80} height={24}><NotificationProvider><Probe/></NotificationProvider></Box></NavigationProvider></MouseProvider>)
 Object.defineProperties(app.stdout,{columns:{value:80,configurable:true},rows:{value:24,configurable:true}});app.stdout.emit('resize')
 const point=(label:string)=>{const lines=(app.lastFrame()??'').split('\n'),y=lines.findIndex(line=>line.includes(label));assert.ok(y>=0,`Visible: ${label}`);return{x:lines[y].indexOf(label)+1,y}}
 return {app,notify:(message:string,timeout:number)=>notify(message,{timeout}),point,mouse:(event:MouseEvent)=>mouse(event),closes:()=>underlyingCloses}
}
test('hover pauses notification expiry including its nested expand button, then resumes remaining time',async()=>{
 const h=setup();await wait()
 h.notify('A long notification message that cannot fit in one short preview line.',450);await wait()
 h.mouse({action:'move',button:'other',...h.point('Expand')})
 await wait(550);assert.match(h.app.lastFrame()??'',/Expand/)
 h.mouse({action:'move',button:'other',x:0,y:0})
 await wait(100);assert.match(h.app.lastFrame()??'',/Expand/)
 await wait(450);assert.doesNotMatch(h.app.lastFrame()??'',/Expand/)
})
test('expanded notification exposes full multiline text, pauses expiry and isolates the underlying dialog',async()=>{
 const h=setup();await wait()
 h.notify('First line\nSecond line\nLast line is available in full.',300);await wait()
 h.mouse({action:'press',button:'left',...h.point('Expand')});await wait()
 assert.match(h.app.lastFrame()??'',/Notification details/)
 assert.match(h.app.lastFrame()??'',/Last line is available in full/)
 await wait(400);assert.match(h.app.lastFrame()??'',/Notification details/)
 h.app.stdin.write('\u001b');await wait()
 assert.doesNotMatch(h.app.lastFrame()??'',/Notification details/)
 assert.equal(h.closes(),0)
 assert.match(h.app.lastFrame()??'',/Underlying dialog/)
})

test('notification details copy only dragged text with shortcut and right-click, without a copy button',async()=>{
 const h=setup();await wait()
 h.notify('First line\nFull notification body with instructions beyond the preview.',0);await wait()
 h.mouse({action:'press',button:'left',...h.point('Expand')});await wait()
 assert.doesNotMatch(h.app.lastFrame()??'',/Copy all|Right-click or/)
 const first=h.point('First line'), second=h.point('Full notification')
 const begin={x:first.x-1,y:first.y}, end={x:second.x-1+4,y:second.y}
 h.mouse({action:'press',button:'left',...begin});await wait()
 h.mouse({action:'move',button:'left',...end});await wait()
 h.mouse({action:'release',button:'left',...end});await wait()
 const clipboard='\u001b]52;c;'+Buffer.from('First line\nFull').toString('base64')+'\u0007'
 h.app.stdin.write('\u001b[99;6u');await wait()
 assert.ok(h.app.frames.some(frame=>frame.includes(clipboard)))
 assert.match(h.app.lastFrame()??'',/Copy request sent to terminal/)
 const before=h.app.frames.filter(frame=>frame.includes(clipboard)).length
 h.mouse({action:'press',button:'right',...h.point('First line')});await wait()
 assert.ok(h.app.frames.filter(frame=>frame.includes(clipboard)).length>before)
 assert.match(h.app.lastFrame()??'',/Notification details/)
})
