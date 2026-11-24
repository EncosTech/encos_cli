// SPDX-FileCopyrightText: 2026 Encos
// SPDX-License-Identifier: MIT

import { FieldLabel } from '../tui/components/FieldLabel.js'
import React, { useState } from 'react'
import { Box, Text } from 'ink'
import {
  Button,
  Card,
  Tabs,
  Table,
  TextInput,
  TreeList,
  TreeSelect,
  useNotifications,
  type TreeNode,
  type TreeSelectNode,
} from '../tui/index.js'
import { StatisticsPanel } from './StatisticsPanel.js'
import { DexHandSettings } from './DexHandSettings.js'
import { supportsStatistics } from './adapter-statistics.js'
import type { StudioClient } from './protocol.js'
import { TimingFields } from './TimingFields.js'
import { validateTiming } from './bus-timing.js'
import { busKey, compareMotorDisplay, motorDisplayLabel } from './devices.js'
import type {
  AdapterInfo,
  AdapterTiming,
  TestScope,
  PerformanceUpdate,
  Request,
} from './protocol.js'
import { testScopeKey, scopedMotors, stressPeriod } from './performance.js'
import { colors } from '../tui/theme.js'

const number = (n: number) => (Number.isFinite(n) ? n.toFixed(2) : '—')

type StressUpdate = Extract<PerformanceUpdate, { kind: 'stress' }>

export function stressTree(update: StressUpdate, adapter?: AdapterInfo): TreeNode[] {
  const motors = update.snapshot.motors

  const totals = (items: typeof motors) => {
    const sent = items.reduce((sum, m) => sum + m.sent, 0),
      lost = items.reduce((sum, m) => sum + Math.max(0, m.sent - m.received), 0)

    return `${lost}/${sent} (${number(sent ? (lost / sent) * 100 : 0)}%)`
  }

  const slaves = [...new Set(motors.map((m) => m.slaveId ?? 0))]
    .sort((a, b) => a - b)
    .map((slave) => {
      const members = motors.filter((m) => (m.slaveId ?? 0) === slave)

      const buses = [...new Set(members.map((m) => m.busId))]
        .sort((a, b) => a - b)
        .map((bus) => {
          const items = members.filter((m) => m.busId === bus),
            id = `slave:${slave}:bus:${bus}`

          return {
            id,
            label: `Bus ${bus}  ${totals(items)}`,
            children: items
              .map((motor) => ({
                motor,
                address: adapter?.motors.find((item) => item.motorId === motor.motorId &&
                  item.busId === motor.busId && (item.slaveId ?? 0) === slave) ?? motor,
              }))
              .sort((a, b) => compareMotorDisplay(a.address, b.address))
              .map(({ address, motor }) => ({
                id: `${id}:motor:${motor.motorId}`,
                label: `${motorDisplayLabel(address)}  ${totals([motor])}`,
              })),
          }
        })

      return { id: `slave:${slave}`, label: `Slave ${slave}  ${totals(members)}`, children: buses }
    })

  if (update.scope.busId !== undefined) return slaves.flatMap((s) => s.children)

  if (update.scope.slaveId !== undefined) return slaves

  return [
    {
      id: `adapter:${update.scope.adapterKey}`,
      label: `${adapter ? `${adapter.type} · ${adapter.interfaceName}` : 'Adapter'}  ${totals(motors)}`,
      children: slaves,
    },
  ]
}

export function StressSummary({ update }: { update: StressUpdate }) {
  const s = update.snapshot,
    lost = Math.max(0, s.sent - s.received)

  const rows: Array<[string, string | number]> = [
    ['State', update.running ? 'Running' : 'Stopped'],
    ['Elapsed (s)', number(s.elapsedMs / 1000)],
    ['Lost / sent', `${lost}/${s.sent} (${number(s.sent ? (lost / s.sent) * 100 : 0)}%)`],
    [
      'Received / s',
      `${s.received} / ${number(s.measurementMs ? (s.received * 1000) / s.measurementMs : 0)}`,
    ],
  ]

  const joints = s.motors.filter((motor) => motor.motorId >>> 29)
  if (joints.length && s.periodMs && s.measurementMs > 0) {
    const rates = joints.map((motor) => (motor.sent * 1000) / s.measurementMs)
    const min = number(Math.min(...rates)), max = number(Math.max(...rates))
    const actual = min === max ? min : `${min}–${max}`
    rows.push(['DexHand actual / set', `${actual} / ${number(1000 / s.periodMs)} Hz`])
  }

  return (
    <Table
      rows={rows}
      height={rows.length}
      rowKey={(r) => r[0]}
      columns={[
        { key: 'metric', header: 'Metric', width: 20, value: (r) => r[0] },
        { key: 'value', header: 'Value', width: 32, value: (r) => r[1] },
      ]}
    />
  )
}

