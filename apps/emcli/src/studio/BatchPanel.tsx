// SPDX-FileCopyrightText: 2026 Encos
// SPDX-License-Identifier: MIT
import React,{useEffect,useMemo,useState,useSyncExternalStore} from 'react'
import {Box} from 'ink'
import {Card,Dropdown,LineChart,Tabs,TreeSelect,createChartStore,type TreeSelectNode} from '../tui/index.js'
import {ControlPanel,SettingEditor} from './MotorPanels.js'
import {SETTINGS,supportsDexHandJointSetting} from './catalog.js'
import {compareMotorDisplay,motorDisplayLabel} from './devices.js'
import {colors} from '../tui/theme.js'
import type {GraphMetric,MotorAddress,Request,SessionState,StudioClient} from './protocol.js'
import {MOTOR_METRICS as METRICS} from './motor-metrics.js'
const PALETTE=[colors.primary,colors.accent,colors.cyan,colors.success,colors.danger,'#cc88ff','#ff88bb','#99cc55']
export function batchMotorLabel(session:SessionState,motor:MotorAddress){const adapter=session.adapters.find(a=>a.key===motor.adapterKey);return `${adapter?.interfaceName??motor.adapterKey} / S${motor.slaveId??0} B${motor.busId} / ${motorDisplayLabel(motor)}`}
export function batchMotorTree(session:SessionState,motors:MotorAddress[]):TreeSelectNode[]{
 return session.adapters.flatMap((adapter) => {
  const members = motors.filter((motor) => motor.adapterKey === adapter.key)
  if (!members.length) return []
  return [{
   value: `adapter:${adapter.key}`, label: `${adapter.type} · ${adapter.interfaceName}`, selectable: false,
   children: [...new Set(members.map((motor) => motor.slaveId ?? 0))].sort((a, b) => a - b).map((slave) => {
    const slaveMotors = members.filter((motor) => (motor.slaveId ?? 0) === slave)
    return {
     value: `${adapter.key}:slave:${slave}`, label: `Slave ${slave}`, selectable: false,
     children: [...new Set(slaveMotors.map((motor) => motor.busId))].sort((a, b) => a - b).map((bus) => ({
      value: `${adapter.key}:${slave}:bus:${bus}`, label: `Bus ${bus}`, selectable: false,
      children: slaveMotors.filter((motor) => motor.busId === bus).sort(compareMotorDisplay)
       .map((motor) => ({ value: motor.key, label: motorDisplayLabel(motor) })),
     })),
    }
   }),
  }]
 })
}
export function BatchPanel({session,client,run,enabled,width}:{session:SessionState;client:StudioClient;run:(request:Request,message?:string)=>Promise<unknown>;enabled:boolean;width:number}){
 const [tab,setTab]=useState('control'),[drafts,setDrafts]=useState<Record<string,number[]>>({}),[settings,setSettings]=useState<Record<string,string[]>>({})
 const motors=session.adapters.flatMap(a=>a.motors).filter(m=>session.batchKeys?.includes(m.key))
 const includesDexHand = motors.some((motor) => motor.dexHandKey)
 const availableSettings = SETTINGS.filter((setting) =>
  !['id', 'comm', 'kt'].includes(setting.id) && (!includesDexHand || supportsDexHandJointSetting(setting.id)))
 const ready=enabled&&motors.length>0
 useEffect(()=>{void client.request({type:'graph-active',active:tab==='graph',expectedView:'batch'}).catch(()=>{});return()=>{void client.request({type:'graph-active',active:false,expectedView:'batch'}).catch(()=>{})}},[tab,client,JSON.stringify(session.batchKeys??[])])
 const request=async(r:Request)=>{
  const mapped:Request=r.type==='control'?{type:'batch-control',command:{mode:r.mode,values:r.values,stopMode:r.stopMode}}:r.type==='disable'?{type:'batch-disable'}:r.type==='brake'?{type:'batch-brake',engaged:r.engaged}:r.type==='write'?{type:'batch-write',item:r.item,values:r.values}:r
  return run({...mapped,expectedView:'batch'})
 }
 return <>
  <Tabs items={['Control','Settings','Graph'].map(label=>({id:label.toLowerCase(),label}))} value={tab} onChange={setTab}/>
  {tab==='control'?<ControlPanel batch run={request} enabled={ready} width={width} drafts={drafts} setDrafts={setDrafts} command={session.batchCommand}/>:tab==='settings'?<Card title="Motor settings"><Box flexDirection="column" gap={1}>{availableSettings.map(setting=><SettingEditor key={setting.id} batch setting={setting} values={settings[setting.id]??setting.fields.map(()=>'')} onChange={values=>setSettings(old=>({...old,[setting.id]:values}))} run={request} enabled={ready} width={width}/>)}</Box></Card>:<BatchGraph session={session} motors={motors} client={client} width={width}/>}
 </>
}
export function BatchGraph({session,motors,client,width}:{session:SessionState;motors:MotorAddress[];client:StudioClient;width:number}){
 const [group,setGroup]=useState('motor'),[chosen,setChosen]=useState(''),[metric,setMetric]=useState<GraphMetric>('position')
 const motorKey=motors.some(m=>m.key===chosen)?chosen:motors[0]?.key??''
 const signature=JSON.stringify(motors.map(m=>[m.key,batchMotorLabel(session,m)]))
 const store=useMemo(()=>createChartStore({series:motors.flatMap((m,i)=>METRICS.map(metric=>({id:JSON.stringify([m.key,metric.value]),label:`${metric.label} · ${batchMotorLabel(session,m)}`,color:PALETTE[i%PALETTE.length],yAxisId:metric.value})))}),[signature])
 const series=useSyncExternalStore(store.subscribe,store.getSnapshot,store.getSnapshot)
 useEffect(()=>{const keys=new Set(motors.map(m=>m.key));const unsub=client.subscribe(event=>{if(event.type==='telemetry'&&keys.has(event.sample.motorKey))store.appendMany(METRICS.map(metric=>({seriesId:JSON.stringify([event.sample.motorKey,metric.value]),timestamp:event.sample.timestamp,value:event.sample[metric.value as GraphMetric]??NaN})))});return()=>{unsub();store.dispose()}},[store,client])
 const shown=group==='motor'?series.filter(s=>JSON.parse(s.id!)[0]===motorKey).map(s=>{const m=METRICS.find(m=>m.value===s.yAxisId)!;return {...s,label:m.label,color:m.color}}):series.filter(s=>s.yAxisId===metric)
 const axes=group==='motor'?METRICS.map((m,i)=>({id:m.value,label:m.axisLabel,color:m.color,position:i===0?'left' as const:'right' as const})):[{id:metric,label:METRICS.find(m=>m.value===metric)!.axisLabel,position:'left' as const}]
 return <Card title="Live telemetry" scrollable={false}>
  <Box gap={1} flexWrap="wrap" flexShrink={0} alignItems="flex-end"><Dropdown label="Grouping" width={24} value={group} options={[{value:'motor',label:'By motor'},{value:'metric',label:'By metric'}]} onChange={setGroup}/>{group==='motor'?<TreeSelect label="Motor" width={Math.min(52,Math.max(20,width-4))} value={motorKey} nodes={batchMotorTree(session,motors)} onChange={setChosen}/>:<Dropdown label="Metric" width={30} value={metric} options={METRICS} onChange={value=>setMetric(value as GraphMetric)}/>}</Box>
  <LineChart series={shown} yAxes={axes} windowMs={10000}/>
 </Card>
}
