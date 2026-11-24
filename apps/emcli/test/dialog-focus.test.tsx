import assert from 'node:assert/strict'
import test,{afterEach} from 'node:test'
import React,{useState} from 'react'
import {Box,useFocusManager} from 'ink'
import {render,cleanup} from 'ink-testing-library'
import {Button,TextInput,Dialog,DialogHost,NavigationProvider,LoadingOverlay} from '../src/tui/index.js'
import {NotificationInteractionBlocked} from '../src/tui/interaction.js'
const settle=()=>new Promise(resolve=>setTimeout(resolve,80))
afterEach(cleanup)
test('dialogs focus the first enabled form control and restore the opener on close',async()=>{
 let value='',saved=0
 function Screen(){const [open,setOpen]=useState(false),[text,setText]=useState('');return <DialogHost dialog={open?<Dialog title="Form" onClose={()=>setOpen(false)} onConfirm={()=>saved++}><Button label="Disabled" disabled/><TextInput value={text} onChange={next=>{value=next;setText(next)}}/></Dialog>:undefined}><Button label="Open" autoFocus onPress={()=>setOpen(true)}/></DialogHost>}
 const app=render(<NavigationProvider><Box width={80} height={24}><Screen/></Box></NavigationProvider>);await settle()
 app.stdin.write('\r');await settle();app.stdin.write('abc');await settle();assert.equal(value,'abc');assert.equal(saved,0)
 app.stdin.write('\u001b');await settle();assert.doesNotMatch(app.lastFrame()??'',/Form/)
 app.stdin.write('\r');await settle();assert.match(app.lastFrame()??'',/Form/)
})
test('loading overlays restore the triggering control instead of always jumping to autoFocus',async()=>{
 let close!:()=>void,starts=0,visible=false,active:string|undefined
 function Probe(){active=useFocusManager().activeId;return null}
 const until=async(check:()=>boolean)=>{const deadline=Date.now()+1500;while(!check()&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));assert.ok(check(),'Focus transition did not finish')}
 function Screen(){const [loading,setLoading]=useState(false);visible=loading;close=()=>setLoading(false);return <DialogHost dialog={loading?<LoadingOverlay label="Wait"/>:undefined}><Button label="First" autoFocus/><Button label="Load" onPress={()=>{starts++;setLoading(true)}}/></DialogHost>}
 const app=render(<NavigationProvider><Probe/><Screen/></NavigationProvider>)
 await until(()=>Boolean(active));const first=active
 app.stdin.write('\t');await until(()=>Boolean(active)&&active!==first);const opener=active;await settle()
 app.stdin.write('\r');await until(()=>starts===1&&visible)
 close();await until(()=>active===opener&&!visible);await settle()
 app.stdin.write('\r');await until(()=>starts===2)
})
test('confirmation without inputs starts on Cancel and does not confirm on Enter',async()=>{
 let closed=0,confirmed=0
 const app=render(<NavigationProvider><Dialog title="Confirm" onClose={()=>closed++} onConfirm={()=>confirmed++}/></NavigationProvider>);await settle();app.stdin.write('\r');await settle()
 assert.equal(closed,1);assert.equal(confirmed,0)
})

test('nested modal restores the last field rather than resetting the parent form',async()=>{
 let open!:()=>void,first='',second=''
 function Screen(){const [nested,setNested]=useState(false),[a,setA]=useState(''),[b,setB]=useState('');open=()=>setNested(true);return <><NotificationInteractionBlocked.Provider value={nested}><Dialog title="Parent" onClose={()=>{}}><TextInput value={a} onChange={v=>{first=v;setA(v)}}/><TextInput value={b} onChange={v=>{second=v;setB(v)}}/></Dialog></NotificationInteractionBlocked.Provider>{nested?<Dialog title="Child" onClose={()=>setNested(false)}/>:null}</>}
 const app=render(<NavigationProvider><Screen/></NavigationProvider>);await settle();app.stdin.write('a');await settle();app.stdin.write('\t');await settle();app.stdin.write('b');await settle()
 assert.equal(first,'a');assert.equal(second,'b')
 open();await settle();app.stdin.write('ignored');await settle();assert.equal(second,'b')
 app.stdin.write('\u001b');await settle();app.stdin.write('c');await settle()
 assert.equal(second,'bc');assert.equal(first,'a')
})
