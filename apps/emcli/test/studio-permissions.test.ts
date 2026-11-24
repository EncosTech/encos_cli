import assert from 'node:assert/strict'
import test from 'node:test'
import {ensureSshAdapterPermissions} from '../src/studio/permissions.js'
const ssh={platform:'linux',uid:1000,env:{SSH_CONNECTION:'remote local'}}
const target='/runtime/lib/encosPlugins/EthercatFdBrokerExecutable'
const missing=async()=>({required:true,authorized:false,missing:[{target,capabilities:['cap_net_raw','cap_net_admin']}]})
test('headless SSH refuses missing EtherCAT permissions before attempting native authentication',async()=>{
 await assert.rejects(ensureSshAdapterPermissions('Ethercat',{...ssh,inspect:missing}),error=>{
  assert.match(String(error),/doctor --request-permissions/)
  assert.match(String(error),/without --json/)
  assert.ok(String(error).includes(target));return true
 })
})
test('authorized EtherCAT helpers work even if unrelated helpers lack capabilities',async()=>{
 await ensureSshAdapterPermissions('Ethercat',{...ssh,inspect:async()=>({required:true,authorized:false,missing:[{target:'/runtime/EthernetXdpBrokerExecutable',capabilities:['cap_bpf']}]})})
})
test('Fake, non-Linux, root and desktop sessions retain existing behavior',async()=>{
 const inspect=async():Promise<never>=>{throw new Error('Should not inspect permissions')}
 await ensureSshAdapterPermissions('Fake',{...ssh,inspect})
 for(const options of [{...ssh,platform:'win32'},{...ssh,uid:0},{...ssh,env:{DISPLAY:':0'}},{...ssh,env:{}}])await ensureSshAdapterPermissions('Ethercat',{...options,inspect})
})
