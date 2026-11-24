import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'
import React, { useState } from 'react'
import { Box, Text } from 'ink'
import { render, cleanup } from 'ink-testing-library'
import { PassThrough } from 'node:stream'
import { Card, Table, TreeList, Button, TextInput, SliderInput } from '../src/tui/index.js'
import { MouseProvider, type MouseEvent } from '../src/tui/mouse.js'
const settle = () => new Promise(resolve => setTimeout(resolve, 80))
afterEach(cleanup)
function mouse() {
  let emit = (_event: MouseEvent) => {}
  const input = { stdin: new PassThrough(), onMouse(listener: typeof emit) { emit = listener; return () => {} }, dispose() {} }
  return { input, emit: (event: MouseEvent) => emit(event) }
}
test('card clips overflow, scrolls by wheel and thumb, and removes scrollbar after shrink', async () => {
  const pointer = mouse()
  const screen = (count: number) => <MouseProvider input={pointer.input}><Card title="Events" width={28} height={6}>{Array.from({ length: count }, (_, i) => <Text key={i}>Row {String(i + 1).padStart(2, '0')}</Text>)}</Card></MouseProvider>
  const app = render(screen(12)); await settle()
  assert.match(app.lastFrame() ?? '', /Row 01/); assert.doesNotMatch(app.lastFrame() ?? '', /Row 12/)
  assert.match(app.lastFrame() ?? '', /┃/)
  pointer.emit({ action: 'wheel', button: 'wheel-down', x: 4, y: 2 }); await settle()
  assert.doesNotMatch(app.lastFrame() ?? '', /Row 01/); assert.match(app.lastFrame() ?? '', /Row 04/)
  const lines = (app.lastFrame() ?? '').split('\n'), y = lines.findIndex(line => line.includes('┃')), x = lines[y].indexOf('┃')
  pointer.emit({ action: 'press', button: 'left', x, y }); await settle()
  pointer.emit({ action: 'move', button: 'left', x, y: 4 }); await settle()
  pointer.emit({ action: 'release', button: 'left', x, y: 4 }); await settle()
  assert.match(app.lastFrame() ?? '', /Row 12/)
  assert.equal(app.lastFrame()?.split('\n').length, 6)
  app.rerender(screen(2)); await settle()
  assert.match(app.lastFrame() ?? '', /Row 01/); assert.doesNotMatch(app.lastFrame() ?? '', /┃/)
})
test('card border corners stay aligned under flex resizing', async () => {
  const screen = (width: number) => <Box width={width} gap={1}>{['Latency', 'Throughput', 'Loss'].map(title => <Card key={title} title={title} width={24} height={5}><Text>value</Text></Card>)}</Box>
  const app = render(screen(55)); await settle()
  for (const width of [55, 42, 70]) {
    app.rerender(screen(width)); await settle()
    const lines = (app.lastFrame() ?? '').split('\n')
    const positions = (line: string, char: string) => [...line].flatMap((cell, index) => cell === char ? [index] : [])
    assert.deepEqual(positions(lines[0], '┌'), positions(lines.at(-1)!, '└'))
    assert.deepEqual(positions(lines[0], '┐'), positions(lines.at(-1)!, '┘'))
    assert.equal(positions(lines[0], '┌').length, 3)
  }
})
test('scrolling a card keeps click coordinates aligned with visible controls', async () => {
  const pointer = mouse(); let selected = -1
  const app = render(<MouseProvider input={pointer.input}><Card title="Actions" width={28} height={5}>{Array.from({ length: 8 }, (_, i) => <Button key={i} size="small" label={`Action ${i}`} onPress={() => { selected = i }} />)}</Card></MouseProvider>)
  await settle(); pointer.emit({ action: 'wheel', button: 'wheel-down', x: 5, y: 2 }); await settle()
  assert.match(app.lastFrame() ?? '', /Action 3/)
  pointer.emit({ action: 'press', button: 'left', x: 5, y: 1 }); await settle(); assert.equal(selected, 3)
  pointer.emit({ action: 'press', button: 'left', x: 5, y: 0 }); await settle(); assert.equal(selected, 3)
})
test('table keeps header while scrolling and clamps after data shrinks', async () => {
  const pointer = mouse()
  const screen = (count: number) => <MouseProvider input={pointer.input}><Table columns={[{ key: 'name', header: 'Name', width: 12, value: (row: number) => `Motor ${row}` }]} rows={Array.from({ length: count }, (_, i) => i)} rowKey={row => String(row)} height={3} /></MouseProvider>
  const app = render(screen(10)); await settle()
  pointer.emit({ action: 'wheel', button: 'wheel-down', x: 4, y: 3 }); await settle()
  assert.match(app.lastFrame() ?? '', /Name/); assert.match(app.lastFrame() ?? '', /Motor 3/); assert.doesNotMatch(app.lastFrame() ?? '', /Motor 0/)
  app.rerender(screen(1)); await settle(); assert.match(app.lastFrame() ?? '', /Motor 0/); assert.doesNotMatch(app.lastFrame() ?? '', /┃/)
})
test('tree shows branch guides and collapses its descendants', async () => {
  const app = render(<TreeList autoFocus nodes={[{ id: 'root', label: 'Root', children: [{ id: 'a', label: 'First' }, { id: 'b', label: 'Last' }] }]} />)
  await settle(); assert.match(app.lastFrame() ?? '', /├─/); assert.match(app.lastFrame() ?? '', /└─/)
  app.stdin.write(' '); await settle(); assert.doesNotMatch(app.lastFrame() ?? '', /First|Last/)
  app.stdin.write(' '); await settle(); assert.match(app.lastFrame() ?? '', /First/)
})

