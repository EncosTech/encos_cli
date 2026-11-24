import assert from 'node:assert/strict'
import test,{afterEach} from 'node:test'
import React from 'react'
import {Box,Text} from 'ink'
import {PassThrough} from 'node:stream'
import {MouseProvider,type MouseEvent} from '../src/tui/mouse.js'
import {render,cleanup} from 'ink-testing-library'
import {LineChart,Card,createChartStore,type ChartPoint} from '../src/tui/index.js'
const settle=()=>new Promise(resolve=>setTimeout(resolve,80))
afterEach(cleanup)
const series=(data:ChartPoint[])=>[{label:'signal',color:'blue',data}]
test('timestamped chart uses the last ten seconds for both Y scaling and legend values',async()=>{
 const data=[{timestamp:9999,value:99999},{timestamp:11000,value:1},{timestamp:19000,value:3},{timestamp:21000,value:88888}]
 const app=render(<LineChart series={series(data)} now={20000} width={50} height={10}/>)
 await settle()
 assert.match(app.lastFrame()??'',/-10s/);assert.match(app.lastFrame()??'',/0s/)
 assert.match(app.lastFrame()??'',/3\.00/);assert.match(app.lastFrame()??'',/signal 3\.00/)
 assert.doesNotMatch(app.lastFrame()??'',/99999|88888/)
 app.rerender(<LineChart series={series(data)} now={40000} width={50} height={10}/>);await settle()
 assert.match(app.lastFrame()??'',/No samples/);assert.match(app.lastFrame()??'',/signal -/)
})
test('timestamp spacing is respected and a single sample is visible',async()=>{
 const app=render(<LineChart series={series([{timestamp:19500,value:1}])} now={20000} width={40} height={8} showAxis={false} showLegend={false}/>)
 await settle()
 const rows=(app.lastFrame()??'').split('\n'),x=rows.flatMap(line=>[...line].map((char,index)=>/[\u2801-\u28ff]/.test(char)?index:-1)).filter(index=>index>=0)
 assert.ok(x.length>0);assert.ok(x.every(index=>index>=36),'recent sample belongs at the right of the ten-second window')
})
test('chart clock expires old data even when no new samples arrive',async()=>{
 const app=render(<LineChart series={series([{timestamp:Date.now(),value:42}])} windowMs={200} refreshIntervalMs={20} width={40} height={8}/>)
 await settle();assert.match(app.lastFrame()??'',/signal 42\.0/)
 await new Promise(resolve=>setTimeout(resolve,250))
 assert.match(app.lastFrame()??'',/No samples/)
})
test('chart fills remaining card space and stays within borders when resized',async()=>{
 const screen=(width:number,height:number)=><Box width={width} height={height} flexDirection="column"><Text>Header</Text><Card title="Chart" scrollable={false}><Text>Status</Text><LineChart series={[{label:'signal',color:'blue',data:[1,2,3]}]}/></Card></Box>
 const app=render(screen(64,20));await settle()
 assert.equal(app.lastFrame()?.split('\n').length,20)
 assert.match(app.lastFrame()??'',/signal 3\.00/)
 const plotted=(app.lastFrame()??'').split('\n').filter(line=>(/[│┤]/.test(line))&&/[\u2800-\u28ff]/.test(line))
 assert.equal(plotted.length,14)
 app.rerender(screen(38,12));await settle()
 assert.equal(app.lastFrame()?.split('\n').length,12)
 assert.ok((app.lastFrame()??'').split('\n').every(line=>[...line].length<=38))
 assert.match(app.lastFrame()??'',/signal 3\.00/)
})
test('chart store batches injected samples, sorts timestamps and bounds history',async()=>{
 const store=createChartStore({series:[{id:'v',label:'velocity',color:'cyan'}],maxPointsPerSeries:3,flushIntervalMs:20})
 let updates=0;store.subscribe(()=>updates++)
 const now=Date.now()
 store.appendMany([{seriesId:'v',timestamp:now-20000,value:99},{seriesId:'v',timestamp:now-2,value:2},{seriesId:'v',timestamp:now-3,value:1},{seriesId:'v',timestamp:now-1,value:3}])
 assert.equal(store.getSnapshot()[0].data.length,0)
 await settle();assert.equal(updates,1)
 assert.deepEqual(store.getSnapshot()[0].data.map(point=>(point as ChartPoint).value),[1,2,3])
 const app=render(<LineChart store={store} width={50} height={10}/>);await settle()
 assert.match(app.lastFrame()??'',/velocity 3\.00/)
 store.append('v',4);await settle()
 assert.match(app.lastFrame()??'',/velocity 4\.00/)
 assert.equal(store.getSnapshot()[0].data.length,3)
 store.clear();await settle();assert.match(app.lastFrame()??'',/No samples/)
 store.append('v',10);store.dispose();await settle();assert.equal(store.getSnapshot()[0].data.length,0)
})
test('explicit Y limits are exact and invalid samples do not connect across a gap',async()=>{
 const app=render(<LineChart series={[{label:'gap',color:'blue',data:[0,NaN,1]}]} width={30} height={8} yMin={-2} yMax={2} showLegend={false}/>)
 await settle();assert.match(app.lastFrame()??'',/2\.00/);assert.match(app.lastFrame()??'',/-2\.00/)
 const plotted=(app.lastFrame()??'').split('\n').flatMap(line=>[...line].filter(char=>/[\u2801-\u28ff]/.test(char)))
 assert.equal(plotted.length,2)
})
test('Y scale contracts after an old spike leaves the visible time window',async()=>{
 const points=[{timestamp:10001,value:1000},{timestamp:19000,value:1},{timestamp:19500,value:2}]
 const screen=(now:number)=><LineChart series={series(points)} now={now} width={50} height={10}/>
 const app=render(screen(20000));await settle()
 assert.match(app.lastFrame()??'',/1\.0k/)
 app.rerender(screen(21002));await settle()
 assert.match(app.lastFrame()??'',/2\.00/);assert.doesNotMatch(app.lastFrame()??'',/1\.0k/)
})
test('live Charts gallery fills remaining space and keeps borders stable across resize',async()=>{
 const {Gallery}=await import('../src/tui/gallery-app.js')
 const {OverlayProvider}=await import('../src/tui/overlay.js')
 process.env.EMCLI_GALLERY_TAB='charts'
 const app=render(<OverlayProvider><Gallery/></OverlayProvider>)
 delete process.env.EMCLI_GALLERY_TAB
 for(const [columns,rows] of [[160,54],[120,40],[100,30]]){
  Object.defineProperties(app.stdout,{columns:{value:columns,configurable:true},rows:{value:rows,configurable:true}})
  app.stdout.emit('resize');await settle();await settle()
  const frame=app.lastFrame()??'',lines=frame.split('\n')
  assert.equal(lines.length,rows)
  assert.match(frame,/-10s/);assert.match(frame,/0s/);assert.match(frame,/position/);assert.match(frame,/S30/)
  const plot=lines.filter(line=>/[\u2800-\u28ff]/.test(line))
  assert.ok(plot.length>3)
  assert.ok(plot.every(line=>line.startsWith(' │')&&line.trimEnd().endsWith('│')))
  const border=lines.at(-2)
  await settle()
  assert.equal((app.lastFrame()??'').split('\n').at(-2),border)
 }
})

 test('axis ticks choose readable intervals and adjust density to viewport size',async()=>{
  const screen=(width:number,height:number)=><LineChart series={series([{timestamp:11000,value:-9},{timestamp:19000,value:9}])} now={20000} width={width} height={height}/>
  const app=render(screen(100,24));await settle()
  let frame=app.lastFrame()??''
  assert.match(frame,/-8s/);assert.match(frame,/-6s/);assert.match(frame,/5\.00/);assert.match(frame,/-5\.00/)
  app.rerender(screen(35,8));await settle();frame=app.lastFrame()??''
  assert.doesNotMatch(frame,/-8s/);assert.match(frame,/-10s/);assert.match(frame,/0s/)
  assert.ok(frame.split('\n').every(line=>[...line].length<=35))
 })

