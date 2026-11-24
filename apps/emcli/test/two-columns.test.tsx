import assert from 'node:assert/strict'
import test,{afterEach} from 'node:test'
import React from 'react'
import {Box,Text} from 'ink'
import {render,cleanup} from 'ink-testing-library'
import {TwoColumns,useColumnWidth} from '../src/tui/components/TwoColumns.js'
const settle=()=>new Promise(resolve=>setTimeout(resolve,100))
afterEach(cleanup)
test('two columns reflow into source order on narrow parents and recover on resize',async()=>{
 let mounts=0
 function Cell({label}:{label:string}){const [id]=React.useState(()=>++mounts);return <Text>{label} {useColumnWidth()} #{id}</Text>}
 const screen=(width:number)=><Box width={width}><TwoColumns minColumnWidth={40}>{['A','B','C','D'].map(label=><Cell key={label} label={label}/>)}</TwoColumns></Box>
 const app=render(screen(100));await settle()
 assert.match(app.lastFrame()??'',/A 49 #1.*B 49 #2/)
 app.rerender(screen(60));await settle()
 const lines=(app.lastFrame()??'').split('\n').filter(s=>s.trim())
 assert.deepEqual(lines.map(s=>s.trim()),['A 60 #1','B 60 #2','C 60 #3','D 60 #4'])
 app.rerender(screen(100));await settle()
 assert.match(app.lastFrame()??'',/C 49 #3.*D 49 #4/)
 assert.equal(mounts,4)
})
test('zero row gap keeps consecutive rows adjacent while retaining a column gap',async()=>{
 const app=render(<Box width={60}><TwoColumns minColumnWidth={20} gap={2} rowGap={0}>{['A','B','C','D'].map(label=><Text key={label}>{label}</Text>)}</TwoColumns></Box>);await settle()
 const lines=(app.lastFrame()??'').split('\n')
 assert.equal(lines.length,2);assert.match(lines[0],/A\s+B/);assert.match(lines[1],/C\s+D/)
})
test('default row spacing is one line independently of horizontal spacing',async()=>{
 const app=render(<Box width={60}><TwoColumns minColumnWidth={20} gap={4}>{['A','B','C','D'].map(label=><Text key={label}>{label}</Text>)}</TwoColumns></Box>);await settle()
 const lines=(app.lastFrame()??'').split('\n')
 assert.equal(lines.length,3);assert.equal(lines[1].trim(),'')
})