test('wide card content gets a horizontal scrollbar and scrolls without moving its border', async () => {
  const pointer = mouse()
  const app = render(<MouseProvider input={pointer.input}><Card title="Wide" width={24} height={6}><Box width={50} flexShrink={0}><Text>START-0123456789012345678901234567890123456789-END</Text></Box></Card></MouseProvider>)
  await settle(); assert.match(app.lastFrame() ?? '', /START/); assert.match(app.lastFrame() ?? '', /━/)
  const lines = (app.lastFrame() ?? '').split('\n'), y = lines.findIndex(line => line.includes('━')), x = lines[y].indexOf('━')
  pointer.emit({ action: 'press', button: 'left', x, y }); await settle()
  pointer.emit({ action: 'move', button: 'left', x: 21, y }); await settle()
  pointer.emit({ action: 'release', button: 'left', x: 21, y }); await settle()
  assert.doesNotMatch(app.lastFrame() ?? '', /START/); assert.match(app.lastFrame() ?? '', /END/)
  assert.equal(app.lastFrame()?.split('\n').length, 6)
})
test('tabbing into a clipped control reveals it automatically', async () => {
  const { NavigationProvider } = await import('../src/tui/navigation.js')
  const app = render(<NavigationProvider><Card title="Actions" width={28} height={5}>{Array.from({ length: 8 }, (_, i) => <Button key={i} size="small" label={`Action ${i}`} autoFocus={i === 0} />)}</Card></NavigationProvider>)
  await settle()
  for (let i = 0; i < 6; i++) { app.stdin.write('\t'); await settle() }
  assert.match(app.lastFrame() ?? '', /Action 6/)
})

test('both scrollbar tracks remain inside the card border', async () => {
  const app = render(<Card title="Both axes" width={24} height={7}><Box width={50} flexDirection="column" flexShrink={0}>{Array.from({ length: 20 }, (_, i) => <Text key={i}>{String(i).padStart(2, '0')} {'wide '.repeat(9)}</Text>)}</Box></Card>)
  await settle()
  const lines = (app.lastFrame() ?? '').split('\n')
  assert.equal(lines.length, 7)
  assert.match(lines.at(-1) ?? '', /^└─+┘$/)
  assert.ok(lines.slice(1, -1).some(line => line.includes('┃')))
  assert.ok(lines.slice(1, -1).some(line => line.includes('━')))
})

test('a table without its own overflow lets its enclosing card handle the wheel', async () => {
  const pointer = mouse()
  const app = render(<MouseProvider input={pointer.input}><Card title="Table card" width={26} height={6}><Table columns={[{ key: 'name', header: 'Name', width: 12, value: (row: number) => `Motor ${row}` }]} rows={[0, 1, 2, 3, 4, 5]} rowKey={row => String(row)} height={6} /></Card></MouseProvider>)
  await settle(); assert.match(app.lastFrame() ?? '', /Name/)
  pointer.emit({ action: 'wheel', button: 'wheel-down', x: 5, y: 3 }); await settle()
  assert.doesNotMatch(app.lastFrame() ?? '', /Name/)
  assert.match(app.lastFrame() ?? '', /Motor 3/)
})

