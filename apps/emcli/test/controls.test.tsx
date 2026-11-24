import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'
import React, { useState } from 'react'
import { Box, Text } from 'ink'
import { render, cleanup } from 'ink-testing-library'
import { TextInput, Slider, Button, Dialog, DialogHost, NotificationProvider, useNotifications, Footer } from '../src/tui/index.js'
afterEach(cleanup)
const settle = () => new Promise(resolve => setTimeout(resolve, 60))
test('input edits at cursor, submits and has exact size variants', async () => {
  let submitted = ''
  function Input() { const [value, setValue] = useState('ac'); return <TextInput autoFocus value={value} onChange={setValue} onSubmit={value => { submitted = value }} /> }
  const app = render(<Input />)
  await settle(); app.stdin.write('\u001b[D'); await settle(); app.stdin.write('b'); await settle(); app.stdin.write('\r'); await settle()
  assert.equal(submitted, 'abc')
  assert.equal(app.lastFrame()?.split('\n').length, 3)
  app.unmount()
  const small = render(<TextInput size="small" value="small" onChange={() => {}} />)
  assert.equal(small.lastFrame()?.split('\n').length, 1); small.unmount()
})
test('slider obeys step, bounds and disabled state', async () => {
  let latest = 8
  function Control() { const [value, setValue] = useState(8); return <Slider autoFocus min={0} max={10} step={2} value={value} onChange={next => { latest = next; setValue(next) }} /> }
  const app = render(<Control />); await settle()
  app.stdin.write('\u001b[C'); await settle(); assert.equal(latest, 10)
  app.stdin.write('\u001b[C'); await settle(); assert.equal(latest, 10)
  app.stdin.write('\u001b[D'); await settle(); assert.equal(latest, 8); app.unmount()
  const disabled = render(<Slider disabled autoFocus value={5} onChange={() => assert.fail('disabled changed')} />)
  await settle(); disabled.stdin.write('\u001b[C'); await settle(); disabled.unmount()
})
test('dialog traps tab navigation and restores the opening control', async () => {
  let background = 0
  function Screen() { const [open, setOpen] = useState(false); return <Box width={80} height={24}><DialogHost dialog={open ? <Dialog title="Confirm changes" onClose={() => setOpen(false)} onConfirm={() => setOpen(false)} /> : undefined}><Button autoFocus label="Open" onPress={() => { background++; setOpen(true) }} /></DialogHost></Box> }
  const app = render(<Screen />); await settle(); app.stdin.write('\r'); await settle()
  assert.match(app.lastFrame() ?? '', /Confirm changes/)
  for (let i = 0; i < 4; i++) { app.stdin.write('\t'); await settle() }
  assert.equal(background, 1)
  app.stdin.write('\u001b'); await settle(); assert.doesNotMatch(app.lastFrame() ?? '', /Confirm changes/)
  app.stdin.write('\r'); await settle(); assert.equal(background, 2); app.unmount()
})
test('notifications expire and can be explicitly dismissed', async () => {
  let notify!: ReturnType<typeof useNotifications>['notify'], dismiss!: ReturnType<typeof useNotifications>['dismiss']
  function Probe() { ({ notify, dismiss } = useNotifications()); return <Text>Ready</Text> }
  const app = render(<Box width={80} height={24}><NotificationProvider><Probe /></NotificationProvider></Box>); await settle()
  notify('Saved', { severity: 'success', timeout: 180 }); await settle(); assert.match(app.lastFrame() ?? '', /Saved/)
  await new Promise(resolve => setTimeout(resolve, 200)); assert.doesNotMatch(app.lastFrame() ?? '', /Saved/)
  const id = notify('Persistent', { timeout: 0 }); await settle(); assert.match(app.lastFrame() ?? '', /Persistent/)
  dismiss(id); await settle(); assert.doesNotMatch(app.lastFrame() ?? '', /Persistent/); app.unmount()
})
test('footer runs bound combination and ignores ordinary typing', async () => {
  let calls = 0
  const app = render(<Footer actions={[{ key: 'ctrl+n', label: 'Notify', onPress: () => { calls++ } }]} />)
  await settle(); app.stdin.write('n'); await settle(); assert.equal(calls, 0)
  app.stdin.write('\u000e'); await settle(); assert.equal(calls, 1); app.unmount()
})

