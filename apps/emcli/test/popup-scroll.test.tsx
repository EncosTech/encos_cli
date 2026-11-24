import assert from 'node:assert/strict'
import test, {afterEach} from 'node:test'
import React from 'react'
import {Box} from 'ink'
import {render,cleanup} from 'ink-testing-library'
import {PassThrough} from 'node:stream'
import {Dropdown,MenuBar,MouseProvider,type MouseEvent} from '../src/tui/index.js'
import {OverlayProvider} from '../src/tui/overlay.js'
const settle=()=>new Promise(resolve=>setTimeout(resolve,80))
afterEach(cleanup)
const options=Array.from({length:20},(_,i)=>({value:String(i),label:`Option ${String(i).padStart(2,'0')}`}))
function mouse(){
 let emit=(_event:MouseEvent)=>{}
 return {input:{stdin:new PassThrough(),onMouse(fn:typeof emit){emit=fn;return()=>{}},dispose(){}},emit:(event:MouseEvent)=>emit(event)}
}
test('dropdown maxHeight clips rows, reveals keyboard selection and commits the correct item',async()=>{
 let selected=''
 const app=render(<Box height={24}><OverlayProvider><Dropdown autoFocus label="Options" maxHeight={6} value="0" options={options} onChange={value=>{selected=value}}/></OverlayProvider></Box>)
 await settle();app.stdin.write('\r');await settle()
 assert.match(app.lastFrame()??'',/Option 03/);assert.doesNotMatch(app.lastFrame()??'',/Option 04/)
 assert.match(app.lastFrame()??'',/┃/)
 app.stdin.write('\u001b[F');await settle();assert.match(app.lastFrame()??'',/Option 19/)
 app.stdin.write('\r');await settle();assert.equal(selected,'19')
})
test('dropdown wheel and scrollbar dragging map click coordinates through the scroll offset',async()=>{
 const pointer=mouse();let selected=''
 const app=render(<MouseProvider input={pointer.input}><Box height={24}><OverlayProvider><Dropdown autoFocus label="Options" maxHeight={6} width={30} value="0" options={options} onChange={value=>{selected=value}}/></OverlayProvider></Box></MouseProvider>)
 await settle();app.stdin.write('\r');await settle()
 let frame=app.lastFrame()??'', top=frame.split('\n').findIndex(line=>line.includes('├'))
 pointer.emit({action:'wheel',button:'wheel-down',x:4,y:top+2});await settle()
 assert.match(app.lastFrame()??'',/Option 06/)
 pointer.emit({action:'press',button:'left',x:4,y:top+1});await settle();assert.equal(selected,'3')
 app.stdin.write('\r');await settle()
 frame=app.lastFrame()??'';top=frame.split('\n').findIndex(line=>line.includes('├'))
 const lines=frame.split('\n'),thumbY=lines.findIndex(line=>line.includes('┃')),thumbX=lines[thumbY].indexOf('┃')
 pointer.emit({action:'press',button:'left',x:thumbX,y:thumbY});await settle()
 pointer.emit({action:'move',button:'left',x:thumbX,y:top+4});await settle()
 pointer.emit({action:'release',button:'left',x:thumbX,y:top+4});await settle()
 assert.match(app.lastFrame()??'',/Option 19/)
 pointer.emit({action:'press',button:'left',x:4,y:top+4});await settle();assert.equal(selected,'19')
})
test('menu maxHeight supports scrolling and skips disabled items and separators',async()=>{
 const pointer=mouse();let selected=-1
 const menus=[{id:'file',label:'File',maxHeight:5,items:options.map((option,i)=>({id:option.value,label:option.label,disabled:i===1,separator:i===2,onSelect:()=>{selected=i}}))}]
 const app=render(<MouseProvider input={pointer.input}><Box height={24}><OverlayProvider><MenuBar autoFocus menus={menus}/></OverlayProvider></Box></MouseProvider>)
 await settle();app.stdin.write('\r');await settle()
 assert.doesNotMatch(app.lastFrame()??'',/Option 03/)
 app.stdin.write('\u001b[B');await settle();assert.match(app.lastFrame()??'',/Option 03/)
 app.stdin.write('\r');await settle();assert.equal(selected,3)
 app.stdin.write('\r');await settle();app.stdin.write('\u001b[F');await settle()
 assert.match(app.lastFrame()??'',/Option 19/)
 app.stdin.write('\u001b[H');await settle()
 const top=(app.lastFrame()??'').split('\n').findIndex(line=>line.includes('┏'))
 pointer.emit({action:'wheel',button:'wheel-down',x:5,y:top+2});await settle()
 pointer.emit({action:'press',button:'left',x:5,y:top+1});await settle()
 assert.equal(selected,3)
})
test('open dropdown adapts to terminal height changes without overflowing',async()=>{
 const app=render(<Box height={24}><OverlayProvider><Dropdown autoFocus label="Options" maxHeight={30} value="0" options={options} onChange={()=>{}}/></OverlayProvider></Box>)
 await settle();app.stdin.write('\r');await settle()
 Object.defineProperties(app.stdout,{rows:{value:10,configurable:true}});app.stdout.emit('resize');await settle()
 const frame=app.lastFrame()??'',lines=frame.split('\n')
 const bottom=lines.findIndex(line=>line.includes('└'))
 assert.ok(bottom<10 && bottom>=0)
 app.stdin.write('\u001b[F');await settle();assert.match(app.lastFrame()??'',/Option 19/)
})
