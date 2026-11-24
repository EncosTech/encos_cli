// SPDX-License-Identifier: MIT
import type {MotorWrapper} from '@encos/encos-driver-native'
import {MotorControlLoop} from './motor-control.js'
import type {ControlCommand,Telemetry} from './protocol.js'
export class BatchControl {
 keys:string[]=[]
 command?:ControlCommand
 private graph=false
 private loops=new Map<string,MotorControlLoop>()
 constructor(private lookup:(key:string)=>MotorWrapper|undefined,private sample:(sample:Telemetry)=>void,private failed:(key:string,error:unknown)=>void,private dispatch:(task:()=>Promise<void>)=>Promise<void>){}
 private validate(keys=this.keys){if(keys.some(key=>!this.lookup(key)))throw new Error('Selected motor no longer exists')}
 setSelection(keys:string[]){
  this.validate(keys);this.keys=[...new Set(keys)]
  for(const [key,loop] of this.loops)if(!this.keys.includes(key)){loop.dispose();this.loops.delete(key)}
  if(!this.keys.length){this.command=undefined;return}
  if(this.command||this.graph)this.sync()
 }
 private sync(){
  this.validate()
  for(const key of this.keys){
   if(this.loops.has(key))continue
   const loop=new MotorControlLoop(this.sample,error=>{this.stop();this.failed(key,error)},this.dispatch)
   loop.select(key,this.lookup(key));this.loops.set(key,loop)
   if(this.command)loop.apply(this.command)
   loop.setGraphActive(this.graph)
  }
 }
 apply(command:ControlCommand){
  this.validate();if(!this.keys.length)throw new Error('Select at least one motor')
  this.command=structuredClone(command);this.sync();for(const loop of this.loops.values())loop.apply(command)
 }
 setGraphActive(active:boolean){this.graph=active;if(active)this.sync();for(const loop of this.loops.values())loop.setGraphActive(active)}
 disable(){this.command=undefined;for(const loop of this.loops.values())loop.disable()}
 stop(){this.command=undefined;this.graph=false;for(const loop of this.loops.values())loop.dispose();this.loops.clear()}
}
