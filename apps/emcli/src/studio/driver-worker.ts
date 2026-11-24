// SPDX-License-Identifier: MIT
import { NativeSession } from './native-session.js'
import type { RequestMessage } from './protocol.js'
const send=(message:unknown)=>{if(process.connected)process.send?.(message)}
const options=JSON.parse(process.env.EMCLI_STUDIO_OPTIONS??'{}')
const session=new NativeSession(send,options)
const ready=session.initialize()
void ready.catch(()=>{})
let closing=false
process.on('message',async(message:RequestMessage)=>{
 if(!message||!Number.isInteger(message.id)||!message.request)return
 try{
  await ready
  const value=await session.request(message.request)
  if(message.request.type==='shutdown'){
   closing=true
   process.send?.({id:message.id,ok:true,value},()=>process.exit(0))
  }else send({id:message.id,ok:true,value})
 }catch(error){const action=message.request.type+('item' in message.request?` ${message.request.item}`:'');send({id:message.id,ok:false,error:`${action}: ${error instanceof Error?error.message:String(error)}`})}
})
const stop=()=>{
 if(closing)return;closing=true
 const timer=setTimeout(()=>process.exit(1),3000);timer.unref()
 void ready.then(()=>session.request({type:'shutdown'})).catch(()=>{}).finally(()=>process.exit(0))
}
process.on('disconnect',stop)
process.on('SIGTERM',stop)
process.on('SIGINT',stop)