test('slider mouse click and drag reach both ends', async () => {
  const { MouseProvider } = await import('../src/tui/mouse.js')
  const { PassThrough } = await import('node:stream')
  let emit: (event: import('../src/tui/mouse.js').MouseEvent) => void = () => {}
  const input = { stdin: new PassThrough(), onMouse(listener: typeof emit) { emit = listener; return () => {} }, dispose() {} }
  let value = 0
  function Control() { const [current, setCurrent] = useState(0); return <Slider width={11} value={current} onChange={next => { value = next; setCurrent(next) }} /> }
  const app = render(<MouseProvider input={input}><Control /></MouseProvider>); await settle()
  emit({ action: 'press', button: 'left', x: 5, y: 0 }); await settle(); assert.equal(value, 50)
  emit({ action: 'move', button: 'left', x: 15, y: 0 }); await settle(); assert.equal(value, 100)
  emit({ action: 'release', button: 'left', x: 15, y: 0 }); await settle()
  emit({ action: 'move', button: 'other', x: 0, y: 0 }); await settle(); assert.equal(value, 100)
  app.unmount()
})

test('directional focus follows layout and skips disabled buttons', async () => {
  const { NavigationProvider } = await import('../src/tui/navigation.js')
  let pressed = ''
  const app = render(<NavigationProvider><Box flexDirection="column"><Box gap={2}><Button label="Left" autoFocus onPress={() => { pressed = 'left' }} /><Button label="Disabled" disabled /><Button label="Right" onPress={() => { pressed = 'right' }} /></Box><Button label="Below" onPress={() => { pressed = 'below' }} /></Box></NavigationProvider>)
  await settle(); app.stdin.write('\u001b[C'); await settle(); app.stdin.write('\r'); await settle(); assert.equal(pressed, 'right')
  app.stdin.write('\u001b[B'); await settle(); app.stdin.write('\r'); await settle(); assert.equal(pressed, 'below'); app.unmount()
})
test('menu arrows select a closed trigger and Enter expands that menu', async () => {
  const { MenuBar } = await import('../src/tui/components/MenuBar.js')
  const { OverlayProvider } = await import('../src/tui/overlay.js')
  const app = render(<Box height={20}><OverlayProvider><MenuBar autoFocus menus={[{ id: 'a', label: 'File', items: [{ id: 'new', label: 'New file' }] }, { id: 'b', label: 'View', items: [{ id: 'zoom', label: 'Zoom in' }] }]} /></OverlayProvider></Box>)
  await settle(); app.stdin.write('\u001b[C'); await settle(); assert.doesNotMatch(app.lastFrame() ?? '', /Zoom in/)
  app.stdin.write('\r'); await settle(); assert.match(app.lastFrame() ?? '', /Zoom in/); app.unmount()
})
test('dropdown arrows leave it closed, Enter joins popup to bottom border', async () => {
  const { Dropdown } = await import('../src/tui/components/Dropdown.js')
  const { OverlayProvider, clampOverlay } = await import('../src/tui/overlay.js')
  assert.equal(clampOverlay({ x: 0, y: 1, height: 3 }, { width: 20, height: 4 }, { columns: 80, rows: 24 }).top, 3)
  const app = render(<Box height={20}><OverlayProvider><Dropdown label="Rate" autoFocus value="a" options={[{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }]} onChange={() => {}} /></OverlayProvider></Box>)
  await settle(); assert.match(app.lastFrame() ?? '', /▼/); app.stdin.write('\u001b[B'); await settle(); assert.doesNotMatch(app.lastFrame() ?? '', /Beta/)
  app.stdin.write('\r'); await settle(); const lines = (app.lastFrame() ?? '').split('\n')
  assert.match(app.lastFrame() ?? '', /▲/); assert.doesNotMatch(app.lastFrame() ?? '', /▴|▾/)
  const joint = lines.findIndex(line => line.includes('├'))
  assert.ok(joint > 0); assert.match(lines[joint - 1], /Alpha/); assert.match(lines[joint + 1], /Alpha/); app.unmount()
})
test('button interaction changes lighting without changing its semantic hue', async () => {
  const { buttonPalette } = await import('../src/tui/components/Button.js')
  for (const variant of ['primary', 'danger'] as const) {
    const normal = buttonPalette(variant, false, false)
    assert.notEqual(buttonPalette(variant, true, false).bg, normal.bg)
    assert.notEqual(buttonPalette(variant, true, true).bg, normal.bg)
  }
})

