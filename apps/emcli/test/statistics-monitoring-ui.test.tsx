// SPDX-FileCopyrightText: 2026 Encos
// SPDX-License-Identifier: MIT

import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { Box } from 'ink'
import { PassThrough } from 'node:stream'
import { render, cleanup } from 'ink-testing-library'
import { ScopePanel, StressSummary } from '../src/studio/ScopePanel.js'
import { StatisticsPanel } from '../src/studio/StatisticsPanel.js'
import { MouseProvider, type MouseEvent } from '../src/tui/mouse.js'
import { NotificationProvider } from '../src/tui/index.js'
import { testScopeKey } from '../src/studio/performance.js'
import type { StudioClient, Request, PerformanceUpdate } from '../src/studio/protocol.js'

const wait = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms))

afterEach(cleanup)

function harness(node: React.ReactNode) {
  let mouse = (_event: MouseEvent) => {}

  const input = {
    stdin: new PassThrough(),
    onMouse(fn: typeof mouse) {
      mouse = fn

      return () => {}
    },
    dispose() {},
  }

  const app = render(
    <MouseProvider input={input}>
      <NotificationProvider>
        <Box width={100} height={36} flexDirection="column">
          {node}
        </Box>
      </NotificationProvider>
    </MouseProvider>,
  )

  const click = async (label: string) => {
    const lines = (app.lastFrame() ?? '').split('\n'),
      y = lines.findIndex((line) => line.includes(label))

    assert.ok(y >= 0, label + ': ' + app.lastFrame())
    mouse({ action: 'press', button: 'left', x: lines[y].indexOf(label) + 1, y })
    await wait()
  }

  return { app, click }
}

const client: StudioClient = {
  request: async <T,>() => null as T,
  subscribe: () => () => {},
  close: async () => {},
}

test('DexHand Stress shows actual rates alongside the requested rate', async () => {
  const { app } = harness(
    <StressSummary
      update={{
        kind: 'stress',
        scope: { adapterKey: 'a' },
        running: false,
        snapshot: {
          sent: 2305, received: 2305, periodMs: 1, elapsedMs: 1000, measurementMs: 1000,
          drainMs: 0, drainAdditional: 0, outstandingBefore: 0, outstandingAfter: 0,
          motors: [
            { slaveId: 252, busId: 0, motorId: 5, sent: 1000, received: 1000 },
            { slaveId: 252, busId: 0, motorId: 1 | (1 << 29), sent: 650, received: 650 },
            { slaveId: 252, busId: 0, motorId: 2 | (7 << 29), sent: 655, received: 655 },
          ],
          error: '', final: true,
        },
      }}
    />,
  )

  await wait()
  assert.match(app.lastFrame() ?? '', /DexHand actual \/ set\s+650\.00–655\.00 \/ 1000\.00 Hz/)
})

test('stress continues across Statistic monitoring and stops when returning to Bench', async () => {
  const requests: Request[] = [],
    scope = { adapterKey: 'a' }

  const update = {
    kind: 'stress',
    scope,
    running: true,
    snapshot: { motors: [], sent: 0, received: 0, elapsedMs: 0, measurementMs: 0 },
  } as PerformanceUpdate

  const { app, click } = harness(
    <ScopePanel
      adapter={{
        key: 'a',
        type: 'Ethernet',
        interfaceName: 'test',
        buses: [],
        motors: [],
        devices: [],
      }}
      scope={scope}
      client={client}
      run={async (request) => {
        requests.push(request)
      }}
      enabled
      width={96}
      updates={{ [`${testScopeKey(scope)}:stress`]: update }}
    />,
  )

  await wait()
  await click('Stress')
  await click('Statistic')
  assert.equal(requests.filter((request) => request.type === 'stress-stop').length, 0)
  await click('Stress')
  assert.match(app.lastFrame() ?? '', /Running/)
  assert.equal(requests.filter((request) => request.type === 'stress-stop').length, 0)
  await click('Statistic')
  await click('Bench')
  assert.equal(requests.filter((request) => request.type === 'stress-stop').length, 1)
})

test('failed statistics refresh removes the previously valid snapshot', async () => {
  let calls = 0

  const polling: StudioClient = {
    ...client,
    request: async <T,>() => {
      if (++calls > 1) throw new Error('Refresh disconnected')

      return {
        buses: [
          {
            slaveId: 0,
            busId: 0,
            status: 'valid',
            errorCounters: { tx: 17, rx: 0, kind: 'current' },
          },
        ],
      } as T
    },
  }

  const { app } = harness(<StatisticsPanel adapterKey="a" client={polling} width={96} />)

  await wait()
  assert.match(app.lastFrame() ?? '', /valid/)
  assert.match(app.lastFrame() ?? '', /TX errors/)
  await wait(550)
  assert.match(app.lastFrame() ?? '', /Refresh disconnected/)
  assert.match(app.lastFrame() ?? '', /Statistics unavailable/)
  assert.doesNotMatch(app.lastFrame() ?? '', /TX errors|\bvalid\b/)
})
