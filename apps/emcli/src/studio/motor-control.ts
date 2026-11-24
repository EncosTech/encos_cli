// SPDX-License-Identifier: MIT
import {MotorStopMode,type MotorWrapper} from '@encos/encos-driver-native'
import {degreesToRadians,radiansToDegrees} from '../format.js'
import type {ControlCommand,Telemetry} from './protocol.js'

/** Commands request full feedback without waiting for it; only the status callback emits samples. */
export class MotorControlLoop {
 command?:ControlCommand
 private motor?:MotorWrapper
 private key?:string
 private graph=false
 private timer?:ReturnType<typeof setInterval>
 private generation=0
 private kt=NaN
 private pending=false
 constructor(private sample:(value:Telemetry)=>void,private failed:(error:unknown)=>void,private dispatch:(task:()=>Promise<void>)=>Promise<void>=task=>task()){}
 select(key?:string,motor?:MotorWrapper){
  if(key===this.key&&motor===this.motor)return
  this.stop();this.motor?.setOnStatus(null);this.motor=motor;this.key=key;this.kt=motor?.getProperties().kt??NaN
  if(motor&&key)motor.setOnStatus(status=>{
   if(this.motor!==motor||this.key!==key||(!this.command&&!this.graph))return
   const finite=(n:number)=>Number.isFinite(n)?n:undefined
   const kt=this.kt
   this.sample({motorKey:key,timestamp:Date.now(),position:finite(radiansToDegrees(status.position)),speed:finite(status.speed),current:finite(status.current),power:finite(status.current*kt*status.speed),motorTemperature:finite(status.motorTemperature),mosTemperature:finite(status.mosTemperature),error:status.error===255?undefined:status.error})
  })
 }
 apply(command:ControlCommand){if(!this.motor)throw new Error('Select a motor first');this.command=structuredClone(command);this.restart()}
 disable(){this.command=undefined;this.restart()}
 setGraphActive(active:boolean){this.graph=active;this.restart()}
 stop(){this.command=undefined;this.graph=false;this.generation++;clearInterval(this.timer);this.timer=undefined}
 private restart(){
  this.generation++;clearInterval(this.timer);this.timer=undefined
  if(this.motor&&(this.command||this.graph))this.timer=setInterval(()=>{
   if(this.pending)return
   this.pending=true
   void this.dispatch(()=>this.send()).catch(error=>{this.stop();this.failed(error)}).finally(()=>{this.pending=false})
  },50)
 }
 private async send(){
  const motor=this.motor,command=this.command??(this.graph?{mode:'pvt' as const,values:[0,0,0,0,0]}:undefined),generation=this.generation
  if(!motor||!command)return
  const v=command.values,feedback={feedbackType:0,feedback:1}
  try{
   const result=(()=>{switch(command.mode){
    case 'pvt':return motor.pvtControl({kp:v[0],kd:v[1],position:degreesToRadians(v[2]),speed:v[3],torque:v[4],...feedback})
    case 'position':return motor.posControl({position:degreesToRadians(v[0]),speed:v[1],current:v[2],...feedback})
    case 'speed':return motor.spdControl({speed:v[0],current:v[1],...feedback})
    case 'current':return motor.curControl({current:v[0],...feedback})
    case 'torque':return motor.torControl({torque:v[0],...feedback})
    case 'stop':return motor.stop({mode:command.stopMode==='dynamic'?MotorStopMode.DynamicBrake:command.stopMode==='regenerative'?MotorStopMode.RegenerativeBrake:MotorStopMode.FullBrake,current:v[0],...feedback})
   }})()
   if(!(await result).ok)throw new Error('The driver rejected the control command')
  }catch(error){if(this.generation===generation){this.stop();this.failed(error)}}
 }
 dispose(){this.stop();this.motor?.setOnStatus(null);this.motor=undefined;this.key=undefined}
}
