#!/usr/bin/env node
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {mkdtemp,copyFile,chmod,writeFile,rm,readdir,realpath,mkdir} from 'node:fs/promises'
import {readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
const expectedVersion=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version
const source=resolve(process.argv[2]||`dist/emcli-${process.platform}-${process.arch}${process.platform==='win32'?'.exe':''}`)
const dir=await mkdtemp(join(tmpdir(),'emcli-single-test-')),binary=join(dir,process.platform==='win32'?'emcli.exe':'emcli'),cache=join(dir,'cache')
await copyFile(source,binary);await chmod(binary,0o755)
const cwd=join(dir,'readonly');await mkdir(cwd,{mode:0o555})
const env={...process.env,PATH:'',NODE_PATH:'',NODE_OPTIONS:'',EMCLI_SEA_CACHE:cache}
for(const key of ['EMCLI_PERF_ADDON','EMCLI_NATIVE_ROOT','EMCLI_JSON_WORKER','EMCLI_STUDIO_OPTIONS','LD_LIBRARY_PATH','ENCOS_DRIVER_PLUGIN_PATH'])delete env[key]
let passed=0
async function run(args,{interrupt=false,expected=0,timeout=15000}={}){
 const child=spawn(binary,[...args,'--json'],{cwd,env,stdio:['ignore','pipe','pipe']})
 let stdout='',stderr='',interruptedAt=0
 const started=Date.now(),timer=setTimeout(()=>child.kill('SIGKILL'),timeout)
 child.stdout.on('data',chunk=>{
  stdout+=chunk
  if(interrupt&&!interruptedAt&&stdout.includes('"type":"sample"')){
   if(process.platform==='linux'&&(args[0]==='control'||args[0]==='stress')){
    const children=readFileSync(`/proc/${child.pid}/task/${child.pid}/children`,'utf8').trim().split(/\s+/)
    const libraries=children.flatMap(pid=>readFileSync(`/proc/${pid}/maps`,'utf8').split('\n')).filter(line=>/libencosdriver.*\.so/.test(line))
    assert.ok(libraries.length,'Native driver must actually be loaded')
    for(const line of libraries)assert.ok(line.slice(line.indexOf('/')).startsWith(cache+'/'),line)
   }
   interruptedAt=Date.now();child.kill('SIGINT')
  }
 })
 child.stderr.on('data',chunk=>{stderr+=chunk})
 const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve)})
 clearTimeout(timer)
 assert.equal(code,expected,`${args.join(' ')}\n${stdout}\n${stderr}`)
 const rows=stdout.trim().split('\n').map(line=>JSON.parse(line))
 assert.ok(rows.length)
 for(const row of rows)assert.equal(row.schemaVersion,1)
 const final=rows.at(-1)
 assert.notEqual(final.type,'sample');assert.equal(final.ok,expected===0)
 if(interrupt){assert.ok(interruptedAt);assert.ok(rows.length>1)}
 passed++;console.log(`PASS ${args.join(' ')} (${Date.now()-started} ms)`)
 return {rows,final,elapsedAfterInterrupt:Date.now()-interruptedAt,stderr}
}
try{
 for(let attempt=0;attempt<2;attempt++){
  const result=(await run(['--version'])).final.data
  assert.equal(result.apiVersion,1)
  assert.equal(result.version,expectedVersion) // cold and warm standalone caches
 }
 for(const command of ['scan','config','control','imu','battery','pms','glove','bench','stress','play','doctor','tui'])await run([command,'--help'])
 await run(['not-a-command'],{expected:1})
 await run(['scan','Fake:single:0'])
 await run(['config','Fake:single:0:1','position'])
 const position=await run(['config','Fake:single:0:1','position','set','12.5'])
 assert.ok(Math.abs(position.final.data.results[0].value.positionDeg-12.5)<0.01)
 await run(['config','Fake:single:0:1','pvt-kp-range'])
 await run(['config','Fake:single:0:1','cur-pi','set','1','2'])
 await run(['control','brake','Fake:single:0:1','engage'])
 for(const values of [['pvt','1','1','0','0','0'],['position','10','20','1'],['speed','1','1'],['current','1'],['torque','0.1'],['stop','full']]){
  const [mode,...parameters]=values
  await run(['control',mode,'Fake:single:0:1',...parameters],{interrupt:true})
 }
 for(const [command,target] of [['imu','Fake:single:0:1'],['battery','Fake:single:0:1'],['pms','Fake:single:0'],['glove','Fake:single:0']])await run([command,'show',target],{interrupt:true})
 await run(['imu','start','Fake:single:0'])
 await run(['imu','stop','Fake:single:0'])
 await run(['battery','clear','Fake:single:0:1'])
 await run(['pms','enable','Fake:single:0','V48_1'])
 await run(['pms','disable','Fake:single:0','V48_1'])
 const calibration=await run(['glove','calibrate','Fake:single:0','all'],{expected:1})
 assert.equal(calibration.final.data.message,'Calibration timed out') // Fake does not emulate glove calibration acknowledgement.
 const bench=await run(['bench','Fake:single:0:1','--periods','5','--attempts','10','--warmup-ms','0'])
 assert.ok(bench.final.data.reports.length)
 const stress=await run(['stress','Fake:single:0:1','--warmup-delay-ms','0'],{interrupt:true})
 assert.equal(stress.final.data.final,true)
 const csv=join(dir,'motion.csv')
 await writeFile(csv,'time,Fake:single:0:1\n0,0\n0.1,5\n')
 const play=await run(['play',csv,'--endless','--control-frequency','20','--log='+join(dir,'logs')],{interrupt:true})
 assert.ok(play.elapsedAfterInterrupt>=1800,'Play must complete its smooth return')
 assert.ok((await readdir(join(dir,'logs'))).length,'Native motor log files must exist')
 // Every embedded dependency link must remain within the self-contained cache.
 async function checkLinks(path){
  for(const item of await readdir(path,{withFileTypes:true})){
   const file=join(path,item.name)
   if(item.isSymbolicLink())assert.ok((await realpath(file)).startsWith(cache+'/'),file)
   else if(item.isDirectory())await checkLinks(file)
  }
 }
 await checkLinks(cache)
 console.log(`Single executable: ${passed} cases passed; empty PATH, read-only CWD, isolated cache, embedded native driver libraries, no external package links.`)
}finally{await rm(dir,{recursive:true,force:true})}
