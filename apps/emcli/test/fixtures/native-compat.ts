import assert from 'node:assert/strict'
import {mkdtemp,readdir,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {openRuntime,createAdapter} from '../../src/runtime.js'
import {loadEmcliNative} from '@encos/emcli-native'
const runtime=await openRuntime(),native=loadEmcliNative()
const directory=await mkdtemp(join(tmpdir(),'emcli-native-log-'))
let exit=0
try {
 // Explicit native Fake targets must initialize their motors without a prior JS adapter.
 const fakeBench=native.bench({motors:[{adapterType:'Fake',interfaceName:'native-auto-create',busId:0,motorId:1}],periodMs:5,attempts:10,warmupMs:0})
 assert.equal(fakeBench.error,'');assert.equal(fakeBench.lost,0);assert.ok(fakeBench.samples.length>0)
 for(const [item,value,commands] of [
  ['slave','0',['NET SETIP 192.168.100.1','CONFIG SAVE','REBOOT']],
  ['mode','ecat',['MODE SET ECAT','CONFIG SAVE','REBOOT']],
  ['ip','192.168.100.253',['NET SETIP 192.168.100.253','CONFIG SAVE','REBOOT']],
 ] as const) assert.deepEqual(native.slave(['config','Ethernet:eth0:0',item,'set',value],false).commands,commands)
 for(const target of ['Ethernet:eth0:0','Ethernet:eth0:1234567890abcdef1234567890abcdef','Ethercat:/dev/ttyACM0','EthercatIGH:/dev/ttyACM1']){
  assert.deepEqual(native.slave(['config',target,'version'],false).commands,['VERSION GET'])
 }
 assert.equal(native.slave(['config','Ethercat:eth0:0:1','position'],false).handled,false)
 assert.deepEqual(native.slave(['config','Ethercat:/dev/ttyACM1','raw','MODE','GET'],false).commands,['MODE GET'])
 assert.equal(native.slave(['config','Ethercat:/dev/ttyACM1','download','firmware with spaces.elf'],false).download,'firmware with spaces.elf')
 for(const args of [
  ['config','Ethernet:eth0:0','download','x.bin'],
  ['config','Ethernet:eth0:0','slave','set','253'],
  ['config','Ethernet:eth0:0','ip','set','10.0.0.1'],
  ['config','Ethercat:/dev/ttyACM1','raw','MODE GET\nREBOOT'],
 ])assert.throws(()=>native.slave(args,false))
 // Invalid extension type must reach the driver on every native entry point.
 const motors=[{adapterType:'Fake',interfaceName:'timing-compat',busId:0,motorId:1}]
 const timing=[] as any
 assert.throws(()=>native.scan({type:'Fake',interfaceName:'timing-compat',timing}),/object/i)
 assert.throws(()=>native.bench({motors,timing,periodMs:1,attempts:1}),/object/i)
 const stress=native.stress({motors,timing,periodMs:1})
 assert.throws(()=>stress.start(),/object/i)
 const options={motors,timing,periodMs:50,motorCount:1,times:[0,1],positions:[0,0]}
 assert.throws(()=>native.play(options).start(),/object/i)
 const adapter=await createAdapter(runtime,{type:'Fake',id:'log-compat'})
 const motor=await adapter.getBus(0).getMotor(1)
 const addresses=[{adapterType:'Fake',interfaceName:'log-compat',busId:0,motorId:1}]
 native.motorLog(addresses,directory);assert.equal(motor.isLogged(),true)
 await motor.posControl({position:1,speed:20,current:1,feedbackType:1})
 await new Promise(r=>setTimeout(r,150))
 native.motorLog(addresses);assert.equal(motor.isLogged(),false)
 const files=await readdir(directory);assert.ok(files.length>0)
 const data=await Promise.all(files.map(file=>readFile(join(directory,file))))
 assert.ok(data.some(bytes=>bytes.length>0),'driver writes log payload, not a UI snapshot')
 adapter.dispose()
 console.log('Native compatibility checks passed')
}catch(error){exit=1;console.error(error)}
finally{await rm(directory,{recursive:true,force:true});runtime.dispose();process.exit(exit)}
