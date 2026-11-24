import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'
import React from 'react'
import { Box } from 'ink'
import { render, cleanup } from 'ink-testing-library'
import { PassThrough } from 'node:stream'
import { createLogStore, LogCard, MouseProvider, NavigationProvider, NotificationProvider, TextInput, type LogEntry, type MouseEvent } from '../src/tui/index.js'
const settle = () => new Promise(resolve => setTimeout(resolve, 80))
afterEach(cleanup)
const sample = (count: number) => Array.from({ length: count }, (_, index) => ({ level: 'info' as const, message: `Record ${String(index + 1).padStart(2, '0')}`, source: 'driver' }))
test('log store batches notifications, bounds history, and cancels pending updates on clear/dispose', async () => {
  const store = createLogStore({ maxEntries: 3, flushIntervalMs: 20 })
  let updates = 0
  store.subscribe(() => updates++)
  store.appendMany(sample(10))
  assert.equal(store.getSnapshot().length, 0)
  await settle()
  assert.equal(updates, 1)
  assert.deepEqual(store.getSnapshot().map(entry => entry.id), [8, 9, 10])
  store.append({message:'pending'}); store.clear(); await settle()
  assert.equal(store.getSnapshot().length, 0); assert.equal(updates, 2)
  store.append({message:'discard'}); store.dispose(); const disposedUpdates = updates
  await settle(); store.append({message:'ignored'}); await settle()
  assert.equal(store.getSnapshot().length, 0); assert.equal(updates, disposedUpdates)
})
test('log store strips terminal controls, preserves multiline Unicode and keeps stream separate from level', () => {
  const store = createLogStore({ flushIntervalMs: 0 })
  store.append({ message: '\u001b[31m电机🙂\u001b[0m\r\nnext\u001b]52;c;c2VjcmV0\u0007\u001b[2J', stream: 'stderr', source: 'driver\u001b[2J' })
  assert.equal(store.getSnapshot()[0].message, '电机🙂\nnext')
  assert.equal(store.getSnapshot()[0].level, 'unknown')
  assert.equal(store.getSnapshot()[0].source, 'driver')
  assert.equal(store.getSnapshot()[0].stream, 'stderr')
  store.dispose()
})
test('log card follows, pauses without jumping on append, resumes and clears', async () => {
  const store = createLogStore({ flushIntervalMs: 0 })
  store.appendMany(sample(20))
  const app = render(<NavigationProvider><LogCard autoFocus store={store} width={70} height={10} showTimestamp={false} /></NavigationProvider>)
  await settle(); assert.match(app.lastFrame() ?? '', /Record 20/); assert.match(app.lastFrame() ?? '', /Following/)
  app.stdin.write('\u001b[H'); await settle(); assert.match(app.lastFrame() ?? '', /Record 01/); assert.match(app.lastFrame() ?? '', /Paused/)
  store.append({ message: 'Latest record', level: 'error' }); await settle()
  assert.match(app.lastFrame() ?? '', /Record 01/); assert.doesNotMatch(app.lastFrame() ?? '', /Latest record/); assert.match(app.lastFrame() ?? '', /1 new/)
  for (let i = 0; i < 6; i++) { app.stdin.write('\u001b[6~'); await settle() }
  assert.match(app.lastFrame() ?? '', /Following/); assert.match(app.lastFrame() ?? '', /Latest record/)
  store.clear(); await settle(); assert.match(app.lastFrame() ?? '', /No logs/)
  store.dispose()
})
test('paused log viewport retains record identity across eviction and falls back when anchor is removed', async () => {
  const store = createLogStore({ maxEntries: 20, flushIntervalMs: 0 })
  store.appendMany(sample(20))
  const app = render(<LogCard autoFocus store={store} width={60} height={8} showTimestamp={false} />)
  await settle(); app.stdin.write('\u001b[H'); await settle()
  app.stdin.write('\u001b[6~'); await settle()
  const before = (app.lastFrame() ?? '').split('\n').find(line => line.includes('Record'))
  store.append({message:'New record'}); await settle()
  assert.equal((app.lastFrame() ?? '').split('\n').find(line => line.includes('Record')), before)
  store.appendMany(Array.from({length: 20}, (_, index) => ({message:`Fresh ${index}`}))); await settle()
  assert.match(app.lastFrame() ?? '', /Fresh 0/)
  store.dispose()
})
test('log filters, multiline wrapping and copy keep full record contents', async () => {
  const store = createLogStore({ flushIntervalMs: 0 })
  store.appendMany([{message:'Hidden',level:'info',source:'other'}, {message:'A long message with wide 电机🙂 characters\nSecond line',level:'error',source:'driver'}])
  let copied: readonly LogEntry[] = []
  const app = render(<LogCard autoFocus store={store} width={38} height={14} showTimestamp={false} levels={['error']} sources={['driver']} query="wide" onCopy={entries => { copied = entries }} />)
  await settle(); assert.doesNotMatch(app.lastFrame() ?? '', /Hidden/); assert.match(app.lastFrame() ?? '', /Second line/)
  app.stdin.write('\u001b[99;6u'); await settle()
  assert.equal(copied.length, 1); assert.equal(copied[0].message, 'A long message with wide 电机🙂 characters\nSecond line')
  app.rerender(<LogCard store={store} width={38} height={14} query="absent" />); await settle()
  assert.match(app.lastFrame() ?? '', /No matching logs/)
  store.dispose()
})
test('log mouse drag and shift navigation copy record ranges', async () => {
  const store = createLogStore({ flushIntervalMs: 0 }); store.appendMany(sample(4))
  let copied: readonly LogEntry[] = [], emit = (_event: MouseEvent) => {}
  const input = {stdin:new PassThrough(),onMouse(listener:typeof emit){emit=listener;return()=>{}},dispose(){}}
  const app = render(<MouseProvider input={input}><LogCard autoFocus store={store} width={70} height={10} showTimestamp={false} onCopy={entries => { copied = entries }} /></MouseProvider>)
  await settle()
  const frame = [...app.frames].reverse().find(frame => frame.includes('Record 01')) ?? ''
  const y = frame.split('\n').findIndex(line => line.includes('Record 01'))
  emit({action:'press',button:'left',x:10,y}); await settle()
  emit({action:'move',button:'left',x:10,y:y+2}); await settle()
  emit({action:'release',button:'left',x:10,y:y+2}); await settle()
  app.stdin.write('\u001b[99;6u'); await settle()
  assert.deepEqual(copied.map(entry => entry.id), [1,2,3])
  app.stdin.write('\u001b[1;2B'); await settle(); app.stdin.write('\u001b[99;6u'); await settle()
  assert.deepEqual(copied.map(entry => entry.id), [1,2,3,4])
  store.dispose()
})