export function motorSelectionTree(adapter: AdapterInfo, scope: TestScope): TreeSelectNode[] {
  const motors = scopedMotors(adapter, scope)
  if (scope.dexHandKey)
    return motors.sort(compareMotorDisplay).map((m) => ({ value: m.key, label: motorDisplayLabel(m) }))

  const slaves = [...new Set(motors.map((m) => m.slaveId ?? 0))]
    .sort((a, b) => a - b)
    .map((slave) => {
      const members = motors.filter((m) => (m.slaveId ?? 0) === slave)

      return {
        value: `slave:${slave}`,
        label: `Slave ${slave}`,
        selectable: true,
        children: [...new Set(members.map((m) => m.busId))]
          .sort((a, b) => a - b)
          .map((bus) => ({
            value: `slave:${slave}:bus:${bus}`,
            label: `Bus ${bus}`,
            selectable: true,
            children: members
              .filter((m) => m.busId === bus)
              .sort(compareMotorDisplay)
              .map((m) => ({ value: m.key, label: motorDisplayLabel(m) })),
          })),
      }
    })

  const buses = slaves.flatMap((s) => s.children)

  if (scope.busId !== undefined)
    return buses.length
      ? buses
      : [
          {
            value: `slave:${scope.slaveId ?? 0}:bus:${scope.busId}`,
            label: `Bus ${scope.busId}`,
            selectable: true,
            children: [],
          },
        ]

  if (scope.slaveId !== undefined)
    return slaves.length
      ? slaves
      : [
          {
            value: `slave:${scope.slaveId ?? 0}`,
            label: `Slave ${scope.slaveId ?? 0}`,
            selectable: true,
            children: [],
          },
        ]

  return [
    {
      value: `adapter:${adapter.key}`,
      label: `${adapter.type} · ${adapter.interfaceName}`,
      selectable: true,
      children: slaves,
    },
  ]
}

