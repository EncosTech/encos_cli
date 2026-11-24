#!/usr/bin/env node
import { NavigationProvider } from './navigation.js'
// SPDX-License-Identifier: MIT

import React, { useEffect, useState } from 'react'
import { Box, Text, useApp, useInput, useWindowSize } from 'ink'

import {
  LogCard, createLogStore, createChartStore, type LogLevel,
  Badge, TextInput, Slider, SliderInput, Footer, Dialog, DialogHost, NotificationProvider, useNotifications,
  Button,
  Card,
  Dropdown,
  LineChart,
  MenuBar,
  Table,
  Tabs,
  TreeList,
  type TabItem,
  type TableColumn,
  type TreeNode,
} from './index.js'
import { colors, icons } from './theme.js'

interface MotorRow {
  adapter: string
  bus: number
  id: number
  position: number
  speed: number
  current: number
  temperature: number
  loss: string
  state: string
}

const ROWS: MotorRow[] = [
  { adapter: 'Ethercat', bus: 1, id: 1, position: 12.4, speed: 1.204, current: 0.82, temperature: 31.2, loss: '0.00%', state: 'online' },
  { adapter: 'Ethercat', bus: 1, id: 2, position: -8.1, speed: -0.442, current: 1.13, temperature: 32.8, loss: '0.02%', state: 'online' },
  { adapter: 'Ethercat', bus: 1, id: 3, position: 26.7, speed: 2.781, current: 0.47, temperature: 30.5, loss: '0.00%', state: 'online' },
  { adapter: 'Ethercat', bus: 2, id: 4, position: 4.9, speed: 0.118, current: 0.21, temperature: 28.9, loss: '0.00%', state: 'idle' },
  { adapter: 'Can', bus: 0, id: 5, position: -18.3, speed: -1.022, current: 2.04, temperature: 35.4, loss: '0.18%', state: 'warn' },
  { adapter: 'Can', bus: 0, id: 6, position: 0.0, speed: 0.0, current: 0.0, temperature: 26.1, loss: '—', state: 'fault' },
]

const COLUMNS: TableColumn<MotorRow>[] = [
  { key: 'adapter', header: 'Adapter', width: 9, value: row => row.adapter },
  { key: 'bus', header: 'Bus', width: 3, align: 'right', value: row => row.bus },
  { key: 'id', header: 'ID', width: 3, align: 'right', value: row => row.id },
  { key: 'position', header: 'Pos°', width: 8, align: 'right', value: row => row.position.toFixed(2) },
  { key: 'speed', header: 'Vel', width: 7, align: 'right', value: row => row.speed.toFixed(3) },
  { key: 'current', header: 'Cur', width: 6, align: 'right', value: row => row.current.toFixed(2) },
  { key: 'temperature', header: 'Temp', width: 5, align: 'right', value: row => row.temperature.toFixed(1) },
  { key: 'loss', header: 'Loss', width: 6, align: 'right', value: row => row.loss },
  { key: 'state', header: 'State', width: 7, value: row => row.state },
]

const TREE: TreeNode[] = [
  {
    id: 'ethercat',
    label: 'EtherCAT',
    kind: 'adapter',
    status: 'ok',
    badge: '3 buses',
    children: [
      {
        id: 'ethercat:0',
        label: 'Slave 0',
        kind: 'bus',
        status: 'ok',
        children: [
          {
            id: 'ethercat:0:1',
            label: 'Bus 1',
            kind: 'bus',
            badge: '3 motors',
            children: [
              { id: 'm1', label: 'Motor 1', kind: 'motor', status: 'ok', badge: '12.4°' },
              { id: 'm2', label: 'Motor 2', kind: 'motor', status: 'ok', badge: '-8.1°' },
              { id: 'm3', label: 'Motor 3', kind: 'motor', status: 'warn', badge: '26.7°' },
            ],
          },
          {
            id: 'ethercat:0:2',
            label: 'Bus 2',
            kind: 'bus',
            badge: '1 motor',
            children: [{ id: 'm4', label: 'Motor 4', kind: 'motor', status: 'idle', badge: '4.9°' }],
          },
        ],
      },
    ],
  },
  {
    id: 'can',
    label: 'CAN',
    kind: 'adapter',
    status: 'warn',
    badge: '1 bus',
    children: [
      {
        id: 'can:0',
        label: 'Bus 0',
        kind: 'bus',
        status: 'warn',
        badge: '2 motors',
        children: [
          { id: 'm5', label: 'Motor 5', kind: 'motor', status: 'warn', badge: '-18.3°' },
          { id: 'm6', label: 'Motor 6', kind: 'motor', status: 'error', badge: '0.0°' },
        ],
      },
    ],
  },
]

