// SPDX-FileCopyrightText: 2026 Encos
// SPDX-License-Identifier: MIT

import { AdapterConfigPanel } from './AdapterConfigPanel.js'
import { FieldLabel } from '../tui/components/FieldLabel.js'
import { PlayPanel } from './PlayPanel.js'
import type { FooterAction } from '../tui/components/Footer.js'
import { BatchPanel } from './BatchPanel.js'
import { ControlPanel, SettingEditor } from './MotorPanels.js'
import { ScopePanel } from './ScopePanel.js'
import { testScopeKey } from './performance.js'
import type { PerformanceUpdate } from './protocol.js'
import React, { useEffect, useRef, useState, useMemo, useSyncExternalStore } from 'react'
import { Box, Text, useInput, useWindowSize } from 'ink'
import {
  Button,
  Card,
  Dialog,
  DialogHost,
  Dropdown,
  Footer,
  LineChart,
  LogCard,
  LoadingOverlay,
  MenuBar,
  NavigationProvider,
  NotificationProvider,
  SliderInput,
  Tabs,
  TextInput,
  TreeList,
  TreeSelect,
  toggleTreeSelection,
  createChartStore,
  useNotifications,
  type TreeNode,
} from '../tui/index.js'
import type { LogStore } from '../tui/log-store.js'
import { colors } from '../tui/theme.js'
import { useInteractionBlocked } from '../tui/interaction.js'
import { SETTINGS, supportsDexHandJointSetting } from './catalog.js'
import {
  EMPTY_SESSION,
  type StudioView,
  type Telemetry,
  type DeviceKind,
  type DeviceSample,
  type AdapterTiming,
  type ControlMode,
  type GraphMetric,
  type Interfaces,
  type Request,
  type SessionState,
  type StudioClient,
} from './protocol.js'
import {
  deviceTree,
  batchDeviceTree,
  findNode,
  busSelectionTree,
  busSelectionKey,
  busLabel,
  deviceLabel,
  parseDeviceId,
  isEthercat,
  availableGloveSlaves,
  availableDeviceBuses,
} from './devices.js'
import { DevicePanel } from './DevicePanel.js'
import { TimingFields } from './TimingFields.js'

const TABS = ['Control', 'Settings', 'Graph'].map((label) => ({ id: label.toLowerCase(), label }))

import { MOTOR_METRICS as METRICS } from './motor-metrics.js'

type Run = (request: Request, message?: string) => Promise<unknown>

export function StudioApp(props: {
  client: StudioClient
  logs: LogStore
  preload?: Array<{ type: string; id: string }>
  onQuit(): void
  demo?: boolean
}) {
  return (
    <NavigationProvider>
      <NotificationProvider>
        <StudioContent {...props} />
      </NotificationProvider>
    </NavigationProvider>
  )
}