test('tree uses one large triangle for buses and toggles it on the first click', async () => {
  const pointer = mouse()
  const app = render(<MouseProvider input={pointer.input}><TreeList nodes={[{ id: 'root', label: 'Root', children: [{ id: 'bus', kind: 'bus', label: 'Bus', children: [{ id: 'leaf', label: 'Leaf' }] }] }]} /></MouseProvider>)
  const frame = () => [...app.frames].reverse().find(value => value.includes('Root')) ?? ''
  await settle(); assert.match(frame(), /▼ Bus/); assert.doesNotMatch(frame(), /▸|▾/)
  pointer.emit({ action: 'press', button: 'left', x: 4, y: 2 }); await settle()
  assert.match(frame(), /▶ Bus/); assert.doesNotMatch(frame(), /Leaf/)
})


test('input clicks place the insertion cursor between characters and after the last character', async () => {
  for (const size of ['small', 'large'] as const) {
    const pointer = mouse(); let current = 'abcd'
    function Control() { const [value, setValue] = useState(current); return <TextInput size={size} width={16} autoFocus value={value} onChange={next => { current = next; setValue(next) }} /> }
    const app = render(<MouseProvider input={pointer.input}><Control /></MouseProvider>); await settle()
    app.stdin.write('\u001b[H'); await settle()
    const inset = size === 'small' ? 1 : 2, y = size === 'small' ? 0 : 1
    pointer.emit({ action: 'press', button: 'left', x: inset + 4, y }); await settle()
    app.stdin.write('X'); await settle(); assert.equal(current, 'abcdX')
    pointer.emit({ action: 'press', button: 'left', x: inset + 2, y }); await settle()
    app.stdin.write('Y'); await settle(); assert.equal(current, 'abYcdX')
    app.unmount()
  }
})
test('input click positions account for wide characters and grapheme clusters', async () => {
  const pointer = mouse(); let current = '电机🙂'
  function Control() { const [value, setValue] = useState(current); return <TextInput size="small" width={16} value={value} onChange={next => { current = next; setValue(next) }} /> }
  const app = render(<MouseProvider input={pointer.input}><Control /></MouseProvider>); await settle()
  pointer.emit({ action: 'press', button: 'left', x: 7, y: 0 }); await settle()
  app.stdin.write('!'); await settle(); assert.equal(current, '电机🙂!')
  pointer.emit({ action: 'press', button: 'left', x: 3, y: 0 }); await settle()
  app.stdin.write('A'); await settle(); assert.equal(current, '电A机🙂!')
})
test('slider input synchronizes drag and entry, clamps values, and rejects invalid drafts', async () => {
  const pointer = mouse(); let current = 4
  function Control() { const [value, setValue] = useState(current); return <SliderInput width={24} inputWidth={8} min={0} max={10} step={2} value={value} onChange={next => { current = next; setValue(next) }} /> }
  const app = render(<MouseProvider input={pointer.input}><Control /></MouseProvider>); await settle()
  pointer.emit({ action: 'press', button: 'left', x: 14, y: 0 }); await settle()
  pointer.emit({ action: 'release', button: 'left', x: 14, y: 0 }); await settle(); assert.equal(current, 10)
  pointer.emit({ action: 'press', button: 'left', x: 20, y: 0 }); await settle()
  app.stdin.write('\u001b[F'); await settle(); app.stdin.write('\u007f'); await settle(); app.stdin.write('\u007f'); await settle()
  app.stdin.write('7'); await settle(); app.stdin.write('\r'); await settle(); assert.equal(current, 8)
  app.stdin.write('\u001b[F'); await settle(); app.stdin.write('\u007f'); await settle(); app.stdin.write('99'); await settle(); app.stdin.write('\r'); await settle(); assert.equal(current, 10)
  app.stdin.write('oops'); await settle(); app.stdin.write('\r'); await settle(); assert.equal(current, 10)
  assert.doesNotMatch(app.lastFrame() ?? '', /oops/)
  assert.equal(app.lastFrame()?.split('\n').length, 1)
})

