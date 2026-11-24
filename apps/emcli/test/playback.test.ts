import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,writeFile,readFile,readdir,rm,mkdir} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {fork} from 'node:child_process'
import {listFiles} from '../src/studio/files.js'
import {validatePlayConfig} from '../src/studio/playback.js'
import {connectWorker} from '../src/studio/client.js'
import {createLogStore} from '../src/tui/log-store.js'
import type {PlayState,SessionState,Telemetry} from '../src/studio/protocol.js'
const wait=(ms:number)=>new Promise(r=>setTimeout(r,ms))
test('file listing accepts files, folders and CSV extensions and preserves folder order',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'emcli-files-'))
 try{
  await mkdir(join(dir,'folder'));await writeFile(join(dir,'a.CSV'),'');await writeFile(join(dir,'ignore.txt'),'')
  const files=await listFiles(join(dir,'a.CSV'))
  assert.equal(files.path,dir);assert.deepEqual(files.entries.map(e=>e.name),['folder','a.CSV']);assert.equal(files.entries[0].directory,true)
  await assert.rejects(listFiles(join(dir,'missing')))
 }finally{await rm(dir,{recursive:true,force:true})}
})
test('play settings reject invalid rates and limits before connecting',()=>{
 const config={path:'a.csv',endless:false,frequency:1000,maxSpeed:20,maxCurrent:10}
 for(const frequency of [0,NaN,1_000_000_001,1.5])assert.throws(()=>validatePlayConfig({...config,frequency}),/frequency/)
 assert.throws(()=>validatePlayConfig({...config,maxCurrent:0}),/positive/)
 assert.doesNotThrow(()=>validatePlayConfig({...config,frequency:60}))
})
test('native Play loads without motion, plays degrees, pauses its clock, logs, and stops on view changes',{timeout:40000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'emcli-play-')),path=join(dir,'motion.csv')
 await writeFile(path,'time,Fake:play-test:0:1\n0,30\n1,30\n')
 const logs=createLogStore({flushIntervalMs:0}),worker=fork(new URL('../src/studio/driver-worker.ts',import.meta.url),[],{stdio:['ignore','pipe','pipe','ipc'],execArgv:['--import','tsx']})
 const client=connectWorker(worker,logs),samples:Telemetry[]=[];let latest:PlayState|undefined
 const unsubscribe=client.subscribe(e=>{if(e.type==='play')latest=e.state;if(e.type==='telemetry')samples.push(e.sample)})
 try{
  await client.request({type:'view',view:'play'})
  await assert.rejects(client.request({type:'add',adapterType:'Fake',interfaceName:'forbidden'}),/unavailable/)
  const loaded=await client.request<PlayState>({type:'play-load',config:{path,logDirectory:join(dir,'logs'),endless:true,frequency:60,maxSpeed:20,maxCurrent:10}})
  assert.equal(loaded.phase,'Ready');assert.ok(loaded.motors.length>=1);await wait(150);assert.equal(samples.length,0)
  await client.request({type:'play-start'});await wait(700)
  assert.ok(samples.some(s=>s.position!==undefined&&s.position>0&&s.position<25),'startup must ramp to CSV start')
  await wait(1700)
  assert.ok(samples.some(s=>s.position!==undefined&&Math.abs(s.position-30)<.1),JSON.stringify(samples.slice(-3)))
  assert.equal(latest?.phase,'Playing')
  await client.request({type:'play-pause'});await wait(100)
  const elapsed=latest!.snapshot!.elapsedMs,sent=latest!.snapshot!.sent
  await wait(250);assert.ok(Math.abs(latest!.snapshot!.elapsedMs-elapsed)<40);assert.ok(latest!.snapshot!.sent>sent)
  const logging=await client.request<PlayState>({type:'play-log'});await wait(200)
  await client.request({type:'play-log'})
  const motorFiles=await readdir(logging.logPath!)
  assert.ok(motorFiles.length>0,'driver creates motor log files')
  assert.ok(motorFiles.every(name=>!name.endsWith('.jsonl')))
  await client.request({type:'play-pause'});await wait(150);assert.ok(latest!.snapshot!.elapsedMs>elapsed)
  await client.request({type:'play-pause'})
  await client.request({type:'play-stop'});await wait(500)
  assert.equal(latest?.phase,'Returning')
  const returning=latest!.snapshot!.motors[0].positionRad
  assert.ok(returning>0&&returning<30*Math.PI/180)
  await wait(1800);assert.equal(latest?.phase,'Finished')
  await client.request({type:'play-start'});await wait(100)
  const state=await client.request<SessionState>({type:'view',view:'single'});assert.equal(state.play?.phase,'Stopped')
  const count=samples.length;await wait(250);assert.equal(samples.length,count)
  await assert.rejects(client.request({type:'play-start'}),/Play view/)
  await client.request({type:'view',view:'play'})
  await client.request({type:'play-load',config:{path,endless:false,frequency:20,maxSpeed:20,maxCurrent:10}})
  await client.request({type:'play-start'});await wait(5500)
  assert.equal(latest?.phase,'Finished');const finalCount=samples.length;await wait(200);assert.equal(samples.length,finalCount)
  await writeFile(join(dir,'bad.csv'),'time,Fake:play-test:0:1,Fake:play-test:0:1\n0,1,2\n')
  await assert.rejects(client.request({type:'play-load',config:{path:join(dir,'bad.csv'),endless:false,frequency:20,maxSpeed:20,maxCurrent:10}}),/duplicate/)

 }finally{unsubscribe();await client.close();logs.dispose();await rm(dir,{recursive:true,force:true})}
})

test('dry playback loads an unavailable adapter name without connecting and emits preview samples',{timeout:10000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'emcli-dry-')),path=join(dir,'motion.csv')
 await writeFile(path,'time,OfflineOnly:no-hardware:0:1\n0,30\n1,60\n')
 const logs=createLogStore({flushIntervalMs:0}),worker=fork(new URL('../src/studio/driver-worker.ts',import.meta.url),[],{stdio:['ignore','pipe','pipe','ipc'],execArgv:['--import','tsx']})
 const client=connectWorker(worker,logs),samples:Telemetry[]=[]
 const off=client.subscribe(e=>{if(e.type==='telemetry')samples.push(e.sample)})
 try{
  await client.request({type:'view',view:'play'})
  const loaded=await client.request<PlayState>({type:'play-load',config:{path,dryRun:true,endless:false,frequency:20,maxSpeed:20,maxCurrent:10}})
  assert.equal(loaded.adapters?.[0].type,'OfflineOnly')
  await client.request({type:'play-start'});await wait(300);assert.ok(samples.length>0)
  const stopped=await client.request<PlayState>({type:'play-stop'});assert.equal(stopped.snapshot?.sent,0);assert.equal(stopped.snapshot?.received,0)
  const state=await client.request<SessionState>({type:'view',view:'single'});assert.deepEqual(state.adapters,[])
 }finally{off();await client.close();logs.dispose();await rm(dir,{recursive:true,force:true})}
})
