import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createStudioClient} from '../../src/studio/client.js'
import {createLogStore} from '../../src/tui/log-store.js'
const tty=(pid:number)=>Number(readFileSync(`/proc/${pid}/stat`,'utf8').split(') ')[1].split(' ')[4])
const logs=createLogStore(),client=createStudioClient(logs,{demo:true})
try{
 await client.request({type:'interfaces'})
 const children=readFileSync(`/proc/${process.pid}/task/${process.pid}/children`,'utf8').trim().split(/\s+/).map(Number)
 assert.notEqual(tty(process.pid),0,'The test itself must have a controlling terminal')
 assert.equal(children.length,1)
 assert.equal(tty(children[0]),0,'Native workers and pkexec descendants must not share the TUI controlling terminal')
 console.log('Detached driver terminal verified')
}finally{await client.close();logs.dispose()}