function StudioContent({
  client,
  logs,
  preload = [],
  onQuit,
  demo = false,
}: {
  client: StudioClient
  logs: LogStore
  preload?: Array<{ type: string; id: string }>
  onQuit(): void
  demo?: boolean
}) {
  const { columns, rows } = useWindowSize(),
    { notify } = useNotifications()

  const interactionBlocked = useInteractionBlocked()
  const [session, setSession] = useState<SessionState>(EMPTY_SESSION)
  const [interfaces, setInterfaces] = useState<Interfaces>({ version: 'Loading', types: [] })

  const [ready, setReady] = useState(false),
    [offline, setOffline] = useState(false)

  const [playActions, setPlayActions] = useState<FooterAction[]>([]),
    [playHints, setPlayHints] = useState<Array<{ key: string; label: string }>>([]),
    [playDialog, setPlayDialog] = useState<React.ReactNode>()

  const [busy, setBusy] = useState(''),
    lock = useRef(false)

  const [tab, setTab] = useState('control'),
    [dialog, setDialog] = useState<'add' | 'device' | 'glove' | 'quit' | undefined>()

  const [adapterType, setAdapterType] = useState(''),
    [iface, setIface] = useState('')

  const [performance, setPerformance] = useState<Record<string, PerformanceUpdate>>({})
  const [newTiming, setNewTiming] = useState<AdapterTiming>({})

  const [gloveAdapter, setGloveAdapter] = useState(''),
    [gloveSlave, setGloveSlave] = useState('')

  const [deviceSample, setDeviceSample] = useState<DeviceSample>()
  const [motorSample, setMotorSample] = useState<Telemetry>()
  const [treeSelection, setTreeSelection] = useState<TreeNode>()
  const [deviceKind, setDeviceKind] = useState<Exclude<DeviceKind, 'glove'>>('motor')

  const [deviceBus, setDeviceBus] = useState(''),
    [deviceId, setDeviceId] = useState('1')

  const [logsCollapsed, setLogsCollapsed] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, number[]>>({})
  const [settings, setSettings] = useState<Record<string, string[]>>({})

  const [chart] = useState(() =>
    createChartStore({
      series: METRICS.map((metric) => ({
        id: metric.value,
        label: metric.label,
        color: metric.color,
        yAxisId: metric.value,
      })),
    }),
  )

  const chartSeries = useSyncExternalStore(chart.subscribe, chart.getSnapshot, chart.getSnapshot)
  const current = useRef(session)

  current.current = session

  const mounted = useRef(true)

  const run: Run = async (request, success) => {
    if (lock.current) return

    lock.current = true
    setBusy(request.type)

    try {
      const value = await client.request(request)

      if (success) notify(success, { severity: 'success' })

      return value
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)

      logs.append({ level: 'error', source: 'app', message })
      notify(message, { severity: 'error', timeout: 6000 })

      return undefined
    } finally {
      lock.current = false

      if (mounted.current) setBusy('')
    }
  }

  useEffect(() => {
    mounted.current = true

    const unsubscribe = client.subscribe((event) => {
      if (event.type === 'state') {
        if ((current.current.view ?? 'single') !== (event.state.view ?? 'single')) {
          setTab('control')
          setTreeSelection(undefined)
          chart.clear()
          setMotorSample(undefined)
          setDrafts({})
          setSettings({})
        }

        if (current.current.selectedDevice !== event.state.selectedDevice)
          setDeviceSample(undefined)

        if (current.current.selected !== event.state.selected) {
          const previous = current.current.selected

          setTreeSelection((node) =>
            node?.kind === 'motor' && node.id === previous ? undefined : node,
          )

          setMotorSample(undefined)
          chart.clear()
          setDrafts({})
          setSettings({})
        }

        current.current = event.state
        setSession(event.state)
      } else if (event.type === 'performance') {
        setPerformance((previous) => ({
          ...previous,
          [`${testScopeKey(event.update.scope)}:${event.update.kind}`]: event.update,
        }))
      } else if (event.type === 'telemetry') {
        if (
          current.current.view === 'batch' ||
          current.current.view === 'play' ||
          event.sample.motorKey !== current.current.selected
        )
          return

        setMotorSample(event.sample)

        chart.appendMany(
          METRICS.map((metric) => ({
            seriesId: metric.value,
            timestamp: event.sample.timestamp,
            value: event.sample[metric.value as GraphMetric] ?? NaN,
          })),
        )
      } else if (event.type === 'device-status') {
        if (event.sample.deviceKey === current.current.selectedDevice) setDeviceSample(event.sample)
      } else if (event.type === 'log' && event.level === 'error') {
        notify(event.message, { severity: 'error' })

        if (event.message.startsWith('Driver process')) {
          setOffline(true)
          setReady(false)
          setDialog(undefined)
          setTreeSelection(undefined)
          current.current = EMPTY_SESSION
          setSession(EMPTY_SESSION)
        }
      }
    })

    void (async () => {
      lock.current = true
      setBusy('Loading driver')

      try {
        const result = await client.request<Interfaces>({ type: 'interfaces' })

        if (!mounted.current) return

        setInterfaces(result)
        setAdapterType(result.types[0]?.type ?? '')
        setIface(result.types[0]?.interfaces[0] ?? '')
        setReady(true)

        for (const spec of preload) {
          const ids =
            spec.id === 'ALL'
              ? (result.types.find((item) => item.type === spec.type)?.interfaces ?? [])
              : [spec.id]

          for (const id of ids) {
            setBusy('add')
            await client.request({ type: 'add', adapterType: spec.type, interfaceName: id })
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)

        logs.append({ level: 'error', source: 'startup', message })
        notify(message, { severity: 'error', timeout: 10000 })
      } finally {
        lock.current = false

        if (mounted.current) setBusy('')
      }
    })()

    return () => {
      mounted.current = false
      unsubscribe()
      chart.dispose()
    }
  }, [client, chart, logs])

  const openAdd = async () => {
    if (current.current.view === 'play' || current.current.view === 'adapter-config') return

    const result = (await run({ type: 'interfaces' })) as Interfaces | undefined

    if (result) {
      setInterfaces(result)

      const type = result.types.find((item) => item.type === adapterType) ?? result.types[0]

      setAdapterType(type?.type ?? '')
      setIface(type?.interfaces.includes(iface) ? iface : (type?.interfaces[0] ?? ''))
      setDialog('add')
    }
  }

  const view = session.view ?? 'single'
  const canAct = ready && !offline
  const tree = useMemo(() => deviceTree(session.adapters), [session.adapters])
  const batchTree = useMemo(() => batchDeviceTree(session.adapters), [session.adapters])

  const activeNode =
    findNode(tree, treeSelection?.id) ?? findNode(tree, session.selected ?? session.selectedDevice) ?? tree[0]

  const selected =
    activeNode?.kind === 'motor'
      ? session.adapters
          .flatMap((adapter) => adapter.motors)
          .find((motor) => motor.key === activeNode.id)
      : undefined

  const peripheral = session.adapters
    .flatMap((a) => a.devices ?? [])
    .find((d) => d.key === activeNode?.id)

  const selectedBus =
    activeNode?.kind === 'adapter'
      ? { adapterKey: activeNode.id }
      : activeNode?.kind === 'bus' || activeNode?.kind === 'slave'
        ? (JSON.parse(activeNode.id) as {
            adapterKey: string
            slaveId?: number | null
            busId?: number
          })
        : undefined

  const busAdapter = session.adapters.find((a) => a.key === selectedBus?.adapterKey)
  const motorReady = canAct && selected?.key === session.selected

  useEffect(() => {
    if (view !== 'single' || !selected || !ready) return

    void client
      .request({
        type: 'graph-active',
        active: tab === 'graph',
        expectedMotor: selected.key,
        expectedView: 'single',
      })
      .catch((error) => logs.append({ level: 'error', source: 'graph', message: String(error) }))

    return () => {
      void client
        .request({
          type: 'graph-active',
          active: false,
          expectedMotor: selected.key,
          expectedView: 'single',
        })
        .catch(() => {})
    }
  }, [view, tab, selected?.key, ready, client, logs])

  const motorRequest = (request: Request, message?: string) => {
    if (request.type === 'control') setMotorSample(undefined)

    return run({ ...request, expectedMotor: session.selected, expectedView: 'single' }, message)
  }

  const changeView = (next: StudioView) => {
    if (next !== view) void run({ type: 'view', view: next })
  }

  const choose = (node: TreeNode) => {
    if (!canAct || lock.current) return

    setTreeSelection(node)

    const motorKey = node.kind === 'motor' ? node.id : undefined

    const deviceKey = ['imu', 'battery', 'pms', 'glove', 'dexhand'].includes(node.kind ?? '')
      ? node.id
      : undefined

    if (
      motorKey !== session.selected ||
      deviceKey !== session.selectedDevice ||
      node.id !== activeNode?.id
    )
      void run({ type: 'select', motorKey, deviceKey })
  }

  const adapterFor = (node: TreeNode | undefined) =>
    session.adapters.find(
      (adapter) =>
        adapter.key === node?.id ||
        (node?.kind === 'slave' && JSON.parse(node.id).adapterKey === adapter.key) ||
        adapter.motors.some((m) => m.key === node?.id) ||
        (adapter.devices ?? []).some((d) => d.key === node?.id) ||
        adapter.buses.some(
          (bus) => JSON.stringify({ adapterKey: adapter.key, ...bus }) === node?.id,
        ),
    )

  const openDevice = (kind: Exclude<DeviceKind, 'glove'>, node = activeNode) => {
    const adapter = adapterFor(node) ?? session.adapters[0]
    const buses = adapter ? availableDeviceBuses(adapter) : []
    const exact = buses.find((item) => JSON.stringify({ adapterKey: adapter?.key, ...item }) === node?.id)
    const located = adapter?.motors.find((item) => item.key === node?.id) ??
      adapter?.devices.find((item) => item.key === node?.id)
    const preferred = node?.kind === 'slave'
      ? buses.filter((bus) => bus.slaveId === JSON.parse(node.id).slaveId)
      : buses
    const bus = exact ?? (kind === 'dexhand'
      ? preferred.find((item) => item.busId === located?.busId && item.slaveId === located.slaveId) ??
        preferred[0]
      : buses[0])

    setDeviceKind(kind)

    setDeviceBus(adapter && bus ? busSelectionKey(adapter.key, bus) : '')

    setDeviceId(kind === 'motor' || kind === 'dexhand' ? '1' : '0')
    setDialog('device')
  }

  const openGlove = () => {
    const adapter = adapterFor(activeNode)

    const candidate =
      adapter && isEthercat(adapter.type)
        ? adapter
        : session.adapters.find((a) => isEthercat(a.type))

    setGloveAdapter(candidate?.key ?? '')

    setGloveSlave(
      candidate && availableGloveSlaves(candidate)[0] !== undefined
        ? String(availableGloveSlaves(candidate)[0])
        : '',
    )

    setDialog('glove')
  }

  const addGlove = async () => {
    if (!gloveAdapter || gloveSlave === '') {
      notify('Select an EtherCAT adapter and an available slave', { severity: 'error' })

      return
    }

    if (
      (await run(
        { type: 'add-glove', adapterKey: gloveAdapter, slaveId: Number(gloveSlave) },
        'Glove added',
      )) !== undefined
    )
      setDialog(undefined)
  }

  const add = async () => {
    if (
      (await run(
        { type: 'add', adapterType, interfaceName: iface, timing: newTiming },
        'Adapter connected',
      )) !== undefined
    )
      setDialog(undefined)
  }

  const addDevice = async () => {
    try {
      const adapter = session.adapters.find((item) =>
          availableDeviceBuses(item).some((bus) => busSelectionKey(item.key, bus) === deviceBus),
        ),
        bus =
          adapter &&
          availableDeviceBuses(adapter).find(
            (item) => busSelectionKey(adapter.key, item) === deviceBus,
          )

      if (!adapter || !bus) throw new Error('Select an adapter and bus')

      const id = parseDeviceId(deviceId, deviceKind)

      if (
        (await run(
          { type: 'add-device', kind: deviceKind, adapterKey: adapter.key, ...bus, deviceId: id },
          `${deviceLabel(deviceKind)} added`,
        )) !== undefined
      )
        setDialog(undefined)
    } catch (error) {
      notify((error as Error).message, { severity: 'error' })
    }
  }

  useInput(
    (input, key) => {
      if (key.eventType === 'release') return

      if (key.ctrl && !key.shift && input === 'c') {
        if (dialog === 'quit') onQuit()
        else setDialog('quit')
      }
    },
    { isActive: !interactionBlocked },
  )

  const loadingLabel =
    busy === 'add'
      ? 'Adding adapter...'
      : busy === 'scan'
        ? 'Scanning motors...'
        : busy === 'Loading driver'
          ? 'Loading driver...'
          : busy === 'adapter-config-open'
            ? 'Opening adapter...'
            : busy === 'adapter-config-command'
              ? 'Configuring adapter...'
              : busy === 'serial-ports'
                ? 'Finding USB CDC devices...'
                : undefined

  const pageWidth = Math.max(30, columns - (view === 'play' || view === 'adapter-config' ? 2 : 40))

  const manualBus = session.adapters.flatMap((adapter) =>
    availableDeviceBuses(adapter).map((bus) => ({ ...bus, adapter })),
  ).find(({ adapter, ...bus }) => busSelectionKey(adapter.key, bus) === deviceBus)

  const dialogNode =
    dialog === 'add' ? (
      <Dialog
        title="Add adapter"
        onClose={() => setDialog(undefined)}
        onConfirm={() => {
          if (canAct) void add()
        }}
        confirmLabel={busy ? 'Connecting...' : 'Connect'}
        width={64}
      >
        <Dropdown
          label="Adapter type"
          width={48}
          value={adapterType}
          options={interfaces.types.map((item) => ({ value: item.type, label: item.type }))}
          onChange={(type) => {
            setAdapterType(type)
            setIface(interfaces.types.find((item) => item.type === type)?.interfaces[0] ?? '')
          }}
        />
        {(interfaces.types.find((item) => item.type === adapterType)?.interfaces.length ?? 0) >
        0 ? (
          <Dropdown
            label="Available interfaces"
            width={48}
            value={iface}
            options={(
              interfaces.types.find((item) => item.type === adapterType)?.interfaces ?? []
            ).map((id) => ({ value: id, label: id }))}
            onChange={setIface}
          />
        ) : (
          <>
            <FieldLabel>Interface / endpoint</FieldLabel>
            <TextInput width={48} value={iface} onChange={setIface} />
          </>
        )}
        <TimingFields value={newTiming} onChange={setNewTiming} width={48} />
      </Dialog>
    ) : dialog === 'glove' ? (
      <Dialog
        title="Add Glove"
        onClose={() => setDialog(undefined)}
        onConfirm={() => {
          if (canAct) void addGlove()
        }}
        confirmLabel="Add"
        width={64}
      >
        <Dropdown
          label="EtherCAT adapter"
          width={48}
          value={gloveAdapter}
          options={session.adapters
            .filter((a) => isEthercat(a.type))
            .map((a) => ({ value: a.key, label: `${a.type} · ${a.interfaceName}` }))}
          onChange={(key) => {
            setGloveAdapter(key)

            const adapter = session.adapters.find((a) => a.key === key)

            setGloveSlave(
              adapter && availableGloveSlaves(adapter)[0] !== undefined
                ? String(availableGloveSlaves(adapter)[0])
                : '',
            )
          }}
        />
        <Dropdown
          label="Slave"
          width={48}
          value={gloveSlave}
          options={(session.adapters.find((a) => a.key === gloveAdapter)
            ? availableGloveSlaves(session.adapters.find((a) => a.key === gloveAdapter)!)
            : []
          ).map((slave) => ({ value: String(slave), label: `Slave ${slave}` }))}
          onChange={setGloveSlave}
        />
      </Dialog>
    ) : dialog === 'device' ? (
      <Dialog
        title={`Add ${deviceLabel(deviceKind)}`}
        onClose={() => setDialog(undefined)}
        onConfirm={() => {
          if (canAct) void addDevice()
        }}
        confirmLabel="Add"
        width={64}
      >
        {deviceKind === 'dexhand' ? (
          <Text>{manualBus ? `${manualBus.adapter.interfaceName} · ${busLabel(manualBus)}` : 'Select a bus before adding a DexHand'}</Text>
        ) : <TreeSelect
          label="Bus"
          width={48}
          maxHeight={12}
          nodes={busSelectionTree(session.adapters)}
          value={deviceBus}
          onChange={setDeviceBus}
        />}
        <FieldLabel>{deviceKind === 'dexhand' ? 'Base ID' : 'ID'}</FieldLabel>
        <TextInput size="large" width={48} value={deviceId} onChange={setDeviceId} />
      </Dialog>
    ) : dialog === 'quit' ? (
      <Dialog
        title="Close motor session"
        onClose={() => setDialog(undefined)}
        onConfirm={onQuit}
        confirmLabel="Quit"
      >
        <Text>Quit stops sending commands and disconnects adapters.</Text>
        <Text>Use Stop or Engage brake first if required by your device.</Text>
      </Dialog>
    ) : undefined

  return (
    <Box
      width={columns}
      height={rows}
      flexDirection="column"
      backgroundColor={colors.background}
      overflow="hidden"
    >
      <DialogHost
        dialog={
          dialog === 'quit' ? (
            dialogNode
          ) : loadingLabel ? (
            <LoadingOverlay label={loadingLabel} />
          ) : (
            (dialogNode ?? playDialog)
          )
        }
      >
        <MenuBar
          autoFocus
          menus={[
            {
              id: 'add',
              label: 'Add',
              disabled: view === 'play' || view === 'adapter-config',
              items: [
                {
                  id: 'adapter',
                  label: 'Add Adapter',
                  disabled: !canAct,
                  onSelect: () => void openAdd(),
                },
                ...(['motor', 'imu', 'battery', 'pms', 'dexhand'] as const).map((kind) => ({
                  id: kind,
                  label: `Add ${deviceLabel(kind)}`,
                  disabled: !canAct || !session.adapters.length,
                  onSelect: () => openDevice(kind),
                })),
                {
                  id: 'glove',
                  label: 'Add Glove',
                  disabled: !canAct || !session.adapters.some((a) => isEthercat(a.type)),
                  onSelect: openGlove,
                },
                { id: 'scan-separator', label: '', separator: true },
                {
                  id: 'rescan',
                  label: 'ReScan Motors',
                  disabled: !canAct || !session.adapters.length,
                  onSelect: () => void run({ type: 'scan' }),
                },
              ],
            },
            {
              id: 'view',
              label: 'View',
              items: (['single', 'batch', 'play', 'adapter-config'] as const).map((item) => ({
                id: item,
                label:
                  item === 'adapter-config'
                    ? 'Adapter Config'
                    : item[0].toUpperCase() + item.slice(1),
                checked: view === item,
                disabled: !canAct || (item === 'adapter-config' && session.adapters.length > 0),
                onSelect: () => changeView(item),
              })),
            },
          ]}
        />
        <Box flexGrow={1} flexBasis={0} minHeight={0} gap={1}>
          {view !== 'play' && view !== 'adapter-config' ? (
            <Card
              title="Devices"
              width={Math.min(38, Math.max(26, Math.floor(columns * 0.25)))}
              paddingX={0}
              scrollable={false}
            >
              {(view === 'batch' ? batchTree.length : tree.length) ? (
                <TreeList
                  key={view}
                  nodes={view === 'batch' ? batchTree : tree}
                  value={view === 'batch' ? undefined : activeNode?.id}
                  checkedIds={view === 'batch' ? (session.batchKeys ?? []) : undefined}
                  onToggle={(node) => {
                    if (canAct)
                      void run({
                        type: 'batch-selection',
                        motorKeys: toggleTreeSelection(node, session.batchKeys ?? []),
                        expectedView: 'batch',
                      })
                  }}
                  borderless
                  compact
                  onSelect={choose}
                  contextMenu={(node) => {
                    if (node.kind === 'slave') return []

                    if (node.kind === 'bus') {
                      return (['motor', 'imu', 'battery', 'pms', 'dexhand'] as const).map((kind) => ({
                        id: `add-${kind}`,
                        label: `Add ${deviceLabel(kind)}`,
                        disabled: !canAct,
                        onSelect: () => openDevice(kind, node),
                      }))
                    }

                    const motor = session.adapters
                      .flatMap((adapter) => adapter.motors)
                      .find((item) => item.key === node.id)

                    return [
                      ...(motor
                        ? [
                            {
                              id: 'canfd',
                              label: 'CAN FD',
                              checked: motor.canfd,
                              disabled: !canAct || Boolean(motor.dexHandKey),
                              onSelect: () =>
                                void run({
                                  type: 'canfd',
                                  motorKey: motor.key,
                                  enabled: !motor.canfd,
                                }),
                            },
                          ]
                        : []),
                      {
                        id: 'delete',
                        label: 'Delete',
                        disabled: !canAct || Boolean(motor?.dexHandKey),
                        onSelect: () =>
                          void run(
                            node.kind === 'adapter'
                              ? { type: 'remove', adapterKey: node.id }
                              : { type: 'remove-device', deviceKey: node.id },
                          ),
                      },
                    ]
                  }}
                />
              ) : (
                <Box flexGrow={1} minHeight={0} alignItems="center" justifyContent="center">
                  <Text color={colors.text}>No devices</Text>
                </Box>
              )}
            </Card>
          ) : null}
          <Box flexGrow={1} flexBasis={0} minWidth={0} flexDirection="column">
            {view === 'adapter-config' ? (
              <AdapterConfigPanel
                session={session}
                client={client}
                onDialog={setPlayDialog}
                run={run}
                enabled={canAct && !busy}
                width={pageWidth}
              />
            ) : view === 'play' ? (
              <PlayPanel
                session={session}
                client={client}
                run={run}
                enabled={canAct}
                width={pageWidth}
                onDialog={setPlayDialog}
                onFooter={(actions, hints) => {
                  setPlayActions(actions)
                  setPlayHints(hints)
                }}
              />
            ) : view === 'batch' ? (
              <BatchPanel
                session={session}
                client={client}
                run={run}
                enabled={canAct}
                width={pageWidth}
              />
            ) : selected ? (
              <>
                <Tabs items={TABS} value={tab} onChange={setTab} />
                {tab === 'control' ? (
                  <ControlPanel
                    key={selected.key}
                    run={motorRequest}
                    enabled={motorReady}
                    width={pageWidth}
                    drafts={drafts}
                    setDrafts={setDrafts}
                    command={session.controlCommand}
                    motor={selected}
                    sample={motorSample?.motorKey === selected.key ? motorSample : undefined}
                  />
                ) : tab === 'settings' ? (
                  <Card title="Motor settings">
                    <Box flexDirection="column" gap={1}>
                      {SETTINGS.filter((setting) => !selected.dexHandKey || supportsDexHandJointSetting(setting.id)).map((setting) => (
                        <SettingEditor
                          key={setting.id}
                          setting={setting}
                          values={
                            settings[setting.id] ??
                            setting.fields.map(() => (setting.id === 'comm' ? 'can' : ''))
                          }
                          onChange={(values) =>
                            setSettings((current) => ({ ...current, [setting.id]: values }))
                          }
                          run={motorRequest}
                          enabled={motorReady}
                          width={pageWidth}
                        />
                      ))}
                    </Box>
                  </Card>
                ) : (
                  <Card title="Live telemetry" scrollable={false}>
                    <LineChart
                      series={chartSeries}
                      windowMs={10000}
                      hiddenSeriesIds={METRICS.filter(
                        (metric) => !session.graph.includes(metric.value as GraphMetric),
                      ).map((metric) => metric.value)}
                      onHiddenSeriesChange={(hidden) => {
                        if (canAct)
                          void run({
                            type: 'graph',
                            metrics: METRICS.filter((metric) => !hidden.includes(metric.value)).map(
                              (metric) => metric.value as GraphMetric,
                            ),
                          })
                      }}
                      yAxes={METRICS.map((metric, i) => ({
                        id: metric.value,
                        label: metric.axisLabel,
                        position: i === 0 ? 'left' : 'right',
                        color: metric.color,
                      }))}
                    />
                  </Card>
                )}
              </>
            ) : peripheral?.kind === 'dexhand' ? (
              <ScopePanel
                key={peripheral.key}
                adapter={adapterFor(activeNode)!}
                scope={{ adapterKey: peripheral.adapterKey, slaveId: peripheral.slaveId, busId: peripheral.busId!, dexHandKey: peripheral.key }}
                run={run}
                enabled={canAct && session.selectedDevice === peripheral.key}
                width={pageWidth}
                updates={performance}
              />
            ) : peripheral ? (
              <DevicePanel
                key={peripheral.key}
                device={peripheral}
                sample={deviceSample?.deviceKey === peripheral.key ? deviceSample : undefined}
                run={run}
                enabled={canAct && session.selectedDevice === peripheral.key}
                width={pageWidth}
              />
            ) : selectedBus && busAdapter ? (
              <ScopePanel
                client={client}
                key={activeNode!.id}
                adapter={busAdapter}
                scope={selectedBus}
                run={run}
                enabled={canAct}
                width={pageWidth}
                updates={performance}
              />
            ) : (
              <Card title={activeNode?.label ?? 'Device'} scrollable={false}>
                <Box flexGrow={1} minHeight={0} alignItems="center" justifyContent="center">
                  <Text color={colors.text}>
                    {activeNode ? 'Coming soon' : 'No device selected'}
                  </Text>
                </Box>
              </Card>
            )}
            <LogCard
              store={logs}
              title="Logs"
              height={Math.max(6, Math.min(14, Math.floor(rows * 0.25)))}
              collapsible
              collapsed={logsCollapsed}
              onCollapsedChange={setLogsCollapsed}
            />
          </Box>
        </Box>
        <Footer
          hints={
            view === 'adapter-config'
              ? []
              : view === 'play'
                ? playHints
                : [{ key: 'ctrl+Space', label: 'Item Menu' }]
          }
          actions={[
            ...(view === 'adapter-config'
              ? []
              : view === 'play'
                ? playActions.map((a) => ({ ...a, disabled: a.disabled || Boolean(playDialog) }))
                : [
                    {
                      key: 'ctrl+n',
                      label: 'Add adapter',
                      disabled: !canAct,
                      onPress: () => void openAdd(),
                    },
                  ]),
            { key: 'ctrl+l', label: 'Logs', onPress: () => setLogsCollapsed((value) => !value) },
            { key: 'ctrl+c', label: 'Quit', onPress: () => setDialog('quit') },
          ]}
        />
      </DialogHost>
    </Box>
  )
}
