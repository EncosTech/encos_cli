// SPDX-License-Identifier: MIT
import {FieldLabel} from '../tui/components/FieldLabel.js'
import React,{useEffect,useRef,useState} from 'react'
import {Box,Text,useBoxMetrics,type DOMElement} from 'ink'
import {Button,Card,Checkbox,FilePicker,Table,Tabs,TextInput} from '../tui/index.js'
import type {FooterAction} from '../tui/components/Footer.js'
import type {FileListing,PlayConfig,PlayState,Request,SessionState,StudioClient} from './protocol.js'
import {TimingFields} from './TimingFields.js'
import {BatchGraph} from './BatchPanel.js'
import type {NativePlayMotorUpdate} from '@encos/emcli-native'
const f=(value:number|null|undefined)=>value==null||!Number.isFinite(value)?'-':value.toFixed(3)
const loss=(sent:number,received:number)=>`${Math.max(0,sent-received)}/${sent} (${sent?(Math.max(0,sent-received)/sent*100).toFixed(2):'0.00'}%)`
type Row={address:PlayState['motors'][number];adapter:string;data?:NativePlayMotorUpdate;window?:{sent:number;received:number}}
const COLUMNS=[
 {key:'adapter',header:'Adapter',width:26,value:(r:Row)=>r.adapter},
 {key:'slave',header:'Slave',width:6,value:(r:Row)=>r.address.slaveId??'-'},
 {key:'bus',header:'Bus',width:5,value:(r:Row)=>r.address.busId},
 {key:'id',header:'ID',width:6,value:(r:Row)=>r.address.motorId},
 {key:'position',header:'Position (deg)',width:10,value:(r:Row)=>f(r.data?.feedbackPosition==null?undefined:r.data.feedbackPosition*180/Math.PI)},
 ...([['speed','Speed (rad/s)',11],['current','Current (A)',9],['torque','Torque (Nm)',9],['motorTemperature','Motor(C)',9],['mosTemperature','MOS(C)',9]] as const).map(([key,header,width])=>({key,header,width,value:(r:Row)=>f(r.data?.[key])})),
 {key:'sent',header:'Sent',width:10,value:(r:Row)=>r.data?.sent??0},
 {key:'received',header:'Received',width:10,value:(r:Row)=>r.data?.received??0},
 {key:'loss',header:'Loss',width:24,value:(r:Row)=>loss(r.data?.sent??0,r.data?.received??0)},
 {key:'window',header:'Loss(3s)',width:24,value:(r:Row)=>loss(r.window?.sent??0,r.window?.received??0)},
 {key:'error',header:'Error',width:10,value:(r:Row)=>r.data?.motorError==null?'-':r.data.motorError===0?'None':String(r.data.motorError)},
 {key:'role',header:'Role',width:10,value:(r:Row)=>r.data?.holding?'Holding':'Trajectory'},
]
export function PlayPanel({session,client,run,enabled,width,onFooter,onDialog}:{session:SessionState;client:StudioClient;run:(r:Request)=>Promise<unknown>;enabled:boolean;width:number;onFooter:(actions:FooterAction[],hints:Array<{key:string;label:string}>)=>void;onDialog:(node:React.ReactNode)=>void}){
 const [state,setState]=useState(session.play),[config,setConfig]=useState<PlayConfig>(session.play?.config??{path:'',endless:false,frequency:1000,maxSpeed:20,maxCurrent:10,timing:{}})
 const [editing,setEditing]=useState(!session.play),[browse,setBrowse]=useState(false),[loading,setLoading]=useState(false),[tab,setTab]=useState('table'),[sort,setSort]=useState(0),[ascending,setAscending]=useState(true)
 useEffect(()=>client.subscribe(event=>{if(event.type==='play')setState(event.state)}),[client])
 useEffect(()=>{onDialog(browse?<FilePicker initialPath={config.path} list={path=>client.request<FileListing>({type:'files',path})} onClose={()=>setBrowse(false)} onSelect={path=>{setConfig(old=>({...old,path}));setBrowse(false)}}/>:undefined);return()=>onDialog(undefined)},[browse,config.path,client])
 const running=Boolean(state?.snapshot&&!state.snapshot.final&&state.snapshot.phase<3&&state.phase!=='Stopped'),paused=state?.snapshot?.paused
 const action=(type:'play-start'|'play-pause'|'play-stop'|'play-log')=>{void run({type,expectedView:'play'})}
 const actions:FooterAction[]=!editing&&state?[
  {key:'ctrl+s',label:'Start',disabled:!enabled||running,onPress:()=>action('play-start')},
  {key:'ctrl+p',label:paused?'Resume':'Pause',disabled:!enabled||!running,onPress:()=>action('play-pause')},
  {key:'ctrl+x',label:'Stop',disabled:!enabled||!running,onPress:()=>action('play-stop')},
  {key:'ctrl+g',label:state.logging?'Motor log off':'Motor log on',disabled:!enabled||Boolean(state.config.dryRun),onPress:()=>action('play-log')},
 ]:[]
 useEffect(()=>{onFooter(actions,[]);return()=>onFooter([],[])},[editing,running,paused,state?.logging,enabled])
 const changeSort=(column:number)=>{if(column===sort)setAscending(old=>!old);else{setSort(column);setAscending(true)}}
 const rows:Row[]=(state?.motors??[]).map((address,i)=>({address,adapter:(state?.adapters??session.adapters).find(a=>a.key===address.adapterKey)?.interfaceName??address.adapterKey,data:state?.snapshot?.motors[i],window:state?.window?.[i]}))
 rows.sort((a,b)=>{const sortValue=(r:Row)=>{if(COLUMNS[sort].key==='loss'||COLUMNS[sort].key==='window'){const counts=COLUMNS[sort].key==='loss'?r.data:r.window;return counts?.sent?Math.max(0,counts.sent-counts.received)/counts.sent:0}return COLUMNS[sort].value(r)};const av=sortValue(a),bv=sortValue(b),an=Number(av),bn=Number(bv);return (Number.isFinite(an)&&Number.isFinite(bn)?an-bn:String(av).localeCompare(String(bv)))*(ascending?1:-1)})
 const load=async()=>{setLoading(true);try{const result=await run({type:'play-load',config,expectedView:'play'}) as PlayState|undefined;if(result){setState(result);setEditing(false);setTab('table')}}finally{setLoading(false)}}
 return <>
  {editing?<Card title="Play"><Box flexDirection="column" gap={1}>
   <Box flexDirection="column"><FieldLabel>CSV file</FieldLabel><Box gap={1} alignItems="center" flexWrap="wrap"><TextInput width={Math.max(16,Math.min(76,width-20))} value={config.path} onChange={path=>setConfig(old=>({...old,path}))}/><Button size="medium" label="Browse" disabled={loading} onPress={()=>setBrowse(true)}/></Box></Box>
   <TimingFields value={config.timing??{}} onChange={timing=>setConfig(old=>({...old,timing}))} width={Math.min(64,width-4)}/>
   <Box gap={2} flexWrap="wrap">{([['frequency','Control frequency (Hz)'],['maxSpeed','Maximum speed (rad/s)'],['maxCurrent','Maximum current (A)']] as const).map(([key,label])=><NumericField key={key} label={label} value={config[key]} onChange={value=>setConfig(old=>({...old,[key]:value}))}/>)}</Box>
   <Checkbox label="Endless" checked={config.endless} disabled={loading} onChange={endless=>setConfig(old=>({...old,endless}))}/>
   <Checkbox label="Dry run" checked={config.dryRun??false} disabled={loading} onChange={dryRun=>setConfig(old=>({...old,dryRun}))}/>
   <Button size="medium" variant="primary" label={loading?'Loading...':'Load'} disabled={!enabled||loading} onPress={()=>void load()}/>
  </Box></Card>:<>
   <Box flexShrink={0} gap={2} flexWrap="wrap"><Text>{state?.config.dryRun?'Dry run · ':''}{state?.phase} · {((state?.snapshot?.elapsedMs??0)/1000).toFixed(2)} s</Text>{actions.map(a=><Button key={a.key} size="small" label={a.label} disabled={a.disabled} onPress={a.onPress} variant={a.label==='Stop'?'danger':a.label==='Start'?'success':'secondary'}/>)}<Button size="small" label="Load another" disabled={running} onPress={()=>setEditing(true)}/></Box>
   <Tabs items={[{id:'table',label:'Table'},{id:'graph',label:'Graph'}]} value={tab} onChange={setTab}/>
   {tab==='table'?<PlaybackTable rows={rows} columns={COLUMNS} sort={sort} ascending={ascending} onSort={changeSort}/>:<BatchGraph session={{...session,adapters:state?.adapters??session.adapters}} client={client} motors={state?.motors??[]} width={width}/>}
  </>}
 </>
}
function NumericField({label,value,onChange}:{label:string;value:number;onChange:(value:number)=>void}){
 const [text,setText]=useState(String(value))
 return <Box flexDirection="column"><FieldLabel>{label}</FieldLabel><TextInput size="large" width={24} value={text} onChange={next=>{setText(next);onChange(next.trim()?Number(next):NaN)}}/></Box>
}

function PlaybackTable({rows,columns,sort,ascending,onSort}:{rows:Row[];columns:typeof COLUMNS;sort:number;ascending:boolean;onSort:(column:number)=>void}){
 const ref=useRef<DOMElement|null>(null),metrics=useBoxMetrics(ref)
 const width=Math.max(20,Math.floor(metrics.hasMeasured?metrics.width-4:80))
 const height=Math.max(1,Math.floor(metrics.hasMeasured?metrics.height-7:8))
 return <Box ref={ref} flexGrow={1} flexBasis={0} minHeight={0} minWidth={0} flexDirection="column"><Card title="Playback" flexGrow={1} scrollable={false}><Table autoFocus autoColumns viewportWidth={width} rows={rows} rowKey={r=>r.address.key} height={height} columns={columns} sortColumn={sort} sortAscending={ascending} onSort={onSort}/></Card></Box>
}
