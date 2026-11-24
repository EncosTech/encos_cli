// SPDX-License-Identifier: MIT
import {FieldLabel} from '../tui/components/FieldLabel.js'
import React,{useEffect,useState,useSyncExternalStore} from 'react'
import {Box,Text} from 'ink'
import {Button,Card,Dropdown,LineChart,Tabs,createChartStore,TextInput,Table,TwoColumns,useColumnWidth,useNotifications} from '../tui/index.js'
import {IMU_GROUPS,IMU_SERIES,appendImuSample} from './imu-chart.js'
import type {ChartSeries} from '../tui/chart-store.js'
import {colors} from '../tui/theme.js'
import type {DeviceAddress,DeviceSample,DeviceAction,Request} from './protocol.js'
import {deviceLabel} from './devices.js'
type Run=(request:Request,message?:string)=>Promise<unknown>
const value=(n:unknown)=>typeof n==='number'&&Number.isFinite(n)?n.toFixed(3):typeof n==='boolean'?n?'Yes':'No':n===undefined||n===null?'—':String(n)
function Rows({rows}:{rows:Array<[string,unknown]>}){const width=useColumnWidth();const valueWidth=Math.min(16,Math.max(8,Math.floor(width*.3)));return <Table rows={rows} height={rows.length} rowKey={r=>r[0]} columns={[{key:'parameter',header:'Parameter',width:Math.max(10,width-valueWidth-6),value:r=>r[0]},{key:'value',header:'Value',width:valueWidth,value:r=>value(r[1])}]}/>}

