import assert from 'node:assert/strict'
import test from 'node:test'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {fileURLToPath} from 'node:url'
const exec=promisify(execFile)
test('driver worker cannot read the TUI controlling terminal even when started over a PTY',{skip:process.platform!=='linux',timeout:15000},async()=>{
 const quote=(value:string)=>"'"+value.replaceAll("'","'\\''")+"'"
 const fixture=fileURLToPath(new URL('./fixtures/studio-terminal-probe.ts',import.meta.url))
 const result=await exec('script',['-qec',`${quote(process.execPath)} --import tsx ${quote(fixture)}`,'/dev/null'],{timeout:12000})
 assert.match(result.stdout,/Detached driver terminal verified/)
})

test('a stalled driver is terminated on request timeout and cannot accept queued retries',async()=>{
 const {fork}=await import('node:child_process')
 const {once}=await import('node:events')
 const {connectWorker}=await import('../src/studio/client.js')
 const {createLogStore}=await import('../src/tui/log-store.js')
 const logs=createLogStore(),child=fork(fileURLToPath(new URL('./fixtures/stalled-driver.cjs',import.meta.url)),[],{stdio:['ignore','pipe','pipe','ipc'],execArgv:[]})
 const exited=once(child,'exit')
 const client=connectWorker(child,logs,{requestTimeoutMs:100})
 try{
  await Promise.all([
   assert.rejects(client.request({type:'interfaces'}),/timed out/),
   assert.rejects(client.request({type:'add',adapterType:'Fake',interfaceName:'pending'}),/timed out/),
  ])
  await Promise.race([exited,new Promise((_,reject)=>{const t=setTimeout(()=>reject(new Error('Worker still alive after timeout')),1500);t.unref()})])
  await assert.rejects(client.request({type:'interfaces'}),/offline/)
 }finally{child.kill('SIGKILL');await client.close();logs.dispose()}
})

test('timeout cleans up the isolated driver process group including blocked helpers',{skip:process.platform!=='linux'},async()=>{
 const {fork}=await import('node:child_process')
 const {once}=await import('node:events')
 const {readFile}=await import('node:fs/promises')
 const {connectWorker}=await import('../src/studio/client.js')
 const {createLogStore}=await import('../src/tui/log-store.js')
 const logs=createLogStore(),child=fork(fileURLToPath(new URL('./fixtures/stalled-driver-tree.cjs',import.meta.url)),[],{detached:true,stdio:['ignore','pipe','pipe','ipc'],execArgv:[]})
 const [{descendant}]=await once(child,'message')
 const exited=once(child,'exit'),client=connectWorker(child,logs,{requestTimeoutMs:100,processGroup:true})
 try{
  await assert.rejects(client.request({type:'interfaces'}),/timed out/)
  await exited
  let alive=true
  for(let attempt=0;attempt<100&&alive;attempt++){
   try{const state=(await readFile(`/proc/${descendant}/stat`,'utf8')).split(') ')[1].split(' ')[0];alive=state!=='Z'&&state!=='X'}catch{alive=false}
   if(alive)await new Promise(resolve=>setTimeout(resolve,10))
  }
  assert.equal(alive,false,'A blocked helper survived the driver timeout')
 }finally{try{process.kill(-child.pid!,'SIGKILL')}catch{}await client.close();logs.dispose()}
})
