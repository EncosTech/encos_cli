import assert from 'node:assert/strict'
import test from 'node:test'
import {DryPlayback} from '../src/studio/dry-playback.js'
const options={motors:[{adapterType:'Offline',interfaceName:'none',busId:0,motorId:1,trajectoryIndex:0}],motorCount:1,times:[0,1],positions:[0,90],periodMs:50,startupMs:0,returnMs:1000,returnToInitial:true}
test('dry preview interpolates, pauses, returns and finishes without packet counts',()=>{
 let now=0;const session=new DryPlayback(options,()=>now);session.start()
 now=500;let result=session.poll();assert.ok(Math.abs(result.motors[0].feedbackPosition!-Math.PI/4)<.001)
 session.pause(true);now=900;assert.equal(session.poll().elapsedMs,500)
 session.pause(false);now=1400;assert.equal(session.poll().phase,2)
 now=1900;result=session.poll();assert.ok(Math.abs(result.motors[0].feedbackPosition!-Math.PI/4)<.001)
 now=2400;result=session.poll();assert.equal(result.phase,3);assert.equal(result.sent,0);assert.equal(result.received,0)
})
test('endless dry preview reverses the trajectory and does not finish',()=>{
 let now=0;const session=new DryPlayback({...options,endless:true},()=>now);session.start()
 now=1500;const result=session.poll();assert.equal(result.phase,1);assert.ok(Math.abs(result.motors[0].feedbackPosition!-Math.PI/4)<.001)
 assert.equal(session.stop().final,true)
})

test('Start ramps to CSV start and Stop returns smoothly even while paused',()=>{
 let now=0;const session=new DryPlayback({...options,positions:[90,180],startupMs:2000},()=>now);session.start()
 now=1000;assert.ok(Math.abs(session.poll().motors[0].positionRad-Math.PI/4)<.001)
 session.pause(true);now=1500;session.requestReturn()
 let result=session.poll();assert.equal(result.phase,2);assert.equal(result.paused,false)
 assert.ok(Math.abs(result.motors[0].positionRad-Math.PI/4)<.001)
 now=2000;assert.ok(Math.abs(session.poll().motors[0].positionRad-Math.PI/8)<.001)
 session.requestReturn() // Repeated Stop does not restart the return transition.
 now=2500;result=session.poll();assert.equal(result.phase,3);assert.equal(result.motors[0].positionRad,0)
})