test('button press preserves tall edge geometry and layout', async () => {
  const app = render(<Button label="Press" autoFocus />)
  await settle(); const resting = app.lastFrame()
  app.stdin.write('\r'); await settle(); assert.equal(app.lastFrame(), resting)
  assert.match(app.lastFrame() ?? '', /▔/)
  assert.match(app.lastFrame() ?? '', /▁/)
  await new Promise(resolve => setTimeout(resolve, 160)); assert.equal(app.lastFrame(), resting); app.unmount()
})
test('tab underline travels across cells then settles under the target label', async () => {
  const { Tabs } = await import('../src/tui/components/Tabs.js')
  const items = [{ id: 'a', label: 'First' }, { id: 'b', label: 'Second' }, { id: 'c', label: 'Destination' }]
  const app = render(<Tabs value="a" onChange={() => {}} items={items} />)
  await settle()
  const position = () => (app.lastFrame() ?? '').split('\n')[1].indexOf('━')
  const initial = position()
  app.rerender(<Tabs value="c" onChange={() => {}} items={items} />)
  await new Promise(resolve => setTimeout(resolve, 80))
  const intermediate = position()
  await new Promise(resolve => setTimeout(resolve, 150))
  const final = position()
  assert.ok(initial < intermediate && intermediate < final, `${initial} < ${intermediate} < ${final}`)
  assert.equal(final, 16)
  assert.equal((app.lastFrame() ?? '').split('\n')[1].match(/━/g)?.length, 'Destination'.length)
  app.unmount()
})
test('opening a menu transfers the active border to the popup and closing restores it', async () => {
  const { MenuBar } = await import('../src/tui/components/MenuBar.js')
  const { OverlayProvider } = await import('../src/tui/overlay.js')
  const app = render(<Box height={20}><OverlayProvider><MenuBar autoFocus menus={[{ id: 'file', label: 'File', items: [{ id: 'new', label: 'Create file' }] }]} /></OverlayProvider></Box>)
  await settle(); assert.match((app.lastFrame() ?? '').split('\n')[0], /┏/)
  app.stdin.write('\r'); await settle()
  const opened = (app.lastFrame() ?? '').split('\n')
  assert.match(opened[0], /┌/)
  assert.ok(opened.slice(1).some(line => line.includes('┏')))
  app.stdin.write('\u001b'); await settle(); assert.match((app.lastFrame() ?? '').split('\n')[0], /┏/)
  app.unmount()
})


test('large, medium and small buttons have exact heights and activate once', async () => {
  for (const size of ['large', 'medium', 'small'] as const) {
    let calls = 0
    const app = render(<Button size={size} label="Run" autoFocus onPress={() => { calls++ }} />)
    await settle()
    assert.equal(app.lastFrame()?.split('\n').length, size === 'small' ? 1 : 3)
    app.stdin.write('\r'); await settle(); assert.equal(calls, 1)
    app.unmount()
  }
})
test('disabled semantic buttons retain distinct tinted fills and ignore activation', async () => {
  const { buttonPalette } = await import('../src/tui/components/Button.js')
  assert.notEqual(buttonPalette('primary', false, false, true).bg, buttonPalette('danger', false, false, true).bg)
  for (const size of ['large', 'medium', 'small'] as const) {
    const app = render(<Button size={size} label="Disabled" disabled autoFocus onPress={() => assert.fail('disabled button activated')} />)
    await settle(); app.stdin.write('\r'); await settle(); app.unmount()
  }
})

test('menu trigger toggles its popup and switching triggers keeps the new menu open', async () => {
  const { MenuBar } = await import('../src/tui/components/MenuBar.js')
  const { OverlayProvider } = await import('../src/tui/overlay.js')
  const { MouseProvider } = await import('../src/tui/mouse.js')
  const { PassThrough } = await import('node:stream')
  let emit = (_event: import('../src/tui/mouse.js').MouseEvent) => {}
  const input = { stdin: new PassThrough(), onMouse(listener: typeof emit) { emit = listener; return () => {} }, dispose() {} }
  const app = render(<MouseProvider input={input}><Box width={80} height={20}><OverlayProvider><MenuBar menus={[
    { id: 'file', label: 'File', items: [{ id: 'new', label: 'Create file' }] },
    { id: 'view', label: 'View', items: [{ id: 'zoom', label: 'Zoom in' }] },
  ]} /></OverlayProvider></Box></MouseProvider>)
  await settle()
  const click = async (x: number) => {
    emit({ action: 'press', button: 'left', x, y: 1 }); await settle()
    emit({ action: 'release', button: 'left', x, y: 1 }); await settle()
  }
  await click(4); assert.match(app.lastFrame() ?? '', /Create file/)
  await click(4); assert.doesNotMatch(app.lastFrame() ?? '', /Create file/)
  await click(4); assert.match(app.lastFrame() ?? '', /Create file/)
  await click(10); assert.match(app.lastFrame() ?? '', /Zoom in/); assert.doesNotMatch(app.lastFrame() ?? '', /Create file/)
  await click(10); assert.doesNotMatch(app.lastFrame() ?? '', /Zoom in/)
})