test('legend wraps all 30 entries into stable cells while values change', async () => {
 const make=(value:number)=>Array.from({length:30},(_,i)=>({id:`s${i}`,label:`S${String(i+1).padStart(2,'0')}`,color:'blue',data:[value+i]}))
 const app=render(<LineChart series={make(1)} width={80} height={24}/>);await settle()
 const positions=()=>Array.from({length:30},(_,i)=>{
  const label=`S${String(i+1).padStart(2,'0')}`,lines=(app.lastFrame()??'').split('\n')
  const y=lines.findIndex(line=>line.includes(label));assert.ok(y>=0,`${label} is visible`)
  return [y,lines[y].indexOf(label)]
 })
 const before=positions()
 app.rerender(<LineChart series={make(-1000000)} width={80} height={24}/>);await settle()
 assert.deepEqual(positions(),before)
 assert.ok(new Set(before.map(([y])=>y)).size>1)
})

test('series bind to independent left and right Y axes', async () => {
 const data=[{label:'small',color:'blue',yAxisId:'volts',data:[0,1]},
  {label:'large',color:'red',yAxisId:'rpm',data:[0,10000]}]
 const axes=[{id:'volts',label:'Volts',position:'left' as const,min:0,max:1},
  {id:'rpm',label:'RPM',position:'right' as const,min:0,max:10000}]
 const app=render(<LineChart series={data} yAxes={axes} width={70} height={18} showLegend={false}/>);await settle()
 const frame=app.lastFrame()??''
 assert.match(frame,/Volts/);assert.match(frame,/RPM/);assert.match(frame,/10\.0k/);assert.match(frame,/1\.00/)
 // Identical normalized curves must occupy exactly the same braille cells.
 const pixels=(text:string)=>text.split('\n').map(line=>[...line].filter(c=>/[\u2800-\u28ff]/.test(c)).join('')).filter(Boolean)
 const combined=pixels(frame)
 app.rerender(<LineChart series={[data[0]]} yAxes={axes} width={70} height={18} showLegend={false}/>);await settle()
 assert.deepEqual(pixels(app.lastFrame()??''),combined)
})