test('controlled follow requests changes and the default copy path emits safe clipboard text', async () => {
  const store = createLogStore({flushIntervalMs:0}); store.appendMany(sample(15))
  const changes: boolean[] = []
  const screen = (follow:boolean) => <LogCard autoFocus store={store} follow={follow} onFollowChange={value=>changes.push(value)} width={60} height={8} showTimestamp={false} />
  const app=render(screen(true)); await settle()
  app.stdin.write('\u001b[H'); await settle(); assert.deepEqual(changes,[false])
  app.rerender(screen(false)); await settle(); assert.match(app.lastFrame() ?? '', /Record 01/)
  app.stdin.write('\u001b[99;6u'); await settle()
  const encoded=app.frames.flatMap(frame=>[...frame.matchAll(/\x1b\]52;c;([^\x07]*)\x07/g)]).at(-1)?.[1]
  assert.equal(Buffer.from(encoded ?? '', 'base64').toString('utf8'),'INFO driver Record 01')
  for (let i = 0; i < 3; i++) { app.stdin.write('\u001b[6~'); await settle() }
  assert.deepEqual(changes,[false,true])
  app.rerender(screen(true)); await settle(); assert.match(app.lastFrame() ?? '', /Record 15/)
  store.dispose()
})

test('large log history renders only a viewport and reflows on resize', async () => {
  const store=createLogStore({maxEntries:5000,flushIntervalMs:0})
  store.appendMany(sample(10000))
  const screen=(width:number)=> <LogCard store={store} width={width} height={9} showTimestamp={false} />
  const app=render(screen(80)); await settle()
  assert.equal(store.getSnapshot().length,5000)
  assert.equal(app.lastFrame()?.split('\n').length,9)
  assert.match(app.lastFrame() ?? '', /Record 10000/)
  app.rerender(screen(35)); await settle()
  assert.equal(app.lastFrame()?.split('\n').length,9)
  assert.match(app.lastFrame() ?? '', /10000/)
  store.dispose()
})

test('Logs gallery renders English controls and a populated log card', async () => {
  const {Gallery}=await import('../src/tui/gallery-app.js')
  const {OverlayProvider}=await import('../src/tui/overlay.js')
  process.env.EMCLI_GALLERY_TAB='logs'
  const app=render(<OverlayProvider><Gallery/></OverlayProvider>)
  delete process.env.EMCLI_GALLERY_TAB
  Object.defineProperties(app.stdout,{columns:{value:120,configurable:true},rows:{value:40,configurable:true}})
  app.stdout.emit('resize'); await settle()
  assert.match(app.lastFrame() ?? '', /Driver logs/)
  assert.match(app.lastFrame() ?? '', /Following/)
  assert.match(app.lastFrame() ?? '', /Sample 30/)
  assert.match(app.lastFrame() ?? '', /Search messages/)
  assert.doesNotMatch(app.lastFrame() ?? '', /[\p{Script=Han}]/u)
})