export function ScopePanel({
  adapter,
  scope,
  run,
  enabled,
  width,
  updates,
  client,
}: {
  adapter: AdapterInfo
  scope: TestScope
  run: (r: Request, message?: string) => Promise<unknown>
  enabled: boolean
  width: number
  updates: Record<string, PerformanceUpdate>
  client?: StudioClient
}) {
  const isHand = scope.dexHandKey !== undefined
  const hand = adapter.devices?.find((item) => item.kind === 'dexhand' && item.key === scope.dexHandKey)
  const isBus = scope.busId !== undefined && !isHand

  const statistic =
    scope.busId === undefined &&
    scope.slaveId === undefined &&
    supportsStatistics(adapter.type) &&
    Boolean(client)

  const [tab, setTab] = useState(isHand ? 'settings' : isBus ? 'timing' : 'bench')
  const [frequency, setFrequency] = useState('1000')

  const [timing, setTiming] = useState<AdapterTiming>(() => ({
    ...adapter.timing,
    ...(isBus
      ? adapter.busTiming?.[busKey({ slaveId: scope.slaveId ?? null, busId: scope.busId! })]
      : {}),
  }))

  const { notify } = useNotifications()

  const key = testScopeKey(scope),
    bench = updates[`${key}:bench`],
    stress = updates[`${key}:stress`]

  const running = stress?.running ?? false
  const [selections, setSelections] = useState<{ bench?: string[]; stress?: string[] }>({})

  const testTab = tab === 'stress' ? 'stress' : 'bench',
    available = scopedMotors(adapter, scope).map((m) => m.key)

  const selected = (selections[testTab] ?? available).filter((key) => available.includes(key))

  const selector = (
    <TreeSelect
      multiple
      cascade
      label="Motors"
      width={Math.min(48, Math.max(20, width - 4))}
      nodes={motorSelectionTree(adapter, scope)}
      values={selected}
      onChange={(values) => setSelections((old) => ({ ...old, [testTab]: values }))}
    />
  )

  const apply = async () => {
    try {
      await run(
        {
          type: 'bus-timing',
          ...scope,
          slaveId: scope.slaveId ?? null,
          busId: scope.busId!,
          timing: validateTiming(timing, true),
        },
        'Bus timing applied',
      )
    } catch (error) {
      notify((error as Error).message, { severity: 'error' })
    }
  }

  const startStress = () => {
    try {
      const frequencyHz = Number(frequency)

      stressPeriod(frequencyHz)
      void run({ type: 'stress-start', scope, motorKeys: selected, frequencyHz })
    } catch (error) {
      notify((error as Error).message, { severity: 'error' })
    }
  }

  const rows = bench?.kind === 'bench' ? bench.rows : []

  return (
    <>
      <Tabs
        items={[
          ...(isBus ? [{ id: 'timing', label: 'Timing' }] : []),
          ...(isHand ? [{ id: 'settings', label: 'Settings' }] : [{ id: 'bench', label: 'Bench' }]),
          { id: 'stress', label: 'Stress' },
          ...(statistic ? [{ id: 'statistic', label: 'Statistic' }] : []),
        ]}
        value={tab}
        onChange={(next) => {
          if (next !== tab && running && next !== 'stress' && next !== 'statistic')
            void run({ type: 'stress-stop' })

          setTab(next)
        }}
      />
      {tab === 'settings' && hand ? (
        <DexHandSettings device={hand} run={run} enabled={enabled && !running} width={width} />
      ) : tab === 'statistic' && client ? (
        <StatisticsPanel adapterKey={adapter.key} client={client} width={width} />
      ) : tab === 'timing' ? (
        <Card title="Timing">
          <Box flexDirection="column" flexShrink={0} paddingTop={1} gap={1}>
            <TimingFields
              value={timing}
              onChange={setTiming}
              width={Math.min(width, 64)}
              defaultLabel="Unchanged"
            />
            <Button
              size="medium"
              variant="success"
              label="Apply timing"
              disabled={!enabled || running}
              onPress={() => void apply()}
            />
          </Box>
        </Card>
      ) : tab === 'bench' ? (
        <Card title="Bench">
          <Box flexDirection="column" flexShrink={0} paddingTop={1} gap={1}>
            <Box gap={1} flexWrap="wrap" alignItems="flex-end">
              {selector}
              <Button
                size="medium"
                variant="success"
                label={bench?.running ? 'Testing...' : 'Start test'}
                disabled={!enabled || running || Boolean(bench?.running) || !selected.length}
                onPress={() => void run({ type: 'bench', scope, motorKeys: selected })}
              />
            </Box>
            <Table
              rows={rows}
              height={5}
              rowKey={(r) => String(r.periodMs)}
              emptyText="No results"
              columns={[
                { key: 'period', header: 'ms', width: 5, value: (r) => r.periodMs },
                ...(['meanUs', 'p1Us', 'p5Us', 'p50Us', 'p95Us', 'p99Us'] as const).map(
                  (field) => ({
                    key: field,
                    header: field.replace('Us', ' µs'),
                    width: 9,
                    value: (r: (typeof rows)[number]) => number(r[field]),
                  }),
                ),
                { key: 'ops', header: 'op/s', width: 9, value: (r) => number(r.opsPerSecond) },
                { key: 'error', header: 'err %', width: 7, value: (r) => number(r.errorPercent) },
                { key: 'valid', header: 'Valid', width: 7, value: (r) => r.count },
                {
                  key: 'lost',
                  header: 'Lost/sent',
                  width: 12,
                  value: (r) => r.status === 'No probes' ? '—' : `${r.lost}/${r.attempts}`,
                },
                { key: 'status', header: 'Status', width: 10, value: (r) => r.status },
              ]}
            />
            {bench?.error ? <Text color={colors.danger}>{bench.error}</Text> : null}
          </Box>
        </Card>
      ) : (
        <Card title="Stress" scrollable={false}>
          <Box flexDirection="column" flexGrow={1} minHeight={0} paddingTop={1} gap={1}>
            <Box gap={1} flexShrink={0} flexWrap="wrap" alignItems="flex-end">
              {selector}
              <Box flexDirection="column">
                <FieldLabel>Frequency (Hz)</FieldLabel>
                <TextInput
                  size="large"
                  width={18}
                  value={frequency}
                  onChange={setFrequency}
                  disabled={!enabled || running}
                />
              </Box>
              <Button
                size="medium"
                variant="success"
                label="Start test"
                disabled={!enabled || running || Boolean(bench?.running) || !selected.length}
                onPress={startStress}
              />
              <Button
                size="medium"
                variant="danger"
                label="Stop test"
                disabled={!enabled || !running}
                onPress={() => void run({ type: 'stress-stop' })}
              />
            </Box>
            {stress?.kind === 'stress' ? (
              <>
                <StressSummary update={stress} />
                <TreeList nodes={stressTree(stress, adapter)} borderless compact />
              </>
            ) : (
              <Text color={colors.text}>No results</Text>
            )}
            {stress?.error ? <Text color={colors.danger}>{stress.error}</Text> : null}
          </Box>
        </Card>
      )}
    </>
  )
}
