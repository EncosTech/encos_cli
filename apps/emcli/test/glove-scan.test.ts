import assert from 'node:assert/strict'
import test from 'node:test'
import {scanAdapter} from '../src/studio/scan.js'
import type {AdapterInfo} from '../src/studio/protocol.js'
import type {NativeScanOptions} from '@encos/emcli-native'
const adapter:AdapterInfo={key:'a',type:'Ethercat',interfaceName:'eth0',buses:[...Array.from({length:8},(_,busId)=>({slaveId:null,busId})),...Array.from({length:5},(_,busId)=>({slaveId:1,busId}))],motors:[],devices:[{key:'g',adapterKey:'a',slaveId:1,busId:null,deviceId:1,kind:'glove',origin:'scan'}]}
test('glove and normal buses share one parallel native scan without rewriting slave addresses',()=>{
 const calls:NativeScanOptions[]=[]
 const result=Array.from({length:8},(_,busId)=>({slaveId:null,busId,motorId:busId+1,canfd:false,eff:false}))
 const native={scan(options:NativeScanOptions){calls.push(options);return result}}
 assert.deepEqual(scanAdapter(native,adapter),result)
 assert.deepEqual(calls,[{type:'Ethercat',interfaceName:'eth0'}])
 assert.equal(scanAdapter(native,adapter,{slaveId:1,busId:0}).length,0)
 assert.equal(calls.length,1)
})
test('slave-only scan filters actual addresses instead of relabelling all buses',()=>{
 const calls:NativeScanOptions[]=[]
 const native={scan(options:NativeScanOptions){calls.push(options);return [0,2].map(slaveId=>({slaveId:slaveId||null,busId:0,motorId:1,canfd:false,eff:false}))}}
 const result=scanAdapter(native,adapter,{slaveId:2})
 assert.deepEqual(result.map(r=>r.slaveId),[2]);assert.equal(calls[0].slaveId,undefined)
})
test('native Fake scan finds every ordinary bus while glove encoder buses are registered', {timeout:20000},async()=>{
 const {openRuntime,createAdapter}=await import('../src/runtime.js')
 const {loadEmcliNative}=await import('@encos/emcli-native')
 const runtime=await openRuntime()
 try{
  const handle=await createAdapter(runtime,{type:'Fake',id:'glove-scan-regression'},{},undefined,{fakeAutoCreate:false})
  const control=handle.getFakeAdapterControl()!
  const model=runtime.stringToMotorModel(runtime.getAllMotorModelStrings()[0])
  for(const slave of [0,2])for(let bus=0;bus<8;bus++)control.seedMotor((slave<<16)|bus,bus+1,model)
  const glove=handle.getGlove(1)
  assert.ok(glove)
  const info={...adapter,type:'Fake',interfaceName:'glove-scan-regression'}
  const rows=scanAdapter(loadEmcliNative(),info)
  assert.deepEqual(rows.map(r=>[r.slaveId,r.busId,r.motorId]),[0,2].flatMap(slave=>Array.from({length:8},(_,bus)=>[slave||null,bus,bus+1])))
 }finally{runtime.dispose()}
})
