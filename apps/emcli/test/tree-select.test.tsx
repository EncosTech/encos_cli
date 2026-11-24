import assert from 'node:assert/strict'
import test,{afterEach} from 'node:test'
import React,{useState} from 'react'
import {Box} from 'ink'
import {PassThrough} from 'node:stream'
import {render,cleanup} from 'ink-testing-library'
import {TreeSelect,Dialog,DialogHost,NavigationProvider,MouseProvider,type MouseEvent,type TreeSelectNode} from '../src/tui/index.js'
import {OverlayProvider} from '../src/tui/overlay.js'
const settle=()=>new Promise(resolve=>setTimeout(resolve,80))
afterEach(cleanup)
const nodes:TreeSelectNode[]=[{value:'a',label:'Adapter A',selectable:false,children:[{value:'s',label:'Slave 0',selectable:false,children:[{value:'b0',label:'Bus 0'},{value:'b1',label:'Bus 1'},{value:'disabled',label:'Disabled bus',disabled:true}]}]}]
test('single tree selection navigates branches, selects leaves, and Escape first closes only the popup',async()=>{
 let current='b0',closed=0
 function Screen(){const [value,setValue]=useState(current);return <DialogHost dialog={<Dialog title="Add device" onClose={()=>closed++}><TreeSelect label="Bus" nodes={nodes} value={value} onChange={v=>{current=v;setValue(v)}}/></Dialog>}><Box/></DialogHost>}
 const app=render(<Box height={30}><NavigationProvider><OverlayProvider><Screen/></OverlayProvider></NavigationProvider></Box>);await settle()
 app.stdin.write('\r');await settle();app.stdin.write('\u001b[A');await settle();app.stdin.write('\u001b[D');await settle()
 assert.equal(current,'b0')
 app.stdin.write('\u001b[C');await settle();app.stdin.write('\u001b[C');await settle();app.stdin.write('\u001b[B');await settle();app.stdin.write('\r');await settle()
 assert.equal(current,'b1');assert.match(app.lastFrame()??'',/Adapter A \/ Slave 0 \/ Bus 1/)
 app.stdin.write('\r');await settle();app.stdin.write('\u001b');await settle();assert.equal(closed,0)
 app.stdin.write('\u001b');await settle();assert.equal(closed,1)
})
test('multi tree selection preserves the cursor, stays open, rejects disabled leaves and scrolls',async()=>{
 let chosen:string[]=[]
 const many:TreeSelectNode[]=[{value:'root',label:'Root',selectable:false,children:Array.from({length:15},(_,i)=>({value:String(i),label:`Item ${i}`,disabled:i===14}))}]
 function Screen(){const [values,setValues]=useState<string[]>([]);return <TreeSelect autoFocus multiple label="Devices" maxHeight={6} nodes={many} values={values} onChange={v=>{chosen=v;setValues(v)}}/>}
 const app=render(<Box height={24}><OverlayProvider><Screen/></OverlayProvider></Box>);await settle();app.stdin.write('\r');await settle();app.stdin.write('\u001b[B');await settle();app.stdin.write(' ');await settle();app.stdin.write('\u001b[B');await settle();app.stdin.write(' ');await settle()
 assert.deepEqual(chosen,['0','1']);assert.match(app.lastFrame()??'',/2 selected/)
 app.stdin.write(' ');await settle();assert.deepEqual(chosen,['0'])
 app.stdin.write('\u001b[F');await settle();app.stdin.write(' ');await settle();assert.deepEqual(chosen,['0']);assert.match(app.lastFrame()??'',/Item 14/)
 app.stdin.write('\u001b[A');await settle();app.stdin.write(' ');await settle();assert.deepEqual(chosen,['0','13'])
})
test('tree popup mouse selects the clicked leaf and a repeated trigger click closes it',async()=>{
 let emit=(_event:MouseEvent)=>{},chosen=''
 const input={stdin:new PassThrough(),onMouse(fn:typeof emit){emit=fn;return()=>{}},dispose(){}}
 function Screen(){const [value,setValue]=useState('');return <TreeSelect autoFocus label="Bus" nodes={nodes} value={value} onChange={v=>{chosen=v;setValue(v)}}/>}
 const app=render(<MouseProvider input={input}><Box height={24}><OverlayProvider><Screen/></OverlayProvider></Box></MouseProvider>);await settle();app.stdin.write('\r');await settle()
 const lines=(app.lastFrame()??'').split('\n'),y=lines.findIndex(l=>l.includes('Bus 1')),x=lines[y].indexOf('Bus 1')+1
 emit({action:'press',button:'left',x,y});await settle();assert.equal(chosen,'b1')
 emit({action:'press',button:'left',x:4,y:2});await settle()
 assert.match(app.lastFrame()??'',/Disabled bus/)
 emit({action:'press',button:'left',x:4,y:2});await settle()
 assert.doesNotMatch(app.lastFrame()??'',/Disabled bus/)
})

test('cascading parents select enabled descendants, show partial state, and clear all even when collapsed',async()=>{
 let chosen:string[]=['one']
 const tree:TreeSelectNode[]=[{value:'root',label:'Adapter',selectable:true,children:[{value:'bus',label:'Bus',selectable:true,children:[{value:'one',label:'Motor 1'},{value:'two',label:'Motor 2'},{value:'disabled',label:'Disabled',disabled:true}]}]}]
 function Screen(){const [values,setValues]=useState(chosen);return <TreeSelect autoFocus multiple cascade label="Motors" nodes={tree} values={values} onChange={v=>{chosen=v;setValues(v)}}/>}
 const app=render(<Box height={24}><OverlayProvider><Screen/></OverlayProvider></Box>);await settle()
 app.stdin.write('\r');await settle();assert.match(app.lastFrame()??'',/\[−\] Adapter/)
 app.stdin.write('\u001b[H');await settle();app.stdin.write(' ');await settle()
 assert.deepEqual(chosen,['one','two']);assert.match(app.lastFrame()??'',/\[✓\] Adapter/)
 app.stdin.write('\u001b[D');await settle();app.stdin.write(' ');await settle()
 assert.deepEqual(chosen,[]);assert.match(app.lastFrame()??'',/\[ \] Adapter/)
 app.stdin.write(' ');await settle();assert.deepEqual(chosen,['one','two'])
 app.stdin.write('\u001b[C');await settle();app.stdin.write('\u001b[B');await settle();app.stdin.write(' ');await settle()
 assert.deepEqual(chosen,[])
})