test('wheel scrolling to the bottom resumes follow, and End has no log binding', async () => {
  const store=createLogStore({flushIntervalMs:0}); store.appendMany(sample(15))
  let emit=(_event:MouseEvent)=>{}
  const input={stdin:new PassThrough(),onMouse(fn:typeof emit){emit=fn;return()=>{}},dispose(){}}
  const app=render(<MouseProvider input={input}><LogCard autoFocus store={store} width={70} height={8} showTimestamp={false}/></MouseProvider>); await settle()
  emit({action:'wheel',button:'wheel-up',x:10,y:3}); await settle()
  assert.match(app.lastFrame() ?? '', /Paused/)
  app.stdin.write('\u001b[F'); await settle(); assert.match(app.lastFrame() ?? '', /Paused/)
  assert.doesNotMatch(app.lastFrame() ?? '', /End: follow/)
  emit({action:'wheel',button:'wheel-down',x:10,y:3}); await settle()
  assert.match(app.lastFrame() ?? '', /Following/)
  store.append({message:'New tail'}); await settle(); assert.match(app.lastFrame() ?? '', /New tail/)
  store.dispose()
})

test('right-click copies a log selection without changing it and notifies after writer completion', async () => {
  const store=createLogStore({flushIntervalMs:0}); store.appendMany(sample(4))
  let emit=(_event:MouseEvent)=>{}, copied:readonly LogEntry[]=[], complete=()=>{}
  const input={stdin:new PassThrough(),onMouse(fn:typeof emit){emit=fn;return()=>{}},dispose(){}}
  const app=render(<MouseProvider input={input}><NotificationProvider><LogCard autoFocus store={store} width={70} height={12} showTimestamp={false} onCopy={records=>{copied=records;return new Promise<void>(resolve=>{complete=resolve})}}/></NotificationProvider></MouseProvider>)
  await settle()
  const frame=[...app.frames].reverse().find(frame=>frame.includes('Record 01')) ?? ''
  const y=frame.split('\n').findIndex(line=>line.includes('Record 01'))
  emit({action:'press',button:'left',x:10,y}); await settle()
  app.stdin.write('\u001b[1;2B'); await settle()
  emit({action:'press',button:'right',x:10,y:y+3}); await settle()
  assert.deepEqual(copied.map(entry=>entry.id),[1,2])
  assert.doesNotMatch(app.lastFrame() ?? '', /Copied to clipboard/)
  complete(); await settle(); assert.match(app.lastFrame() ?? '', /Copied to clipboard/)
  assert.match(app.lastFrame() ?? '', /Following/)
  store.dispose()
})

test('right-click input selection sends clipboard data and a notification without moving the cursor', async () => {
  let emit=(_event:MouseEvent)=>{}, current='abcd'
  const input={stdin:new PassThrough(),onMouse(fn:typeof emit){emit=fn;return()=>{}},dispose(){}}
  function Control() {
    const [value,setValue]=React.useState(current)
    return <TextInput autoFocus size="small" width={20} value={value} onChange={next=>{current=next;setValue(next)}}/>
  }
  const app=render(<MouseProvider input={input}><Box width={100} height={20}><NotificationProvider><Control/></NotificationProvider></Box></MouseProvider>); await settle()
  app.stdin.write('\u001b[1;2D'); await settle(); app.stdin.write('\u001b[1;2D'); await settle()
  emit({action:'press',button:'right',x:1,y:0}); await settle()
  assert.ok(app.frames.some(frame=>frame.includes('\u001b]52;c;'+Buffer.from('cd').toString('base64')+'\u0007')))
  assert.match(app.lastFrame() ?? '', /Copy request sent to terminal/)
  app.stdin.write('X'); await settle(); assert.equal(current,'abX')
})

test('copy writer failure produces an error notification instead of success', async () => {
  const store=createLogStore({flushIntervalMs:0}); store.append({message:'Record'})
  const app=render(<NotificationProvider><LogCard autoFocus store={store} width={70} height={12} onCopy={async()=>{throw new Error('unavailable')}}/></NotificationProvider>); await settle()
  app.stdin.write('\u001b[99;6u'); await settle()
  assert.match(app.lastFrame() ?? '', /Could not copy to clipboard/)
  assert.doesNotMatch(app.lastFrame() ?? '', /Copied to clipboard/)
  store.dispose()
})

test('dragging outside keeps scrolling without mouse events and stops on release', async () => {
 const store=createLogStore({flushIntervalMs:0});store.appendMany(sample(30))
 let copied:readonly LogEntry[]=[],emit=(_event:MouseEvent)=>{}
 const input={stdin:new PassThrough(),onMouse(listener:typeof emit){emit=listener;return()=>{}},dispose(){}}
 const app=render(<MouseProvider input={input}><LogCard autoFocus store={store} width={70} height={10} showTimestamp={false} onCopy={entries=>{copied=entries}}/></MouseProvider>)
 await settle()
 const y=(app.lastFrame()??'').split('\n').findIndex(line=>line.includes('Record'))
 emit({action:'press',button:'left',x:10,y:y+2});await settle()
 emit({action:'move',button:'left',x:10,y:y-1});await settle()
 const first=app.lastFrame();await new Promise(resolve=>setTimeout(resolve,400));assert.notEqual(app.lastFrame(),first)
 emit({action:'release',button:'left',x:10,y:y-1});await settle()
 const stopped=app.lastFrame();await new Promise(resolve=>setTimeout(resolve,300));assert.equal(app.lastFrame(),stopped)
 app.stdin.write('\u001b[99;6u');await settle();assert.ok(copied.length>4)
 store.dispose()
})
