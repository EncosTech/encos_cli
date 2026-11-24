import assert from 'node:assert/strict'
import test,{afterEach} from 'node:test'
import React,{useState} from 'react'
import {Box} from 'ink'
import {PassThrough} from 'node:stream'
import {render,cleanup} from 'ink-testing-library'
import {TreeList,MouseProvider,toggleTreeSelection,type TreeNode,type MouseEvent} from '../src/tui/index.js'
const settle=()=>new Promise(r=>setTimeout(r,90))
afterEach(cleanup)
const nodes:TreeNode[]=[{id:'adapter',label:'Adapter',children:[{id:'bus',label:'Bus',children:[{id:'m1',label:'Motor 1'},{id:'m2',label:'Motor 2'}]}]}]
test('parent text toggles descendants, triangle and Enter expand, Space toggles collapsed descendants',async()=>{
 let emit=(_event:MouseEvent)=>{},chosen:string[]=[]
 const input={stdin:new PassThrough(),onMouse(fn:typeof emit){emit=fn;return()=>{}},dispose(){}}
 function Screen(){const [checked,setChecked]=useState<string[]>([]);return <TreeList borderless compact nodes={nodes} checkedIds={checked} onToggle={node=>{chosen=toggleTreeSelection(node,checked);setChecked(chosen)}}/>}
 const app=render(<MouseProvider input={input}><Box width={50} height={15}><Screen/></Box></MouseProvider>);await settle()
 const click=async(label:string,triangle=false)=>{const lines=(app.lastFrame()??'').split('\n'),y=lines.findIndex(line=>line.includes(label));assert.ok(y>=0);const x=triangle?lines[y].indexOf('▼'):lines[y].indexOf(label)+1;emit({action:'press',button:'left',x,y});await settle();emit({action:'release',button:'left',x,y});await settle()}
 await click('Adapter');assert.deepEqual(chosen,['m1','m2']);assert.match(app.lastFrame()??'',/\[✓\] Adapter/);assert.match(app.lastFrame()??'',/Motor 2/)
 await click('Motor 1');assert.deepEqual(chosen,['m2']);assert.match(app.lastFrame()??'',/\[−\] Adapter/);assert.match(app.lastFrame()??'',/\[−\] Bus/)
 await click('Adapter',true);assert.deepEqual(chosen,['m2']);assert.doesNotMatch(app.lastFrame()??'',/Motor 2/)
 app.stdin.write(' ');await settle();assert.deepEqual(chosen,['m2','m1']);assert.doesNotMatch(app.lastFrame()??'',/Motor 2/)
 app.stdin.write('\r');await settle();assert.match(app.lastFrame()??'',/Motor 2/);assert.deepEqual(chosen,['m2','m1'])
 await click('Bus');assert.deepEqual(chosen,[]);assert.match(app.lastFrame()??'',/Motor 2/)
})
test('a subtree toggle preserves selection in other branches and never selects transport IDs',()=>{
 assert.deepEqual(toggleTreeSelection(nodes[0].children![0],['other','m1']),['other','m1','m2'])
 assert.deepEqual(toggleTreeSelection(nodes[0],['other','m1','m2']),['other'])
})