test('slider input maps decimal drafts immediately without erasing unfinished input', async () => {
  const pointer = mouse(); let current = 0
  function Control() { const [value, setValue] = useState(current); return <SliderInput width={24} inputWidth={10} min={-10} max={10} value={value} onChange={next => { current = next; setValue(next) }} /> }
  const app = render(<MouseProvider input={pointer.input}><Control /></MouseProvider>); await settle()
  pointer.emit({ action: 'press', button: 'left', x: 19, y: 0 }); await settle()
  app.stdin.write('\u001b[F'); await settle(); app.stdin.write('\u007f'); await settle()
  app.stdin.write('-'); await settle(); assert.equal(current, 0)
  app.stdin.write('1'); await settle(); assert.equal(current, -1)
  app.stdin.write('.'); await settle(); assert.match(app.lastFrame() ?? '', /-1\./)
  app.stdin.write('25'); await settle(); assert.equal(current, -1.25)
  app.stdin.write('0'); await settle(); assert.match(app.lastFrame() ?? '', /-1\.250/)
  const before = app.lastFrame()?.indexOf('●')
  app.stdin.write('\u001b[H'); await settle(); app.stdin.write('\u001b[3~'); await settle()
  assert.equal(current, 1.25)
  assert.ok((app.lastFrame()?.indexOf('●') ?? 0) > (before ?? 0))
})

test('input mouse drag selects graphemes for replacement and release stops selection', async () => {
  const pointer = mouse(); let current = '电机🙂abcd'
  function Control() { const [value, setValue] = useState(current); return <TextInput size="small" width={20} value={value} onChange={next => { current = next; setValue(next) }} /> }
  const app = render(<MouseProvider input={pointer.input}><Control /></MouseProvider>); await settle()
  pointer.emit({ action: 'press', button: 'left', x: 3, y: 0 }); await settle()
  pointer.emit({ action: 'move', button: 'left', x: 7, y: 0 }); await settle()
  pointer.emit({ action: 'release', button: 'left', x: 7, y: 0 }); await settle()
  pointer.emit({ action: 'move', button: 'other', x: 10, y: 0 }); await settle()
  app.stdin.write('X'); await settle(); assert.equal(current, '电Xabcd')
  pointer.emit({ action: 'press', button: 'left', x: 9, y: 0 }); await settle()
  pointer.emit({ action: 'move', button: 'left', x: 3, y: 0 }); await settle()
  pointer.emit({ action: 'release', button: 'left', x: 3, y: 0 }); await settle()
  app.stdin.write('\u007f'); await settle(); assert.equal(current, '电')
})

test('gallery Ctrl+Shift+C copies the input selection without exiting', async () => {
  const { Gallery } = await import('../src/tui/gallery-app.js')
  const { OverlayProvider } = await import('../src/tui/overlay.js')
  const pointer = mouse()
  process.env.EMCLI_GALLERY_TAB = 'inputs'
  const app = render(<MouseProvider input={pointer.input}><OverlayProvider><Gallery /></OverlayProvider></MouseProvider>)
  delete process.env.EMCLI_GALLERY_TAB
  Object.defineProperties(app.stdout, { columns: { value: 160, configurable: true }, rows: { value: 54, configurable: true } })
  app.stdout.emit('resize'); await settle()
  const lines = (app.lastFrame() ?? '').split('\n')
  const y = lines.findIndex(line => line.includes('Motor 1')), x = lines[y].indexOf('Motor 1') + 7
  pointer.emit({ action: 'press', button: 'left', x, y }); await settle()
  pointer.emit({ action: 'release', button: 'left', x, y }); await settle()
  app.stdin.write('\u0001'); await settle()
  app.stdin.write('\u001b[99;6u'); await settle()
  assert.ok(app.frames.some(frame => frame.includes('\u001b]52;c;' + Buffer.from('Motor 1').toString('base64') + '\u0007')))
  app.stdin.write('Copied'); await settle(); assert.match(app.lastFrame() ?? '', /Copied/)
  app.stdin.write('\u0003'); await settle()
  const frames = app.frames.length
  app.stdin.write('After exit'); await settle()
  assert.equal(app.frames.length, frames)
})