function Section({title,children}:{title:string;children:React.ReactNode}){return <Box flexDirection="column" flexShrink={0}><Text bold color={colors.text}>{title}</Text>{children}</Box>}
const batteryFlags=['allowShutdown','allowDischarge','parallelDischarge','forceShutdown','requestCharging','faultShutdownBroadcast','configureFaultThresholds','clearFault','factoryMode','debug'] as const
const EMPTY_SERIES:readonly ChartSeries[]=[]
const noSubscribe=()=>()=>{}
const emptySnapshot=()=>EMPTY_SERIES
const pretty=(s:string)=>s.replace(/([A-Z])/g,' $1').replace(/^./,c=>c.toUpperCase())
export function DevicePanel({device,sample,run,enabled,width}:{device:DeviceAddress;sample?:DeviceSample;run:Run;enabled:boolean;width:number}){
 const [imuTab,setImuTab]=useState('parameters')
 const [imuGroup,setImuGroup]=useState<string>('acceleration')
 const [imuHidden,setImuHidden]=useState<string[]>([])
 const [imuChart]=useState(()=>device.kind==='imu'?createChartStore({series:IMU_SERIES}):undefined)
 const imuSeries=useSyncExternalStore(imuChart?.subscribe??noSubscribe,imuChart?.getSnapshot??emptySnapshot,imuChart?.getSnapshot??emptySnapshot)
 useEffect(()=>{if(imuChart&&sample)appendImuSample(imuChart,sample,device.key)},[imuChart,sample,device.key])
 useEffect(()=>()=>imuChart?.dispose(),[imuChart])
 const [channels,setChannels]=useState(['0','1','2','3','4','5']),[flags,setFlags]=useState<string[]>([])
 const [finger,setFinger]=useState('0'),[encoder,setEncoder]=useState('0'),[mask,setMask]=useState('0x3FF')
 const {notify}=useNotifications()
 const act=async(action:DeviceAction)=>{const result=await run({type:'device-action',deviceKey:device.key,action});if(typeof result==='string')notify(result,{severity:'success'})}
 const button=(label:string,action:DeviceAction)=><Button variant={/Stop|off|Disable/.test(label)?'danger':/Calibrate|Clear/.test(label)?'warning':/Start|on|Enable/.test(label)?'success':'primary'} key={label} size="small" label={label} disabled={!enabled} onPress={()=>void act(action)}/>
 let controls:React.ReactNode,parameters:React.ReactNode
 if(device.kind==='imu'){
  const s=sample?.kind==='imu'?sample.status:undefined
  controls=<Box gap={1}>{button('Start',{kind:'imu',operation:'start'})}{button('Stop',{kind:'imu',operation:'stop'})}</Box>
  parameters=<TwoColumns fallbackWidth={width}>
   <Section title="Acceleration"><Rows rows={(['x','y','z'] as const).map(k=>[k.toUpperCase(),s?.acceleration?.[k]])}/></Section>
   <Section title="Angular velocity"><Rows rows={(['x','y','z'] as const).map(k=>[k.toUpperCase(),s?.angularVelocity?.[k]])}/></Section>
   <Section title="Euler angles"><Rows rows={(['pitch','roll','heading'] as const).map(k=>[pretty(k),s?.eulerAngle?.[k]])}/></Section>
   <Section title="Quaternion"><Rows rows={(['qw','qx','qy','qz'] as const).map(k=>[k.toUpperCase(),s?.quaternion?.[k]])}/></Section>
  </TwoColumns>
 }else if(device.kind==='battery'){
  const s=sample?.kind==='battery'?sample.status:undefined
  controls=<Box flexDirection="column" gap={1} flexShrink={0}>
   <Box columnGap={3} rowGap={1} flexWrap="wrap">
    <Box>{button('Clear fault',{kind:'battery',operation:'clear'})}</Box>
    <Box gap={1}>{button('Charge on',{kind:'battery',operation:'charge',enabled:true})}{button('Charge off',{kind:'battery',operation:'charge',enabled:false})}</Box>
    <Box gap={1}>{button('Discharge on',{kind:'battery',operation:'discharge',enabled:true})}{button('Discharge off',{kind:'battery',operation:'discharge',enabled:false})}</Box>
   </Box>
   <Box gap={1} alignItems="flex-end" flexWrap="wrap"><Dropdown multiple label="Command flags" width={Math.max(18,Math.min(48,width-18))} options={batteryFlags.map(flag=>({value:flag,label:pretty(flag)}))} values={flags} onChange={setFlags}/><Button size="medium" variant="primary" label="Send flags" disabled={!enabled} onPress={()=>void act({kind:'battery',operation:'commands',commands:Object.fromEntries(batteryFlags.map(flag=>[flag,flags.includes(flag)]))})}/></Box>
  </Box>
  parameters=<TwoColumns fallbackWidth={width}>
   <Section title="State"><Rows rows={['isMaster','soc','voltage','allowedDischargeCurrent','allowedChargeCurrent'].map(k=>[pretty(k),(s?.state as Record<string,unknown>|undefined)?.[k]])}/></Section>
   <Section title="Temperature / current"><Rows rows={['battery','mos','dischargeCurrent','chargeCurrent'].map(k=>[pretty(k),(s?.temp as Record<string,unknown>|undefined)?.[k]])}/></Section>
   <Section title="Faults"><Rows rows={['couldNotCharge','couldNotDischarge','lowBattery','overCurrentSteady','overCurrentPeak','overCurrentCharge','batteryOverTemp','mosOverTemp','couldNotCommunicate','stoppedEmergency','chargerFault','commTimeout'].map(k=>[pretty(k),(s?.error as Record<string,unknown>|undefined)?.[k]])}/></Section>
   <Section title="Active commands"><Rows rows={['shutdownRequest','dischargeRequest','forceShutdownBroadcast','allowCharging','faultShutdownBroadcast','mosStatus'].map(k=>[pretty(k),(s?.activeCommands as Record<string,unknown>|undefined)?.[k]])}/></Section>
  </TwoColumns>
 }else if(device.kind==='pms'){
  const s=sample?.kind==='pms'?sample.status:undefined
  controls=<Box gap={1} flexShrink={0} alignItems="flex-end"><Dropdown multiple label="Channels" width={Math.max(18,Math.min(40,width-30))} values={channels} options={Array.from({length:6},(_,i)=>({value:String(i),label:`V48_${i+1}`}))} onChange={setChannels}/><Button size="medium" variant="success" label="Enable" disabled={!enabled} onPress={()=>void act({kind:'pms',operation:'channels',channels:channels.map(Number),enabled:true})}/><Button size="medium" variant="danger" label="Disable" disabled={!enabled} onPress={()=>void act({kind:'pms',operation:'channels',channels:channels.map(Number),enabled:false})}/></Box>
  parameters=<TwoColumns fallbackWidth={width}><Section title="48 V channels"><Rows rows={Array.from({length:6},(_,i)=>[[`V48_${i+1} enabled`,s?.v48ChannelEnabled[i]],[`V48_${i+1} current (A)`,s?.v48Currents[i]]] as Array<[string,unknown]>).flat()}/></Section><Section title="Power"><Rows rows={[
   ['V19_1 current (A)',s?.v19Currents[0]],['V19_2 current (A)',s?.v19Currents[1]],['V5 current (A)',s?.v5Current],['Battery SOC (%)',s?.batterySoc],['Battery voltage (V)',s?.batteryVoltage],['Battery current (A)',s?.batteryCurrent],
  ]}/></Section></TwoColumns>
 }else{
  const s=sample?.kind==='glove'?sample.status:undefined
  controls=<Box flexDirection="column" flexShrink={0} gap={1}>
   <Box><Button variant="warning" size="medium" label="Calibrate all" disabled={!enabled} onPress={()=>void act({kind:'glove',operation:'all'})}/></Box>
   <TwoColumns minColumnWidth={58} fallbackWidth={width}>
    <Box gap={1} alignItems="flex-end" flexWrap="wrap"><Dropdown width={18} label="Finger" value={finger} options={['Thumb','Index','Middle','Ring','Pinky'].map((label,i)=>({value:String(i),label:`F${i}: ${label}`}))} onChange={setFinger}/><Dropdown width={14} label="Encoder" value={encoder} options={Array.from({length:10},(_,i)=>({value:String(i),label:`Enc ${i}`}))} onChange={setEncoder}/><Button variant="warning" size="medium" label="Calibrate encoder" disabled={!enabled} onPress={()=>void act({kind:'glove',operation:'mask',finger:Number(finger),mask:1<<Number(encoder)})}/></Box>
    <Box gap={1} alignItems="flex-end" flexWrap="wrap"><Box flexDirection="column"><FieldLabel>Encoder mask</FieldLabel><TextInput size="large" width={20} value={mask} onChange={setMask}/></Box><Button variant="warning" size="medium" label="Calibrate mask" disabled={!enabled} onPress={()=>{if(!/^(0x[0-9a-f]+|[0-9]+)$/i.test(mask.trim())||Number(mask)<1||Number(mask)>1023){notify('Encoder mask must be 1–1023',{severity:'error'});return}void act({kind:'glove',operation:'mask',finger:Number(finger),mask:Number(mask)})}}/></Box>
   </TwoColumns>
  </Box>
  parameters=<Section title="Encoder angles (deg)"><Table height={5} rows={[0,1,2,3,4]} rowKey={f=>String(f)} columns={[{key:'finger',header:'Finger',width:6,value:f=>`F${f}`},...Array.from({length:10},(_,e)=>({key:`encoder${e}`,header:`Enc ${e}`,width:7,value:(f:number)=>{const n=s?.[f]?.[e];return typeof n==='number'?(n*180/Math.PI).toFixed(2):'OFF'}}))]}/></Section>
 }
 if(device.kind==='imu')return <>
  <Tabs items={[{id:'parameters',label:'Parameters'},{id:'graph',label:'Graph'}]} value={imuTab} onChange={setImuTab}/>
  {imuTab==='graph'?<Card title="IMU graph" scrollable={false}>
   <Dropdown label="Measurement" width={32} options={IMU_GROUPS.map(({value,label})=>({value,label}))} value={imuGroup} onChange={setImuGroup}/>
   <LineChart series={imuSeries.filter(series=>series.id?.startsWith(`${imuGroup}:`))} hiddenSeriesIds={imuHidden} onHiddenSeriesChange={setImuHidden} windowMs={10000}/>
  </Card>:<Card title="IMU"><Box flexDirection="column" flexShrink={0} paddingTop={1}>{controls}<Box flexDirection="column" flexShrink={0} marginTop={1}>{parameters}</Box></Box></Card>}
 </>
 return <Card title={deviceLabel(device.kind)}><Box flexDirection="column" flexShrink={0} paddingTop={1}>{controls}<Box flexDirection="column" flexShrink={0} marginTop={1}>{parameters}</Box></Box></Card>
}
