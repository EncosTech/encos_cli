import assert from 'node:assert/strict'
import test from 'node:test'
import {execFile,spawn} from 'node:child_process'
import {promisify} from 'node:util'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {parseArgs,flagNumberValue} from '../src/args.js'
import {parseImuControlTarget} from '../src/target.js'
import {commandHelpText} from '../src/help.js'
import {validatePlayConfig} from '../src/studio/playback.js'
const exec=promisify(execFile),entry=new URL('../src/main.ts',import.meta.url).pathname
test('negative positional and option values retain their numeric meaning',()=>{
 const args=parseArgs(['control','pvt','Fake:demo:0:1','1','1','-30','-.5','-1e-3'])
 assert.deepEqual(args.positionals,['pvt','Fake:demo:0:1','1','1','-30','-.5','-1e-3'])
 assert.equal(args.flags.size,0)
 assert.equal(flagNumberValue(parseArgs(['play','a.csv','--vel','-2']),'vel'),-2)
})
test('IMU forwarding accepts legacy indexed addresses and ignores only device ID',()=>{
 assert.deepEqual(parseImuControlTarget('Ethercat:eth0:7'),{adapterType:'Ethercat',adapterId:'eth0',busId:7})
 assert.deepEqual(parseImuControlTarget('Ethercat:eth0:7:0'),{adapterType:'Ethercat',adapterId:'eth0',busId:7})
 assert.deepEqual(parseImuControlTarget('Ethercat:eth0:3:7:9'),{adapterType:'Ethercat',adapterId:'eth0',slaveId:3,busId:7})
})
test('subcommand help covers its operations without obsolete UI switches',()=>{
 for(const command of ['scan','config','control','imu','battery','pms','glove','play','bench','stress','tui','doctor']){
  const text=commandHelpText(command)
  assert.match(text,new RegExp('emcli '+command))
  assert.doesNotMatch(text,/no-inplace-refresh|Press q/)
 }
 assert.match(commandHelpText('config',['Ethernet:eth0:0','download']),/firmware.*elf/)
 assert.doesNotMatch(commandHelpText('bench'),/--canfd/)
})
test('CLI rejects removed options before opening hardware',async()=>{
 for(const args of [['bench','Fake:x','--canfd'],['play','missing.csv','--no-inplace-refresh'],['stress','Fake:x','--no-inplace-refresh']]){
  await assert.rejects(exec(process.execPath,['--import','tsx',entry,...args]),error=>{assert.match(String((error as any).stderr),/未知选项/);return true})
 }
})
test('TUI accepts the legacy positive integer play frequency range',()=>{
 const config={path:'a.csv',endless:false,frequency:2000,maxSpeed:20,maxCurrent:10}
 assert.doesNotThrow(()=>validatePlayConfig(config))
 assert.doesNotThrow(()=>validatePlayConfig({...config,frequency:1e9}))
 assert.throws(()=>validatePlayConfig({...config,frequency:1e9+1}))
})
test('offline CLI play uses plain text and first SIGINT completes the return phase',{timeout:15000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'emcli-cli-dry-')),path=join(dir,'motion.csv')
 await writeFile(path,'time,Unavailable:no-hardware:0:1\n0,30\n10,60\n')
 try{
  const child=spawn(process.execPath,['--import','tsx',entry,'play',path,'--dry-run','--endless'],{stdio:['ignore','pipe','pipe']})
  let output='',errors='',signaledAt=0
  const timer=setTimeout(()=>child.kill('SIGKILL'),10000)
  child.stdout.on('data',chunk=>{output+=chunk;if(!signaledAt&&output.includes('PLAY STATUS')){signaledAt=Date.now();child.kill('SIGINT')}})
  child.stderr.on('data',chunk=>{errors+=chunk})
  const code=await new Promise<number|null>(resolve=>child.on('exit',resolve));clearTimeout(timer)
  assert.equal(code,0,errors);assert.ok(Date.now()-signaledAt>=1800,'Stop must finish its 2 s return')
  assert.doesNotMatch(output,/\x1b\[/);assert.match(output,/sent=0 received=0/)
 }finally{await rm(dir,{recursive:true,force:true})}
})
test('native gateway parsing, timing propagation and motor log lifecycle',{timeout:20000},async()=>{
 const {stdout}=await exec(process.execPath,['--import','tsx',new URL('./fixtures/native-compat.ts',import.meta.url).pathname],{timeout:18000})
 assert.match(stdout,/Native compatibility checks passed/)
})
