import assert from 'node:assert/strict'
import test from 'node:test'
import {execFile,spawn} from 'node:child_process'
import {promisify} from 'node:util'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
const exec=promisify(execFile),entry=new URL('../src/main.ts',import.meta.url).pathname
async function run(args:string[]){
 try{return {...await exec(process.execPath,['--import','tsx',entry,...args,'--json']),code:0}}
 catch(error:any){return {stdout:String(error.stdout),stderr:String(error.stderr),code:error.code}}
}
function records(text:string){
 const rows=text.trim().split('\n').map(line=>JSON.parse(line))
 for(const row of rows){assert.equal(row.schemaVersion,1);assert.equal(typeof row.ok,'boolean');assert.ok(Date.parse(row.timestamp))}
 return rows
}
test('JSON version, help and every command validation have a clean structured stdout',async()=>{
 const version=records((await run(['--version'])).stdout);assert.equal(version.length,1);assert.equal(version[0].data.apiVersion,1)
 for(const command of ['scan','config','control','imu','battery','pms','glove','play','bench','stress','doctor','tui']){
  const help=await run([command,'--help']);assert.equal(help.code,0,help.stderr);assert.match(records(help.stdout)[0].data.text,new RegExp('emcli '+command))
  const bad=await run([command,'--invalid-api-flag']);assert.notEqual(bad.code,0);assert.equal(records(bad.stdout).at(-1).ok,false)
 }
 const unknown=await run(['not-a-command']);assert.equal(records(unknown.stdout)[0].error.code,'EMCLI_UNKNOWN_COMMAND')
})
test('native motor config returns numeric readback and addressed results without native stdout pollution',async()=>{
 const result=await run(['config','Fake:demo:0:1','position'])
 assert.equal(result.code,0,result.stderr)
 const rows=records(result.stdout);assert.equal(rows.length,1)
 assert.equal(rows[0].data.results[0].value.positionDeg,0)
 assert.deepEqual(rows[0].data.results[0].target,{adapterType:'Fake',interfaceName:'demo',slaveId:null,busId:0,motorId:1})
})
test('JSONL dry play streams samples and SIGINT produces a final return result',{timeout:15000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'emcli-json-')),path=join(dir,'motion.csv')
 await writeFile(path,'time,Unavailable:no-hardware:0:1\n0,30\n10,60\n')
 try{
  const child=spawn(process.execPath,['--import','tsx',entry,'play',path,'--dry-run','--endless','--json'],{stdio:['ignore','pipe','pipe']})
  let output='',errors='',signaled=0
  const timer=setTimeout(()=>child.kill('SIGKILL'),11000)
  child.stdout.on('data',chunk=>{output+=chunk;if(!signaled&&output.includes('\n')){signaled=Date.now();child.kill('SIGINT')}})
  child.stderr.on('data',chunk=>{errors+=chunk})
  const code=await new Promise(resolve=>child.on('close',resolve));clearTimeout(timer)
  assert.equal(code,0,errors);assert.ok(Date.now()-signaled>=1800)
  const rows=records(output);assert.ok(rows.length>1)
  assert.ok(rows.slice(0,-1).every(row=>row.type==='sample'))
  assert.equal(rows.at(-1).type,'result');assert.equal(rows.at(-1).data.final,true)
  assert.equal(rows.at(-1).data.motors[0].motorId,1)
 }finally{await rm(dir,{recursive:true,force:true})}
})
test('native stdout is isolated and a worker crash cannot masquerade as success',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'emcli-api-isolation-'))
 try{
  const worker=join(dir,'worker.mjs'),parent=join(dir,'parent.mjs')
  await writeFile(worker,"process.stdout.write('native diagnostic\\n');process.stderr.write('native error\\n');process.exit(7)")
  const moduleUrl=new URL('../src/json-output.ts',import.meta.url).href
  await writeFile(parent,`import {runJsonProcess} from ${JSON.stringify(moduleUrl)};process.exitCode=await runJsonProcess(${JSON.stringify(worker)},[],'scan')`)
  let result:any
  try{result=await exec(process.execPath,['--import','tsx',parent])}catch(error){result=error}
  assert.equal(result.code,7)
  const rows=records(result.stdout);assert.equal(rows.length,1)
  assert.equal(rows[0].error.code,'EMCLI_PROCESS_FAILED')
  assert.match(result.stderr,/native diagnostic/);assert.match(result.stderr,/native error/)
 }finally{await rm(dir,{recursive:true,force:true})}
})
test('sensor JSONL streams stop with a final result on Fake devices',{timeout:15000},async()=>{
 for(const [command,target] of [['imu','Fake:demo:0:1'],['battery','Fake:demo:0:1'],['pms','Fake:demo:0'],['glove','Fake:demo:0']]){
  const child=spawn(process.execPath,['--import','tsx',entry,command,'show',target,'--json'],{stdio:['ignore','pipe','pipe']})
  let output='',errors='',stopped=false
  const timer=setTimeout(()=>child.kill('SIGKILL'),2500)
  child.stdout.on('data',chunk=>{output+=chunk;if(!stopped&&output.includes('"type":"sample"')){stopped=true;child.kill('SIGINT')}})
  child.stderr.on('data',chunk=>{errors+=chunk})
  const code=await new Promise(resolve=>child.on('close',resolve));clearTimeout(timer)
  assert.equal(code,0,command+': '+errors+output)
  const rows=records(output);assert.equal(rows[0].type,'sample')
  assert.equal(rows.at(-1).type,'result');assert.equal(rows.at(-1).ok,true)
 }
})
