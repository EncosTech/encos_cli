import assert from 'node:assert/strict'
import test,{afterEach} from 'node:test'
import React from 'react'
import {Box} from 'ink'
import {render,cleanup} from 'ink-testing-library'
import {PassThrough} from 'node:stream'
import {Checkbox,FilePicker,Table,Button} from '../src/tui/index.js'
import {MouseProvider,type MouseEvent} from '../src/tui/mouse.js'
import {OverlayProvider} from '../src/tui/overlay.js'
const wait=()=>new Promise(r=>setTimeout(r,100))
afterEach(cleanup)
function harness(node:React.ReactNode){
 let mouse=(_e:MouseEvent)=>{}
 const input={stdin:new PassThrough(),onMouse(fn:typeof mouse){mouse=fn;return()=>{}},dispose(){}}
 const app=render(<MouseProvider input={input}><OverlayProvider><Box width={100} height={36} flexDirection="column">{node}</Box></OverlayProvider></MouseProvider>)
 setTimeout(()=>{Object.defineProperties(app.stdout,{columns:{value:120,configurable:true},rows:{value:40,configurable:true}});app.stdout.emit('resize')},20)
 const click=async(label:string)=>{const lines=(app.frames.findLast(frame=>frame.includes(label))??'').split('\n'),y=lines.findIndex(l=>l.includes(label));assert.ok(y>=0,label+': '+app.lastFrame());mouse({action:'press',button:'left',x:lines[y].indexOf(label)+1,y});await wait()}
 return {app,click}
}
test('checkbox toggles using mouse and Space',async()=>{
 const values:boolean[]=[]
 const {app,click}=harness(<Checkbox label="Endless" checked={false} onChange={v=>values.push(v)}/>)
 await wait();await click('Endless');app.stdin.write(' ');await wait();assert.deepEqual(values,[true,true])
})
test('file picker browses directories and confirms a CSV selection',async()=>{
 const selected:string[]=[],visited:string[]=[]
 const {app,click}=harness(<FilePicker initialPath="/root" list={async path=>{visited.push(path);return {path,parent:'/root',entries:path==='/root'?[{name:'motions',path:'/root/motions',directory:true}]:[{name:'walk.csv',path:'/root/motions/walk.csv',directory:false}]}}} onSelect={path=>selected.push(path)} onClose={()=>{}}/>)
 await wait();await wait();await click('motions');await wait();await wait();assert.ok(visited.includes('/root/motions'))
 await click('walk.csv');app.stdin.write('\r');await wait();assert.deepEqual(selected,['/root/motions/walk.csv'])
})
test('column headers are focusable: click and Enter sort, Tab only moves focus',async()=>{
 const sorts:number[]=[]
 const {app,click}=harness(<Box flexDirection="column"><Table autoColumns viewportWidth={60} rows={['row']} rowKey={r=>r} height={20} columns={[{key:'a',header:'First',width:16,value:r=>r},{key:'b',header:'Last',width:16,value:()=> 'end'}]} onSort={column=>sorts.push(column)}/><Button size="small" label="After"/></Box>)
 await wait();await click('First');assert.deepEqual(sorts,[0])
 app.stdin.write('\r');await wait();assert.deepEqual(sorts,[0,0])
 app.stdin.write('\t');await wait();assert.deepEqual(sorts,[0,0])
 app.stdin.write('\r');await wait();assert.deepEqual(sorts,[0,0,1])
 app.stdin.write(' ');app.stdin.write('l');app.stdin.write('q');await wait();assert.deepEqual(sorts,[0,0,1])
 const lines=app.lastFrame()!.split('\n'),row=lines.findIndex(line=>line.includes('row'))
 assert.match(lines[row+1],/[└┗]/)
})
test('automatic columns keep full titles and size loss columns to their contents',async()=>{
 const {app}=harness(<Table autoColumns viewportWidth={80} rows={['0/0 (0.00%)']} rowKey={r=>r} height={30} columns={[{key:'p',header:'Position (deg)',width:4,value:()=>'-'},{key:'loss',header:'Loss',width:30,value:r=>r},{key:'end',header:'Role',width:10,value:()=> 'Trajectory'}]} onSort={()=>{}}/>)
 await wait();const frame=app.frames.findLast(f=>f.includes('Position (deg)'))!
 const header=frame.split('\n').find(l=>l.includes('Position (deg)'))!
 assert.ok(header.indexOf('Role')-header.indexOf('Loss')<20,header)
 assert.doesNotMatch(header,/…/)
})

test('directory clicks preserve list focus and Go keeps button focus after loading',async()=>{
 const selected:string[]=[],visited:string[]=[]
 const {app,click}=harness(<FilePicker initialPath="/root" list={async path=>{visited.push(path);await new Promise(r=>setTimeout(r,30));return {path,parent:'/root',entries:path==='/root'?[{name:'数据',path:'/root/数据',directory:true}]:[{name:'ignore.txt',path:'/root/数据/ignore.txt',directory:false},{name:'a.csv',path:'/root/数据/a.csv',directory:false},{name:'b.CSV',path:'/root/数据/b.CSV',directory:false}]}}} onSelect={path=>selected.push(path)} onClose={()=>{}}/>)
 await wait();await wait();await click('数据');await wait();await wait()
 assert.ok(visited.includes('/root/数据'));assert.doesNotMatch(app.lastFrame()??'',/ignore.txt/)
 app.stdin.write('\u001b[B');await wait();app.stdin.write('\r');await wait();assert.deepEqual(selected,['/root/数据/b.CSV'])
 await click('Go');await wait();const count=visited.length;app.stdin.write('\r');await wait();await wait();assert.equal(visited.length,count+1)
 app.stdin.write('x');await wait();assert.doesNotMatch(app.lastFrame()??'',/x\/root|数据x/)
})
test('wide and combining characters occupy one table row and stay inside borders',async()=>{
 const names=['公共/','图片/','非常长的中文目录名称不会折行/','émoji👩‍💻/']
 const {app}=harness(<Table rows={names} height={4} rowKey={r=>r} columns={[{key:'name',header:'Name',width:18,value:r=>r}]}/>)
 await wait();const frame=app.frames.findLast(f=>f.includes('公共'))!,lines=frame.split('\n')
 const row=lines.findIndex(line=>line.includes('公共'))
 assert.match(lines[row+1],/图片/);assert.match(lines[row+2],/非常长/);assert.match(lines[row+3],/moji/)
 assert.match(lines[row+4],/[└┗]/)
 const {default:stringWidth}=await import('string-width')
 assert.ok(lines.slice(row,row+4).every(line=>stringWidth(line.trimEnd())===stringWidth(lines[row].trimEnd())))
})
