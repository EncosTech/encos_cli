import assert from 'node:assert/strict'
import test,{afterEach} from 'node:test'
import React from 'react'
import {Box,Text} from 'ink'
import {PassThrough} from 'node:stream'
import {render,cleanup} from 'ink-testing-library'
import {Card,ContextMenu,NavigationProvider,Button} from '../src/tui/index.js'
import {OverlayProvider} from '../src/tui/overlay.js'
import {MouseProvider,type MouseEvent} from '../src/tui/mouse.js'
const wait=()=>new Promise(resolve=>setTimeout(resolve,90))
afterEach(cleanup)
function harness(children:React.ReactNode){
 let mouse=(_event:MouseEvent)=>{}
 const input={stdin:new PassThrough(),onMouse(listener:typeof mouse){mouse=listener;return()=>{}},dispose(){}}
 const app=render(<MouseProvider input={input}><OverlayProvider><NavigationProvider><Box width={60} height={20} flexDirection="column">{children}</Box></NavigationProvider></OverlayProvider></MouseProvider>)
 Object.defineProperties(app.stdout,{columns:{value:60,configurable:true},rows:{value:20,configurable:true}});app.stdout.emit('resize')
 const click=async(label:string,button:'left'|'right'='left')=>{const lines=(app.lastFrame()??'').split('\n'),y=lines.findIndex(line=>line.includes(label));assert.ok(y>=0,`Visible: ${label}`);const event={x:lines[y].indexOf(label)+1,y,button};mouse({...event,action:'press'});await wait();mouse({...event,action:'release'});await wait()}
 return {app,click,mouse:(event:MouseEvent)=>mouse(event)}
}
test('wrapped content keeps its left click; context menu scrolls, skips disabled items and restores focus',async()=>{
 let pressed=0,chosen=-1
 const {app,click,mouse}=harness(<ContextMenu maxHeight={5} items={Array.from({length:8},(_,i)=>({id:String(i),label:`Action ${i}`,disabled:i===1,onSelect:()=>{chosen=i}}))}><Button size="small" autoFocus label="Target" onPress={()=>pressed++}/></ContextMenu>)
 await wait();await click('Target');assert.equal(pressed,1)
 app.stdin.write('\u001b[21;2~');await wait();assert.doesNotMatch(app.lastFrame()??'',/Action 0/);app.stdin.write('\u0000');await wait();await wait();assert.match(app.lastFrame()??'',/Action 0/);assert.doesNotMatch(app.lastFrame()??'',/Action 7/)
 app.stdin.write('\u001b[B');await wait();app.stdin.write('\r');await wait();assert.equal(chosen,2)
 assert.doesNotMatch(app.lastFrame()??'',/Action 0/)
 app.stdin.write('\r');await wait();assert.equal(pressed,2)
 await click('Target','right');app.stdin.write('\u001b[6~');await wait();assert.match(app.lastFrame()??'',/Action 4/)
 mouse({action:'press',button:'left',x:59,y:18});await wait();assert.doesNotMatch(app.lastFrame()??'',/Action 4/)
})
test('collapsible card releases its space and supports keyboard expansion',async()=>{
 const {app,click}=harness(<><Card title="Foldable" height={10} collapsible><Text>Visible content</Text></Card><Text>After card</Text></>)
 await wait();assert.equal((app.lastFrame()??'').split('\n').findIndex(line=>line.includes('After card')),10)
 await click('Foldable');assert.doesNotMatch(app.lastFrame()??'',/Visible content/)
 assert.equal((app.lastFrame()??'').split('\n').findIndex(line=>line.includes('After card')),1)
 app.stdin.write('\r');await wait();assert.match(app.lastFrame()??'',/Visible content/)
})