function LiveTelemetryChart({ seriesCount = 3 }: { seriesCount?: number }) {
  const extraSeries = Array.from({ length: Math.max(0, seriesCount - 3) }, (_, index) => {
    // Spread hues around the color wheel, with enough brightness for the dark theme.
    const hue = (index * 137.508) % 360
    const channel = (offset: number) => {
      const k = (offset + hue / 30) % 12
      return Math.round(255 * (0.65 - 0.3 * Math.max(-1, Math.min(k - 3, 9 - k, 1))))
        .toString(16).padStart(2, '0')
    }
    return { id: `signal-${index + 4}`, label: `S${String(index + 4).padStart(2, '0')}`,
      color: `#${channel(0)}${channel(8)}${channel(4)}` }
  })
  const [store] = useState(() => createChartStore({ series: [
    { id: 'position', label: 'position', color: colors.primary, yAxisId: 'position' },
    { id: 'velocity', label: 'velocity', color: colors.accent, yAxisId: 'velocity' },
    { id: 'current', label: 'current', color: colors.cyan, yAxisId: 'current' },
    ...extraSeries.map(item => ({...item, yAxisId: 'position'})),
  ] }))
  useEffect(() => {
    const started = Date.now()
    const sample = (timestamp: number) => {
      const phase = (timestamp - started) / 1000
      return [
        { seriesId: 'position', timestamp, value: 12 * Math.sin(phase) + 4 * Math.sin(phase * 2.3) },
        { seriesId: 'velocity', timestamp, value: 1.4 * Math.cos(phase) + 0.3 * Math.sin(phase * 3) },
        { seriesId: 'current', timestamp, value: 0.9 + 0.5 * Math.sin(phase * 1.7) },
        ...extraSeries.map((item, index) => ({ seriesId: item.id, timestamp,
          value: (3 + index % 10) * Math.sin(phase * (0.45 + index * 0.07) + index * 0.8)
            + 2 * Math.cos(phase * 2.1 + index) })),
      ]
    }
    store.appendMany(Array.from({ length: 200 }, (_, index) => sample(started - (199 - index) * 50)).flat())
    const timer = setInterval(() => store.appendMany(sample(Date.now())), 50)
    return () => { clearInterval(timer); store.dispose() }
  }, [store])
  return <LineChart store={store} windowMs={10000} yAxes={[
    {id:'position',label:'Pos (deg)',position:'left',color:colors.primary},
    {id:'velocity',label:'Vel (rpm)',position:'right',color:colors.accent},
    {id:'current',label:'Cur (A)',position:'right',color:colors.cyan},
  ]} />
}

const TABS: TabItem[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'inputs', label: 'Inputs' },
  { id: 'data', label: 'Data' },
  { id: 'charts', label: 'Charts' },
  { id: 'scrolling', label: 'Scrolling' },
  { id: 'logs', label: 'Logs' },
]

function SectionTitle({ text }: { text: string }): React.ReactElement {
  return (
    <Text color={colors.text} bold>
      {text.toUpperCase()}
    </Text>
  )
}