test('independent automatic scales work for three axes and store retains bindings',async()=>{
 const store=createChartStore({flushIntervalMs:0,series:[
  {id:'a',label:'A',color:'blue',yAxisId:'a'},
  {id:'b',label:'B',color:'red',yAxisId:'b'},
  {id:'c',label:'C',color:'green',yAxisId:'c'},
 ]})
 const now=Date.now()
 store.appendMany(['a','b','c'].flatMap((id,i)=>[
  {seriesId:id,timestamp:now-9000,value:1*10**(i*3)},
  {seriesId:id,timestamp:now,value:3*10**(i*3)},
 ]))
 assert.deepEqual(store.getSnapshot().map(s=>s.yAxisId),['a','b','c'])
 const axes=[{id:'a',label:'A',position:'left' as const},{id:'b',label:'B',position:'right' as const},{id:'c',label:'C',position:'right' as const}]
 const app=render(<LineChart store={store} yAxes={axes} now={now} width={80} height={22} showLegend={false}/>);await settle()
 const frame=app.lastFrame()??''
 assert.match(frame,/2\.00/);assert.match(frame,/2\.0k/);assert.match(frame,/2\.0M/)
 const pixels=(text:string)=>text.split('\n').map(line=>[...line].filter(c=>/[\u2800-\u28ff]/.test(c)).join('')).filter(Boolean)
 app.rerender(<LineChart series={[store.getSnapshot()[0]]} yAxes={axes} now={now} width={80} height={22} showLegend={false}/>);await settle()
 assert.deepEqual(pixels(app.lastFrame()??''),pixels(frame))
 store.dispose()
})

test('motor axes use complete short names while legends retain full names and units',async()=>{
 const {MOTOR_METRICS}=await import('../src/studio/motor-metrics.js')
 const data=MOTOR_METRICS.map(m=>({id:m.value,label:m.label,yAxisId:m.value,color:m.color,data:[1,2,3]}))
 const axes=MOTOR_METRICS.map((m,i)=>({id:m.value,label:m.axisLabel,position:i===0?'left' as const:'right' as const}))
 for(const width of [80,140]){
  const app=render(<LineChart width={width} height={16} series={data} yAxes={axes}/>);await settle()
  const frame=app.lastFrame()??'',header=frame.split('\n')[0]
  assert.match(header,/Position\s+Speed\s+Current\s+Power/)
  assert.doesNotMatch(header,/\(|Mechanical/)
  for(const m of MOTOR_METRICS)assert.ok(frame.includes(m.label),m.label)
  app.unmount()
 }
})

test('legend toggles lines without moving cells and retains hidden series updates',async()=>{
 let mouse=(_event:MouseEvent)=>{}
 const input={stdin:new PassThrough(),onMouse(fn:typeof mouse){mouse=fn;return()=>{}},dispose(){}}
 const store=createChartStore({series:[{id:'signal',label:'Signal',color:'blue'}],flushIntervalMs:0})
 store.append('signal',1)
 const app=render(<MouseProvider input={input}><LineChart store={store} width={50} height={10}/></MouseProvider>);await settle()
 const point=()=>{const lines=app.lastFrame()!.split('\n'),y=lines.findIndex(line=>line.includes('Signal'));return {x:lines[y].indexOf('Signal'),y}}
 const before=point()
 mouse({action:'press',button:'left',...before});await settle()
 assert.match(app.lastFrame()??'',/□ Signal/);assert.match(app.lastFrame()??'',/No visible series/)
 store.append('signal',42);await settle();assert.deepEqual(point(),before)
 mouse({action:'press',button:'left',...point()});await settle()
 assert.match(app.lastFrame()??'',/■ Signal 42.0/);assert.match(app.lastFrame()??'',/[\u2801-\u28ff]/)
 app.stdin.write(' ');await settle();assert.match(app.lastFrame()??'',/□ Signal/)
 app.stdin.write('\r');await settle();assert.match(app.lastFrame()??'',/■ Signal/)
 store.dispose()
})

test('hidden series do not affect Y autoscaling and stay addressable after reordering',async()=>{
 const data=[{id:'a',label:'Small',color:'blue',data:[1,2]},{id:'b',label:'Spike',color:'red',data:[1000]}]
 const screen=(items:typeof data,hidden:string[])=><LineChart series={items} hiddenSeriesIds={hidden} width={50} height={12}/>
 const app=render(screen(data,[]));await settle();assert.match(app.lastFrame()??'',/1\.0k/)
 app.rerender(screen(data,['b']));await settle()
 assert.doesNotMatch(app.lastFrame()!.split('\n').slice(0,-1).join('\n'),/1\.0k/)
 assert.match(app.lastFrame()??'',/□ Spike/);assert.match(app.lastFrame()??'',/■ Small/)
 app.rerender(screen([...data].reverse(),['b']));await settle();assert.match(app.lastFrame()??'',/□ Spike/);assert.match(app.lastFrame()??'',/■ Small/)
})