test('input supports shift selection, replacement, select all and deleting a selection', async () => {
  let current = '电机🙂abc'
  function Control() { const [value, setValue] = useState(current); return <TextInput autoFocus value={value} onChange={next => { current = next; setValue(next) }} /> }
  const app = render(<Control />); await settle()
  app.stdin.write('\u001b[1;2D'); await settle()
  app.stdin.write('\u001b[1;2D'); await settle()
  app.stdin.write('Z'); await settle(); assert.equal(current, '电机🙂aZ')
  app.stdin.write('\u001b[1;2H'); await settle()
  app.stdin.write('\u007f'); await settle(); assert.equal(current, '')
  app.stdin.write('12.34'); await settle()
  app.stdin.write('\u0001'); await settle()
  app.stdin.write('5.6'); await settle(); assert.equal(current, '5.6')
  app.stdin.write('\u001b[H'); await settle()
  app.stdin.write('\u001b[1;2F'); await settle()
  app.stdin.write('\u001b[3~'); await settle(); assert.equal(current, '')
})

test('plain arrow collapses a selection at its edge before inserting', async () => {
  let current = 'abcd'
  function Control() { const [value, setValue] = useState(current); return <TextInput autoFocus value={value} onChange={next => { current = next; setValue(next) }} /> }
  const app = render(<Control />); await settle()
  app.stdin.write('\u001b[1;2D'); await settle(); app.stdin.write('\u001b[1;2D'); await settle()
  app.stdin.write('\u001b[D'); await settle(); app.stdin.write('X'); await settle()
  assert.equal(current, 'abXcd')
})

test('Ctrl+Shift+C copies only the selected graphemes and preserves the selection', async () => {
  let current = '电机🙂abc'
  function Control() { const [value, setValue] = useState(current); return <TextInput autoFocus value={value} onChange={next => { current = next; setValue(next) }} /> }
  const app = render(<Control />); await settle()
  const copies = () => app.frames.flatMap(frame => [...frame.matchAll(/\x1b\]52;c;([^\x07]*)\x07/g)].map(match => Buffer.from(match[1], 'base64').toString('utf8')))
  app.stdin.write('\u001b[99;6u'); await settle(); assert.deepEqual(copies(), [])
  app.stdin.write('\u001b[H'); await settle()
  for (let i = 0; i < 3; i++) { app.stdin.write('\u001b[1;2C'); await settle() }
  app.stdin.write('\u001b[99;6u'); await settle()
  assert.deepEqual(copies(), ['电机🙂'])
  assert.equal(current, '电机🙂abc')
  app.stdin.write('X'); await settle(); assert.equal(current, 'Xabc')
})

test('password fields do not copy their underlying secret', async () => {
  const app = render(<TextInput autoFocus password value="secret" onChange={() => {}} />); await settle()
  app.stdin.write('\u0001'); await settle(); app.stdin.write('\u001b[99;6u'); await settle()
  assert.ok(app.frames.every(frame => !frame.includes('\u001b]52;')))
})

test('multi-select Space toggles the current row without moving its cursor', async () => {
  const { Dropdown } = await import('../src/tui/components/Dropdown.js')
  const { OverlayProvider } = await import('../src/tui/overlay.js')
  let selected = ['a']
  function Control() {
    const [values, setValues] = useState(selected)
    return <Dropdown autoFocus multiple label="Series" options={[{value:'a',label:'Alpha'},{value:'b',label:'Beta'},{value:'c',label:'Gamma'}]} values={values} onChange={next => { selected = next; setValues(next) }} />
  }
  const app = render(<Box height={20}><OverlayProvider><Control /></OverlayProvider></Box>); await settle()
  app.stdin.write('\r'); await settle(); app.stdin.write('\u001b[B'); await settle()
  app.stdin.write(' '); await settle(); assert.deepEqual(selected, ['a', 'b'])
  app.stdin.write(' '); await settle(); assert.deepEqual(selected, ['a'])
  app.stdin.write('\u001b[B'); await settle(); app.stdin.write(' '); await settle()
  assert.deepEqual(selected, ['a', 'c'])
  app.stdin.write('\r'); await settle(); assert.deepEqual(selected, ['a'])
})

test('medium buttons use half-row caps and keep their caption aligned with input and dropdown values',async()=>{
 const {Dropdown}=await import('../src/tui/components/Dropdown.js')
 const app=render(<Box flexDirection="column"><Box gap={1} alignItems="flex-end"><Dropdown label="Channel" width={20} value="one" options={[{value:'one',label:'Chosen'}]}/><Button size="medium" label="Apply"/></Box><Box gap={1} alignItems="flex-end"><Box flexDirection="column"><Text>Mask</Text><TextInput size="large" value="0x3FF" onChange={()=>{}} width={20}/></Box><Button size="medium" label="Calibrate"/></Box></Box>)
 await settle()
 const lines=(app.lastFrame()??'').split('\n')
 assert.ok(lines.some(l=>l.includes('Chosen')&&l.includes('Apply')))
 assert.ok(lines.some(l=>l.includes('0x3FF')&&l.includes('Calibrate')))
 assert.equal(lines.filter(l=>l.includes('▄▄')).length,2)
 assert.equal(lines.filter(l=>l.includes('▀▀')).length,2)
})
