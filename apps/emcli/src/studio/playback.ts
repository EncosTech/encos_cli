// SPDX-License-Identifier: MIT
import {loadEmcliNative,type NativePlaySession,type NativePlayMotor,type NativePlayUpdate,type NativePlayOptions} from '@encos/emcli-native'
import {DryPlayback} from './dry-playback.js'
import {resolve} from 'node:path'
import type {Trajectory} from '../trajectory.js'
import type {Event,PlayConfig,PlayState,MotorAddress} from './protocol.js'
export function validatePlayConfig(config:PlayConfig){
 if(!config.path.trim())throw new Error('Choose a CSV file')
 if(!Number.isInteger(config.frequency)||config.frequency<1||config.frequency>1_000_000_000)throw new Error('Control frequency must be between 1 and 1000000000 Hz')
 if(!Number.isFinite(config.maxSpeed)||config.maxSpeed<=0||!Number.isFinite(config.maxCurrent)||config.maxCurrent<=0)throw new Error('Maximum speed and current must be positive')
}
export class Playback {
 state?:PlayState
 private session?:NativePlaySession
 private trajectory?:Trajectory
 private addresses:NativePlayMotor[]=[]
 private history:Array<{time:number;sent:number[];received:number[]}>=[]
 constructor(private emit:(event:Event)=>void){}
 load(config:PlayConfig,trajectory:Trajectory,motors:MotorAddress[],addresses:NativePlayMotor[]){
  this.stop();this.trajectory=trajectory;this.addresses=addresses
  this.state={config,motors,phase:'Ready',logging:false};this.publish()
 }
 start(){
  if(!this.state||!this.trajectory)throw new Error('Load a trajectory first')
  if(this.session)throw new Error('Playback is already running')
  const c=this.state.config,t=this.trajectory
  const options:NativePlayOptions={motors:this.addresses,motorCount:t.motors.length,times:t.samples.map(s=>s.timeSec),positions:t.samples.flatMap(s=>s.positionsDeg),periodMs:1000/c.frequency,startupMs:2000,returnMs:2000,endless:c.endless,returnToInitial:true,usePvt:false,maxSpeed:c.maxSpeed,maxCurrent:c.maxCurrent}
  const session=c.dryRun?new DryPlayback(options):loadEmcliNative().play(options)
  try{session.start();this.session=session;this.history=[];this.poll()}catch(error){session.dispose();this.session=undefined;throw error}
 }
 pause(){if(!this.session)throw new Error('Playback is not running');this.session.pause(!this.state?.snapshot?.paused);this.poll()}
 logging(){
  if(!this.state)throw new Error('Load a trajectory first')
  if(this.state.config.dryRun)throw new Error('Motor logs are unavailable in dry run')
  const path=this.state.logging?undefined:resolve(this.state.config.logDirectory??'logs')
  loadEmcliNative().motorLog(this.addresses,path)
  this.state.logging=!this.state.logging;this.state.logPath=path;this.publish()
 }
 private closeLogs(){if(this.state?.logging)this.logging()}

 poll(){
  if(!this.session)return
  try{
   const update=this.session.poll();this.update(update)
   if(update.error||update.phase>=3){this.session.dispose();this.session=undefined;this.closeLogs();if(update.error)this.emit({type:'log',level:'error',message:`Play: ${update.error}`})}
  }catch(error){try{this.stop()}catch{};if(this.state){this.state.phase='Error';this.publish()}this.emit({type:'log',level:'error',message:`Play: ${(error as Error).message}`})}
 }
 requestReturn(){if(this.session){this.session.requestReturn();this.poll()}}
 stop(){try{this.closeLogs()}finally{if(this.session){const session=this.session;this.session=undefined;try{this.update(session.stop());if(this.state)this.state.phase='Stopped'}finally{session.dispose();this.publish()}}}}
 private update(snapshot:NativePlayUpdate){
  if(!this.state)return
  const now=Date.now()
  this.history.push({time:now,sent:snapshot.motors.map(m=>m.sent),received:snapshot.motors.map(m=>m.received)})
  while(this.history.length>1&&this.history[1].time<=now-3000)this.history.shift()
  const base=this.history[0]
  this.state={...this.state,snapshot,phase:snapshot.error?'Error':snapshot.paused?'Paused':['Starting','Playing','Returning','Finished','Error'][snapshot.phase]??'Stopped',window:snapshot.motors.map((m,i)=>({sent:m.sent-(base.sent[i]??0),received:m.received-(base.received[i]??0)}))}
  for(const [i,m] of snapshot.motors.entries()){
   const motor=this.state.motors[i];if(!motor)continue
   this.emit({type:'telemetry',sample:{motorKey:motor.key,timestamp:now,position:m.feedbackPosition==null?undefined:m.feedbackPosition*180/Math.PI,speed:m.speed??undefined,current:m.current??undefined,power:m.torque==null||m.speed==null?undefined:m.torque*m.speed,motorTemperature:m.motorTemperature??undefined,mosTemperature:m.mosTemperature??undefined,error:m.motorError??undefined}})
  }

  this.publish()
 }
 private publish(){if(this.state)this.emit({type:'play',state:structuredClone(this.state)})}
}
