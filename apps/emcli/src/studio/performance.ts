// SPDX-FileCopyrightText: 2026 Encos
// SPDX-License-Identifier: MIT
import type {EmcliNativeApi,NativeStressSession} from '@encos/emcli-native'
import type {AdapterInfo,Event,TestScope,PerformanceUpdate} from './protocol.js'
import {summarizeSamples,dropRate} from '../stats.js'

export function testScopeKey(scope: TestScope) {
  const address = [scope.adapterKey, scope.slaveId === undefined ? 'adapter' : scope.slaveId, scope.busId ?? null]
  if (scope.dexHandKey !== undefined) address.push(scope.dexHandKey)
  return JSON.stringify(address)
}

function matchesBus(scope: TestScope, bus: { slaveId: number | null; busId: number }) {
  return (scope.slaveId === undefined || (bus.slaveId ?? 0) === (scope.slaveId ?? 0)) &&
    (scope.busId === undefined || bus.busId === scope.busId)
}

export function scopedMotors(adapter: AdapterInfo, scope: TestScope) {
  if (adapter.key !== scope.adapterKey) return []
  return adapter.motors.filter(motor =>
    matchesBus(scope, motor) &&
    (scope.dexHandKey === undefined || motor.dexHandKey === scope.dexHandKey) &&
    !adapter.devices.some(device => device.kind === 'glove' && (device.slaveId ?? 0) === (motor.slaveId ?? 0)),
  )
}

export function testMotors(adapter: AdapterInfo, scope: TestScope, motorKeys?: string[]) {
  if (scope.busId !== undefined && scope.slaveId === undefined) throw new Error('Bus tests require a slave address')
  if (adapter.key !== scope.adapterKey || !adapter.buses.some(bus => matchesBus(scope, bus))) {
    throw new Error('Test target no longer exists')
  }
  if (scope.slaveId !== undefined && adapter.devices.some(device => device.kind === 'glove' && (device.slaveId ?? 0) === (scope.slaveId ?? 0))) {
    throw new Error('Glove slaves cannot run motor tests')
  }
  const available = scopedMotors(adapter, scope)
  const selected = motorKeys === undefined ? undefined : new Set(motorKeys)
  if (motorKeys?.some(key => !available.some(motor => motor.key === key))) {
    throw new Error('Selected motor no longer exists in this target')
  }
  const motors = selected === undefined ? available : available.filter(motor => selected.has(motor.key))
  if (!motors.length) throw new Error('No motors in this target')
  return motors.map(motor => ({
    adapterType: adapter.type,
    interfaceName: adapter.interfaceName,
    ...(motor.slaveId === null ? {} : { slaveId: motor.slaveId }),
    busId: motor.busId,
    motorId: motor.motorId,
    canfd: motor.canfd,
  }))
}
export function stressPeriod(frequencyHz:number){
 if(!Number.isFinite(frequencyHz)||frequencyHz<=0||!Number.isFinite(1000/frequencyHz))throw new Error('Frequency must be a positive finite number')
 return 1000/frequencyHz
}
export class Performance {
 private stress?:NativeStressSession
 private update?:PerformanceUpdate
 constructor(private native:()=>EmcliNativeApi,private emit:(event:Event)=>void){}
 get running(){return Boolean(this.stress)}
 private publish(update:PerformanceUpdate){this.update=update;this.emit({type:'performance',update});return update}
 bench(adapter:AdapterInfo,scope:TestScope,motorKeys?:string[]){
  if(scope.dexHandKey!==undefined)throw new Error('DexHand supports Stress. Run Bench from its bus, slave, or adapter.')
  const motors=testMotors(adapter,scope,motorKeys),rows:Extract<PerformanceUpdate,{kind:'bench'}>['rows']=[]
  this.publish({kind:'bench',scope,running:true,rows:[]})
  try{
   for(const periodMs of [10,5,3,2,1]){
    const result=this.native().bench({motors,periodMs,attempts:500,warmupMs:200,sampleGapMs:5,jitterUs:1000})
    const lossLimited = result.attempts < 50 ? result.lost > 5 : dropRate(result.lost, result.attempts) > .1
    const status = result.error ? 'Error' : result.probeMotorCount === 0 ? 'No probes' : lossLimited ? 'Loss limit' : 'OK'
    rows.push({periodMs,...summarizeSamples(result.samples),attempts:result.attempts,lost:result.lost,status})
    this.publish({kind:'bench',scope,running:true,rows:[...rows]})
    if(result.error)throw new Error(result.error)
    if(lossLimited)break
   }
   return this.publish({kind:'bench',scope,running:false,rows:[...rows]})
  }catch(error){this.publish({kind:'bench',scope,running:false,rows:[...rows],error:(error as Error).message});throw error}
 }
 start(adapter:AdapterInfo,scope:TestScope,motorKeys?:string[],frequencyHz=1000){
  if(this.stress)throw new Error('Stress test is already running')
  const periodMs=stressPeriod(frequencyHz)
  const motors=testMotors(adapter,scope,motorKeys),session=this.native().stress({motors,periodMs})
  try{session.start();const snapshot=session.poll();if(snapshot.error)throw new Error(snapshot.error);this.stress=session;return this.publish({kind:'stress',scope,running:true,snapshot})}
  catch(error){this.stress=undefined;session.dispose();throw error}
 }
 poll(){
  if(!this.stress||this.update?.kind!=='stress')return
  try{
   const snapshot=this.stress.poll()
   if(snapshot.error)throw new Error(snapshot.error)
   this.publish({...this.update,snapshot})
  }catch(error){
   const message=(error as Error).message
   try{this.stop()}catch{}
   if(this.update?.kind==='stress')this.publish({...this.update,running:false,error:message})
   this.emit({type:'log',level:'error',message:`Stress stopped: ${message}`})
  }
 }
 stop(){
  const session=this.stress,prior=this.update
  if(!session||prior?.kind!=='stress')return
  this.stress=undefined
  try{const snapshot=session.stop(200);if(snapshot.error)throw new Error(snapshot.error);return this.publish({...prior,running:false,snapshot})}
  catch(error){this.publish({...prior,running:false,error:(error as Error).message});throw error}
  finally{session.dispose()}
 }
}