test('slider input precision controls rounding, committed display and default slider step', async () => {
  const pointer = mouse(); let current = 1.2
  function Control({ precision }: { precision: number }) {
    const [value, setValue] = useState(current)
    return <SliderInput precision={precision} width={30} inputWidth={12} min={-10} max={10} value={value} onChange={next => { current = next; setValue(next) }} />
  }
  const screen = (precision: number) => <MouseProvider input={pointer.input}><Control precision={precision} /></MouseProvider>
  const app = render(screen(2)); await settle()
  assert.ok(app.frames.some(frame => frame.includes('1.20')))
  pointer.emit({ action: 'press', button: 'left', x: 20, y: 0 }); await settle()
  app.stdin.write('\u0001'); await settle(); app.stdin.write('2.346'); await settle()
  assert.equal(current, 2.35); assert.match(app.lastFrame() ?? '', /2\.346/)
  app.stdin.write('\r'); await settle(); assert.match(app.lastFrame() ?? '', /2\.35/)
  app.stdin.write('\u001b[Z'); await settle(); app.stdin.write('\u001b[C'); await settle()
  assert.equal(current, 2.36); assert.match(app.lastFrame() ?? '', /2\.36/)
  app.rerender(screen(0)); await settle()
  assert.match(app.lastFrame() ?? '', /\s2\s*$/)
  app.stdin.write('\u001b[C'); await settle(); assert.equal(current, 3)
})

test('directional navigation reveals clipped siblings before leaving a scroll card and accepts repeat bursts', async () => {
  const {NavigationProvider}=await import('../src/tui/navigation.js')
  let pressed=-1
  const app=render(<NavigationProvider><Box flexDirection="column"><Button label="Outside" size="small" onPress={()=>{pressed=99}}/><Card title="Scroll focus" width={30} height={6}>{Array.from({length:12},(_,i)=><Button key={i} autoFocus={i===0} size="small" label={`Item ${i}`} onPress={()=>{pressed=i}}/>)}</Card></Box></NavigationProvider>)
  await settle()
  app.stdin.write('\u001b[B'.repeat(6)); await settle()
  app.stdin.write('\r'); await settle(); assert.equal(pressed,6)
  assert.match(app.lastFrame() ?? '', /Item 6/)
  app.stdin.write('\u001b[1;1:2A'.repeat(5)); await settle()
  app.stdin.write('\u001b[1;1:3A'); await settle()
  app.stdin.write('\r'); await settle(); assert.equal(pressed,1)
  assert.match(app.lastFrame() ?? '', /Item 1/)
  app.stdin.write('\u001b[A'); await settle(); app.stdin.write('\r'); await settle(); assert.equal(pressed,0)
  app.stdin.write('\u001b[A'); await settle(); app.stdin.write('\r'); await settle(); assert.equal(pressed,99)
})
test('Tab and Shift+Tab repeat events traverse each focus stop and ignore release', async () => {
  const {NavigationProvider}=await import('../src/tui/navigation.js')
  let pressed=-1
  const app=render(<NavigationProvider><Box flexDirection="column">{Array.from({length:8},(_,i)=><Button key={i} autoFocus={i===0} size="small" label={`Tab ${i}`} onPress={()=>{pressed=i}}/>)}</Box></NavigationProvider>)
  await settle()
  app.stdin.write('\u001b[9;1:2u'.repeat(5)); await settle()
  app.stdin.write('\u001b[9;1:3u'); await settle()
  app.stdin.write('\r'); await settle(); assert.equal(pressed,5)
  app.stdin.write('\u001b[9;2:2u'.repeat(3)); await settle()
  app.stdin.write('\r'); await settle(); assert.equal(pressed,2)
})


test('tree expands a newly populated branch after asynchronous discovery', async () => {
  const app=render(<TreeList nodes={[{id:'adapter',label:'Adapter',children:[]}]}/>);await settle()
  app.rerender(<TreeList nodes={[{id:'adapter',label:'Adapter',children:[{id:'bus',label:'Bus',children:[{id:'motor',label:'Discovered motor'}]}]}]}/>);await settle();await settle()
  assert.match(app.lastFrame()??'',/Discovered motor/)
})
