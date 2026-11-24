// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'
import React, { useEffect } from 'react'
import { render, cleanup } from 'ink-testing-library'

import { Box, useFocusManager } from 'ink'
import { Button, Card, Dropdown, LineChart, MenuBar, Table, Tabs, TreeList } from '../src/tui/index.js'
import { OverlayProvider } from '../src/tui/overlay.js'

afterEach(cleanup)

function FocusReady({ onReady }: { onReady(): void }) {
  const { activeId } = useFocusManager()
  useEffect(() => { if (activeId) onReady() }, [activeId, onReady])
  return null
}

test('renders a card and a button', () => {
  const { lastFrame } = render(
    <Card title="Session" subtitle="motor control" badge="live">
      <Button label="Start" variant="primary" />
    </Card>,
  )
  const frame = lastFrame() ?? ''
  assert.match(frame, /Session/)
  assert.match(frame, /Start/)
})

test('renders tabs, table and tree', () => {
  const tabs = render(<Tabs items={[{ id: 'a', label: 'Overview' }, { id: 'b', label: 'Data' }]} value="a" onChange={() => undefined} />)
  assert.match(tabs.lastFrame() ?? '', /Overview/)

  const table = render(
    <Table
      columns={[
        { key: 'name', header: 'Name', width: 8, value: row => row.name },
        { key: 'value', header: 'Value', width: 5, align: 'right', value: row => row.value },
      ]}
      rows={[{ name: 'Motor 1', value: 12 }]}
      rowKey={row => row.name}
    />,
  )
  assert.match(table.lastFrame() ?? '', /Motor 1/)

  const tree = render(
    <TreeList
      nodes={[{ id: 'a', label: 'EtherCAT', kind: 'adapter', children: [{ id: 'b', label: 'Motor 1', kind: 'motor' }] }]}
    />,
  )
  assert.match(tree.lastFrame() ?? '', /EtherCAT/)
})

test('renders dropdown and a braille chart', () => {
  const dropdown = render(
    <OverlayProvider>
      <Dropdown
        label="Rate"
        options={[{ value: '1', label: '1 ms' }, { value: '2', label: '2 ms' }]}
        value="1"
        onChange={() => undefined}
      />
    </OverlayProvider>,
  )
  assert.match(dropdown.lastFrame() ?? '', /1 ms/)

  const chart = render(
    <LineChart
      series={[{ label: 'position', color: 'blue', data: [0, 1, 0, -1, 0] }]}
      width={30}
      height={6}
    />,
  )
  assert.ok((chart.lastFrame() ?? '').includes('position'))
})

test('renders a multi-select dropdown with checkboxes', { timeout: 2000 }, async () => {
  let ready!: () => void
  const focused = new Promise<void>(resolve => { ready = resolve })
  const { lastFrame, stdin } = render(
    <Box height={20}>
      <OverlayProvider>
        <FocusReady onReady={ready} />
        <Dropdown
          label="Series"
          autoFocus
          multiple
      options={[
        { value: 'position', label: 'Position' },
        { value: 'velocity', label: 'Velocity' },
      ]}
          values={['position']}
          onChange={() => undefined}
        />
      </OverlayProvider>
    </Box>,
  )
  await focused
  await new Promise(resolve => setImmediate(resolve))
  stdin.write('\r')
  await new Promise(resolve => setTimeout(resolve, 100))
  const frame = lastFrame() ?? ''
  assert.match(frame, /\[✓\] Position/)
  assert.match(frame, /\[ \] Velocity/)
})

test('shows a visible focus ring on table and menu bar', async () => {
  const table = render(
    <Table
      columns={[{ key: 'name', header: 'Name', width: 8, value: row => row.name }]}
      rows={[{ name: 'Motor 1' }]}
      rowKey={row => row.name}
    />,
  )
  assert.match(table.lastFrame() ?? '', /┌/)
  await new Promise(resolve => setTimeout(resolve, 20))
  table.stdin.write('\t')
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.match(table.lastFrame() ?? '', /┏/)

  const menu = render(
    <Box height={20}>
      <OverlayProvider>
        <MenuBar
          autoFocus
          menus={[
            {
              id: 'file',
              label: 'File',
              items: [{ id: 'new', label: 'New session' }],
            },
          ]}
        />
      </OverlayProvider>
    </Box>,
  )
  await new Promise(resolve => setTimeout(resolve, 20))
  menu.stdin.write('\r')
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.match(menu.lastFrame() ?? '', /New session/)
})