function GalleryContent(): React.ReactElement {
  const { exit } = useApp()
  const { columns, rows } = useWindowSize()
  const { notify } = useNotifications()
  const [dialog, setDialog] = useState(false)
  const [name, setName] = useState('Motor 1')
  const [speed, setSpeed] = useState(30)
  const [logs] = useState(() => createLogStore())
  const [logLevel, setLogLevel] = useState('all')
  const [logQuery, setLogQuery] = useState('')
  useEffect(() => {
    logs.appendMany(Array.from({ length: 30 }, (_, index) => ({
      source: index % 2 ? 'driver' : 'application',
      level: (['debug', 'info', 'warn', 'error'] as const)[index % 4],
      message: `Sample ${index + 1}: ${index % 4 === 2 ? 'Telemetry delayed; retry scheduled' : 'Motor status received'}`,
    })))
    return () => logs.dispose()
  }, [logs])
  const [tab, setTab] = useState(process.env.EMCLI_GALLERY_TAB ?? 'overview')
  const [rate, setRate] = useState('1 ms')
  const [variant, setVariant] = useState('primary')
  const [selectedMotor, setSelectedMotor] = useState<MotorRow>(ROWS[0])
  const setToast = (message: string) => { notify(message) }
  const [metrics, setMetrics] = useState<string[]>(['position', 'velocity'])

  useInput((input, key) => { if (key.ctrl && !key.shift && input === 'c' && key.eventType !== 'release') exit() })

  const contentWidth = Math.max(88, columns - 2)

  const menuBar = (
    <MenuBar
      autoFocus
      menus={[
        {
          id: 'file',
          label: 'File',
          items: [
            { id: 'new', label: 'New session', shortcut: '⌘N', onSelect: () => setToast('new session') },
            { id: 'open', label: 'Open trajectory…', shortcut: '⌘O', onSelect: () => setToast('open trajectory') },
            { id: 'save', label: 'Save log', shortcut: '⌘S', onSelect: () => setToast('log saved') },
            { id: 'sep', label: '', separator: true },
            { id: 'quit', label: 'Quit', shortcut: 'q', onSelect: () => exit() },
          ],
        },
        {
          id: 'session',
          label: 'Session',
          items: [
            { id: 'start', label: 'Start', shortcut: '↵', onSelect: () => setToast('session started') },
            { id: 'stop', label: 'Stop', shortcut: '■', onSelect: () => setToast('stopped') },
            { id: 'scan', label: 'Scan motors', onSelect: () => setToast('scan requested') },
          ],
        },
        {
          id: 'view',
          label: 'View',
          items: [
            { id: 'overview', label: 'Overview', checked: tab === 'overview', onSelect: () => setTab('overview') },
            { id: 'inputs', label: 'Inputs', checked: tab === 'inputs', onSelect: () => setTab('inputs') },
            { id: 'data', label: 'Data', checked: tab === 'data', onSelect: () => setTab('data') },
            { id: 'charts', label: 'Charts', checked: tab === 'charts', onSelect: () => setTab('charts') },
          ],
        },
        {
          id: 'help',
          label: 'Help',
          items: [
            { id: 'keys', label: 'Keyboard shortcuts', shortcut: '?', onSelect: () => setToast('tab focus · arrows navigate · enter open') },
            { id: 'about', label: 'About Motor Studio', onSelect: () => setToast('ENCOS terminal interface kit') },
          ],
        },
      ]}
    />
  )

  const footer = <Footer actions={[
    { key: 'ctrl+h', label: 'Help', onPress: () => notify('Tab: focus · arrows: navigate · Enter: activate') },
    { key: 'ctrl+o', label: 'Dialog', onPress: () => setDialog(true) },
    { key: 'ctrl+n', label: 'Notify', onPress: () => notify('Motor connected', { severity: 'success' }) },
  ]} />

  const overview = (
    <Box flexDirection="column" gap={1} flexGrow={1}>
      <Box gap={1} height={13}>
        <Card title="Design tokens" badge="theme" accent={colors.primary} width={34}>
          <Box flexDirection="column" gap={0}>
            <Text color={colors.text}>
              <Text bold>Display</Text>  Motor Studio
            </Text>
            <Box gap={2}>
              <Text color={colors.primary}>■</Text>
              <Text color={colors.accent}>■</Text>
              <Text color={colors.success}>■</Text>
              <Text color={colors.warning}>■</Text>
              <Text color={colors.danger}>■</Text>
            </Box>
            <Text color={colors.text}>primary · accent · success</Text>
            <Text color={colors.text}>warn · danger</Text>
            <Text color={colors.text}>Surface  {colors.surface}</Text>
            <Text color={colors.text}>Border   {colors.border}</Text>
          </Box>
        </Card>
        <Card title="Buttons" badge="input" accent={colors.accent} width={38}>
          <Box flexWrap="wrap" gap={1}>
            <Button
              label="Start"
              variant="primary"
              icon="▶"
              onPress={() => setToast('session started')}
            />
            <Button label="Setup" variant="secondary" icon="⚙" onPress={() => setToast('configuration')} />
            <Button label="Stop" variant="danger" icon="■" onPress={() => setToast('stopped')} />
            <Button label="Ghost" variant="ghost" onPress={() => setToast('ghost')} />
          </Box>
        </Card>
        <Card title="Dropdown" badge="select" accent={colors.cyan} flexGrow={1}>
          <Dropdown
            label="Control period"
            options={[
              { value: '1 ms', label: '1 ms', description: '1 kHz · maximum responsiveness', badge: '64k/s' },
              { value: '2 ms', label: '2 ms', description: '500 Hz · balanced', badge: '32k/s' },
              { value: '5 ms', label: '5 ms', description: '200 Hz · lower CPU', badge: '12.8k/s' },
            ]}
            value={rate}
            onChange={value => {
              setRate(value)
              setToast(`period ${value}`)
            }}
          />
        </Card>
      </Box>
      <Box gap={1} flexGrow={1}>
        <Card scrollable={false} title="Live telemetry" badge="20 Hz" accent={colors.primary} flexGrow={1}>
          <LiveTelemetryChart />
        </Card>
        <Card title="Session" badge="focus" accent={colors.accent} width={34}>
          <Box flexDirection="column">
            <Text color={colors.text} bold>
              EtherCAT · Bus 1 · Motor {selectedMotor.id}
            </Text>
            <Text color={colors.text}>
              position <Text color={colors.primary}>{selectedMotor.position.toFixed(2)}°</Text>
            </Text>
            <Text color={colors.text}>velocity / current</Text>
            <Text color={colors.text}>
              {selectedMotor.speed.toFixed(3)} / {selectedMotor.current.toFixed(2)} A
            </Text>
            <Box marginTop={1}>
              <Badge label={selectedMotor.state} color={selectedMotor.state === 'online' ? colors.success : colors.warning} />
            </Box>
          </Box>
        </Card>
      </Box>
    </Box>
  )

  const inputs = (
    <Box flexDirection="column" gap={1} flexGrow={1}>
      <Box gap={1} flexGrow={1} flexBasis={0} minHeight={7}>
        <Card title="Button gallery" badge="interactive" accent={colors.primary} flexGrow={1}>
          <Box gap={1} flexWrap="wrap">
            <Button label="Default" onPress={() => setVariant('default')} />
            <Button label="Primary" variant="primary" onPress={() => setVariant('primary')} />
            <Button label="Warning" variant="warning" onPress={() => setVariant('warning')} />
            <Button label="Error" variant="danger" onPress={() => setVariant('error')} />
          </Box>
          <Box gap={1} marginTop={1} flexWrap="wrap">
            <Button size="small" label="Default" onPress={() => setVariant('small default')} />
            <Button size="small" label="Primary" variant="primary" onPress={() => setVariant('small primary')} />
            <Button size="small" label="Warning" variant="warning" onPress={() => setVariant('small warning')} />
            <Button size="small" label="Error" variant="danger" onPress={() => setVariant('small error')} />
          </Box>
          <Box gap={1} marginTop={1} flexWrap="wrap">
            <Button label="Default" disabled />
            <Button label="Primary" variant="primary" disabled />
            <Button label="Warning" variant="warning" disabled />
            <Button label="Error" variant="danger" disabled />
          </Box>
          <Text color={colors.text}>last variant: {variant}</Text>
        </Card>
        <Card title="Dropdown" badge="overlay" accent={colors.cyan} width={40}>
          <Box flexDirection="column" gap={1}>
            <Dropdown
              label="Sample rate"
              options={[
                { value: '1 ms', label: '1 ms', badge: '1 kHz' },
                { value: '2 ms', label: '2 ms', badge: '500 Hz' },
                { value: '5 ms', label: '5 ms', badge: '200 Hz' },
                { value: '10 ms', label: '10 ms', badge: '100 Hz' },
              ]}
              value={rate}
              onChange={setRate}
            />
            <Dropdown
              label="Visible series"
              multiple
              options={[
                { value: 'position', label: 'Position' },
                { value: 'velocity', label: 'Velocity' },
                { value: 'current', label: 'Current' },
                { value: 'temperature', label: 'Temperature' },
              ]}
              values={metrics}
              onChange={setMetrics}
            />
          </Box>
        </Card>
      </Box>
      <Card title="Inputs & feedback" accent={colors.primary}>
        <Box gap={2}><TextInput value={name} onChange={setName} /><TextInput size="small" value={name} onChange={setName} /></Box>
        <Box gap={2} alignItems="center"><SliderInput value={speed} onChange={setSpeed} precision={2} width={34} /><Button label="Dialog" onPress={() => setDialog(true)} /><Button label="Notify" onPress={() => notify('Settings saved', { severity: 'success' })} /></Box>
        <Box gap={1}>
          <Button label="Info" onPress={() => notify('Scan started', { severity: 'information' })} />
          <Button label="Success" variant="success" onPress={() => notify('Motor connected', { severity: 'success' })} />
          <Button label="Warning" variant="warning" onPress={() => notify('Temperature rising', { severity: 'warning' })} />
          <Button label="Error" variant="danger" onPress={() => notify('Connection lost', { severity: 'error', timeout: 0 })} />
        </Box>
      </Card>
    </Box>
  )

  const data = (
    <Box gap={1} flexGrow={1}>
      <Card title="Topology" badge="tree" accent={colors.primary} width={34}>
        <TreeList nodes={TREE} height={12} />
      </Card>
      <Card title="Motor table" badge="6 rows" accent={colors.accent} flexGrow={1}>
        <Table columns={COLUMNS} rows={ROWS} rowKey={row => `${row.adapter}-${row.bus}-${row.id}`} height={8} onSelect={setSelectedMotor} />
      </Card>
    </Box>
  )

  const charts = (
    <Box flexDirection="column" gap={1} flexGrow={1}>
      {rows >= 38 ? <Box gap={1} height={7} flexShrink={0}>
        <Card title="P50 latency" badge="bench" accent={colors.primary} width={24} height={7}>
          <Text color={colors.success} bold>
            2.78 ms
          </Text>
          <Text color={colors.text}>P1 2.30 / P99 3.35</Text>
        </Card>
        <Card title="Throughput" badge="stress" accent={colors.accent} width={24} height={7}>
          <Text color={colors.accent} bold>
            64,213 /s
          </Text>
          <Text color={colors.text}>64 motors · 1 kHz</Text>
        </Card>
        <Card title="Loss" badge="drain" accent={colors.warning} width={24} height={7}>
          <Text color={colors.warning} bold>
            0.07 %
          </Text>
          <Text color={colors.text}>192 / 288,960</Text>
        </Card>
        <Card title="Selected" badge="motor" accent={colors.cyan} flexGrow={1} height={7}>
          <Text color={colors.text} bold>
            Motor {selectedMotor.id}
          </Text>
          <Text color={colors.text}>
            pos {selectedMotor.position.toFixed(2)}° · cur {selectedMotor.current.toFixed(2)} A
          </Text>
        </Card>
      </Box> : null}
      <Card scrollable={false} title="Multi-series chart" badge="30 lines" accent={colors.primary} flexGrow={1}>
        <LiveTelemetryChart seriesCount={30} />
      </Card>
    </Box>
  )

  const scrolling = (
    <Box gap={1} flexGrow={1} minHeight={0}>
      <Card title="Event log" width={42}>
        {Array.from({ length: 60 }, (_, index) => <Text key={index} color={colors.text}>{String(index + 1).padStart(2, '0')}  Motor telemetry sample received</Text>)}
      </Card>
      <Card title="Scrollable controls">
        <Box width={120} flexDirection="column" flexShrink={0}>
          <Text color={colors.text}>{'Wide content '.repeat(10)}</Text>
          {Array.from({ length: 24 }, (_, index) => <Button key={index} label={`Inspect sample ${index + 1}`} size="small" onPress={() => notify(`Sample ${index + 1}`)} />)}
        </Box>
      </Card>
    </Box>
  )

  const logPage = <Box flexDirection="column" flexGrow={1} gap={1}>
    <Box gap={2} flexShrink={0}>
      <Dropdown label="Level" width={18} value={logLevel} onChange={setLogLevel}
        options={['all', 'trace', 'debug', 'info', 'warn', 'error', 'fatal', 'unknown'].map(value => ({ value, label: value.toUpperCase() }))} />
      <Box flexDirection="column"><Text color={colors.text}>Search messages</Text><TextInput size="small" width={30} value={logQuery} onChange={setLogQuery} placeholder="Filter logs" /></Box>
      <Button size="small" label="Add log" onPress={() => logs.append({ source: 'driver', level: 'info', message: 'Motor status received' })} />
      <Button size="small" label="Add 100" onPress={() => logs.appendMany(Array.from({ length: 100 }, (_, index) => ({ source: 'driver', level: 'debug' as const, message: `Batch record ${index + 1}: telemetry update` })))} />
      <Button size="small" label="Clear" onPress={() => logs.clear()} />
    </Box>
    <LogCard title="Driver logs" store={logs} flexGrow={1} query={logQuery} levels={logLevel === 'all' ? undefined : [logLevel as LogLevel]} />
  </Box>

  const body =
    tab === 'overview' ? overview : tab === 'inputs' ? inputs : tab === 'data' ? data : tab === 'scrolling' ? scrolling : tab === 'logs' ? logPage : charts

  return (
    <DialogHost dialog={dialog ? <Dialog title="Apply motor settings?" onClose={() => setDialog(false)} onConfirm={() => { setDialog(false); notify("Settings applied", { severity: "success" }) }}><Text color={colors.text}>{name} · {speed}%</Text></Dialog> : undefined}><Box flexDirection="column" width={columns} height={rows} paddingX={0} backgroundColor={colors.background}>
      <Box flexShrink={0} paddingX={1} paddingTop={1}>
        {menuBar}
      </Box>
      <Box flexShrink={0} paddingX={1} paddingTop={1} justifyContent="space-between">
        <Tabs items={TABS} value={tab} onChange={setTab} />
      </Box>
      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        {body}
      </Box>
      {footer}
    </Box></DialogHost>
  )
}

function Gallery() { return <NavigationProvider><NotificationProvider><GalleryContent /></NotificationProvider></NavigationProvider> }
export { Gallery }
