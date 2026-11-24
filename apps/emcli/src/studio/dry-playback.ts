// SPDX-License-Identifier: MIT
import type {NativePlayOptions,NativePlaySession,NativePlayUpdate} from '@encos/emcli-native'
/** Offline trajectory preview. Never loads the native engine or opens an adapter. */
export class DryPlayback implements NativePlaySession {
 private returning?:{time:number;positions:number[]}
 private started=false
 private stopped=false
 private paused=false
 private elapsed=0
 private last=0
 private previous:number[]=[]
 private previousElapsed=0
 constructor(private options:NativePlayOptions,private clock:()=>number=Date.now){}
 start(){if(this.started)throw new Error('Playback is already running');this.started=true;this.last=this.clock()}
 private tick(){const now=this.clock();if(!this.paused&&!this.stopped)this.elapsed+=Math.max(0,now-this.last);this.last=now}
 requestReturn(){
  if(this.returning){this.pause(false);return}
  const snapshot=this.poll()
  if(snapshot.phase>=2){this.pause(false);return}
  this.returning={time:this.elapsed,positions:snapshot.motors.slice(0,this.options.motorCount).map(m=>m.positionRad*180/Math.PI)}
  this.paused=false
 }
 pause(paused:boolean){this.tick();this.paused=paused}
 poll():NativePlayUpdate {
  if(!this.started)throw new Error('Playback is not running')
  this.tick()
  const o=this.options,start=o.startupMs??2000,back=o.returnMs??2000,count=o.motorCount
  const first=o.times[0],duration=(o.times.at(-1)!-first)*1000
  const row=(i:number)=>o.positions.slice(i*count,(i+1)*count)
  const initial=Array<number>(count).fill(0)
  const mix=(a:number[],b:number[],ratio:number)=>a.map((value,i)=>value+(b[i]-value)*ratio)
  let phase=1,positions:number[]
  if(this.returning){
   const ratio=back>0?Math.min(1,(this.elapsed-this.returning.time)/back):1
   phase=ratio<1?2:3;positions=mix(this.returning.positions,initial,ratio)
  }else if(this.elapsed<start){phase=0;positions=mix(initial,row(0),start?this.elapsed/start:1)}
  else if(!o.endless&&this.elapsed>=start+duration){
   phase=o.returnToInitial!==false&&this.elapsed<start+duration+back?2:3
   positions=o.returnToInitial!==false?mix(row(o.times.length-1),initial,back?Math.min(1,(this.elapsed-start-duration)/back):1):row(o.times.length-1)
  }else{
   let time=this.elapsed-start
   if(o.endless&&duration>0){time%=duration*2;if(time>duration)time=duration*2-time}
   const seconds=first+time/1000
   let index=0;while(index<o.times.length-2&&o.times[index+1]<seconds)index++
   positions=o.times.length===1?row(0):mix(row(index),row(index+1),Math.max(0,Math.min(1,(seconds-o.times[index])/(o.times[index+1]-o.times[index]))))
  }
  const dt=(this.elapsed-this.previousElapsed)/1000
  const motors=o.motors.map((m,i)=>{
   const position=(positions[m.trajectoryIndex??i]??0)*Math.PI/180
   const speed=dt>0&&this.previous[i]!==undefined?(position-this.previous[i])/dt:0
   return {slaveId:m.slaveId??null,busId:m.busId,motorId:m.motorId,sent:0,received:0,positionRad:position,feedbackPosition:position,speed,current:0,torque:0,holding:false,motorError:null,motorTemperature:null,mosTemperature:null}
  })
  this.previous=motors.map(m=>m.positionRad);this.previousElapsed=this.elapsed
  return {phase,elapsedMs:this.elapsed,paused:this.paused,sent:0,received:0,motors,error:'',final:this.stopped}
 }
 stop(){const snapshot=this.poll();this.stopped=true;return {...snapshot,final:true}}
 dispose(){this.stopped=true}
 [Symbol.dispose](){this.dispose()}
}
