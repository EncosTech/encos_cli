// SPDX-FileCopyrightText: 2026 Encos
// SPDX-License-Identifier: MIT

import {FieldLabel} from '../tui/components/FieldLabel.js'
import React,{useState} from 'react'
import {Box,Text} from 'ink'
import {Button,Card,Dropdown,ScrollView,SliderInput,Table,TextInput,TwoColumns,useColumnWidth,useNotifications} from '../tui/index.js'
import {CONTROLS,validateSetting,type Setting} from './catalog.js'
import type {ControlCommand,MotorAddress,Request,Telemetry} from './protocol.js'
import {colors} from '../tui/theme.js'
type Run=(request:Request,message?:string)=>Promise<unknown>
const display=(value?:number)=>value===undefined||!Number.isFinite(value)?'-':value.toFixed(3)
function ControlField({field,value,onChange,range,enabled}:{field:typeof CONTROLS[number]['fields'][number];value:number;onChange(value:number):void;range?:{min:number;max:number};enabled:boolean}){
 const width=useColumnWidth(),scale=field.range==='pvt-pos-range'?180/Math.PI:1
 return <Box flexDirection="column"><FieldLabel>{field.label}</FieldLabel><SliderInput width={Math.max(15,width)} precision={3} min={range?range.min*scale:field.min} max={range?range.max*scale:field.max} value={value} disabled={!enabled} onChange={onChange}/></Box>
}
export function ControlPanel({run,enabled,width,drafts,setDrafts,command,motor,sample,batch=false}:{run:Run;enabled:boolean;width:number;drafts:Record<string,number[]>;setDrafts:React.Dispatch<React.SetStateAction<Record<string,number[]>>>;command?:ControlCommand;motor?:MotorAddress;sample?:Telemetry;batch?:boolean}){
 const [stopMode,setStopMode]=useState('full'),[brake,setBrake]=useState('-')
 const mode=CONTROLS.find(m=>m.id===command?.mode),p=motor?.properties
 const ranges:Record<string,{min:number;max:number}|undefined>={'pvt-kp-range':p?.kp,'pvt-kd-range':p?.kd,'pvt-pos-range':p?.position,'pvt-spd-range':p?.speed,'pvt-tor-range':p?.torque,'pvt-cur-range':p?.current}
 const rows:Array<[string,string]>=[['Mode',mode?.label??'Disabled'],...(mode?.fields.map((field,i)=>[`Command ${field.label}`,display(command?.values[i])] as [string,string])??[]),...(command?.mode==='stop'?[['Stop mode',command.stopMode??'full'] as [string,string]]:[]),...([['Position (deg)','position'],['Speed (rad/s)','speed'],['Current (A)','current'],['Mechanical power (W)','power'],['Motor temperature (°C)','motorTemperature'],['MOS temperature (°C)','mosTemperature'],['Error','error']] as const).filter(()=>!batch).map(([label,key])=>[label,display(sample?.[key])] as [string,string])]
 const brakeOnce=async(engaged:boolean)=>{setBrake('Sending...');const result=await run({type:'brake',engaged});setBrake(typeof result==='string'?result:'Failed')}
 return <ScrollView><Box flexDirection="column" gap={1}>
  <Card title="Status" flexGrow={0} scrollable={false}><Table rows={rows} height={rows.length} rowKey={r=>r[0]} columns={[{key:'parameter',header:'Parameter',width:30,value:r=>r[0]},{key:'value',header:'Value',width:Math.max(12,Math.min(32,width-38)),value:r=>r[1]}]}/>{command?<Box marginTop={1}><Button size="small" variant="warning" label="Disable" disabled={!enabled} onPress={()=>void run({type:'disable'})}/></Box>:null}</Card>
  {CONTROLS.map(mode=>{const values=drafts[mode.id]??mode.fields.map(field=>field.value);return <Card key={mode.id} title={mode.label} flexGrow={0} scrollable={false}>
   <Box flexDirection="column" gap={1}>
    {mode.id==='stop'?<Dropdown label="Stop mode" width={30} options={['full','dynamic','regenerative'].map(value=>({value,label:value}))} value={stopMode} onChange={setStopMode}/>:null}
    <TwoColumns minColumnWidth={30} fallbackWidth={width-4}>{mode.fields.map((field,index)=><ControlField key={field.label} field={field} range={field.range?ranges[field.range]:undefined} value={values[index]} enabled={enabled} onChange={value=>setDrafts(current=>({...current,[mode.id]:values.map((old,i)=>i===index?value:old)}))}/>)}</TwoColumns>
    <Button size="small" label={`Apply ${mode.label}`} variant={mode.id==='stop'?'danger':'primary'} disabled={!enabled} onPress={()=>void run({type:'control',mode:mode.id,values,stopMode:stopMode as 'full'})}/>
   </Box>
  </Card>})}
  <Card title="Mechanical brake" flexGrow={0} scrollable={false}><Box gap={1} flexWrap="wrap"><Button size="small" label="Engage" variant="danger" disabled={!enabled} onPress={()=>void brakeOnce(true)}/><Button size="small" label="Release" variant="success" disabled={!enabled} onPress={()=>void brakeOnce(false)}/><Text>{brake}</Text></Box></Card>
 </Box></ScrollView>
}
export function SettingEditor({setting,values,onChange,run,enabled,width,batch=false,validate=validateSetting,readAfterWrite=true}:{setting:Setting;values:string[];onChange(values:string[]):void;run:Run;enabled:boolean;width:number;batch?:boolean;validate?:(item:string,values:string[])=>void;readAfterWrite?:boolean}){
 const {notify}=useNotifications()
 const read=async()=>{const result=await run({type:'read',item:setting.id});if(typeof result==='string')onChange(result.split(/\s+/));return result}
 const write=async(reset=false)=>{
  try{validate(setting.id,reset?[]:values)}catch(error){notify((error as Error).message,{severity:'error'});return}
  const result=await run({type:'write',item:setting.id,values:reset?[]:values})
  if(result===undefined)return
  if(!batch&&setting.readable!==false&&readAfterWrite)await read()
  if(!readAfterWrite&&typeof result==='string')onChange(result.split(/\s+/))
 }
 return <Box flexDirection="column" flexShrink={0}>
  <FieldLabel bold>{setting.label}{setting.unit?` (${setting.unit})`:''}{setting.fields.length>1?` · ${setting.fields.join(' / ')}`:''}</FieldLabel>
  <Box gap={1} flexWrap="wrap" alignItems="center">
   {setting.id==='comm'?<Dropdown size="small" label="" width={24} value={values[0]??'can'} options={['can','canfd','canopen'].map(value=>({value,label:value.toUpperCase()}))} onChange={value=>onChange([value])}/>:setting.fields.map((field,i)=><TextInput key={field} size="small" width={Math.min(18,Math.max(8,Math.floor((width-32)/setting.fields.length)))} value={values[i]??''} onChange={value=>onChange(values.map((old,j)=>i===j?value:old))} disabled={!enabled||setting.writable===false}/>)}
   {!batch&&setting.readable!==false?<Button size="small" label="Read" disabled={!enabled} onPress={()=>void read()}/>:null}{setting.writable!==false?<Button size="small" label="Apply" variant="primary" disabled={!enabled} onPress={()=>void write()}/>:null}{setting.id==='position'?<Button variant="warning" size="small" label="Reset zero" disabled={!enabled} onPress={()=>void write(true)}/>:null}
  </Box>
 </Box>
}
