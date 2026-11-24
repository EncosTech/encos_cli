// SPDX-License-Identifier: MIT

import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { Box } from 'ink'
import { PassThrough } from 'node:stream'
import { render, cleanup } from 'ink-testing-library'
import { AdapterConfigPanel } from '../src/studio/AdapterConfigPanel.js'
import { StatisticsPanel } from '../src/studio/StatisticsPanel.js'
import { MouseProvider, type MouseEvent } from '../src/tui/mouse.js'
import { OverlayProvider } from '../src/tui/overlay.js'
import type { StudioClient, SessionState, Request } from '../src/studio/protocol.js'

const wait = (ms = 100) => new Promise((r) => setTimeout(r, ms))

afterEach(cleanup)

function harness(node: React.ReactNode) {
  let mouse = (_e: MouseEvent) => {}

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
      <OverlayProvider>
        <Box width={100} height={36} flexDirection="column">
          {node}
        </Box>
      </OverlayProvider>
    </MouseProvider>,
  )

  const click = async (label: string, rowOffset = 0) => {
    const lines = (app.lastFrame() ?? '').split('\n'),
      y = lines.findIndex((l) => l.includes(label))

    assert.ok(y >= 0, label + ': ' + app.lastFrame())
    mouse({ action: 'press', button: 'left', x: lines[y].indexOf(label) + 1, y: y + rowOffset })
    await wait()
  }

  return { app, click }
}

const base: SessionState = { view: 'adapter-config', adapters: [], graph: [] }

const client: StudioClient = {
  request: async <T,>() => [] as T,
  subscribe: () => () => {},
  close: async () => {},
}

test('configuration opens with populated mode; Enet network controls appear only for Enet', async () => {
  const requests: Request[] = []
  const session = { ...base, adapterConfig: { port: '/dev/ttyACM0', mode: 'ecat' as const } }

  const { app, click } = harness(
    <AdapterConfigPanel
      session={session}
      client={client}
      width={96}
      enabled
      onDialog={() => {}}
      run={async (r) => {
        requests.push(r)

        return r.type === 'serial-ports'
          ? []
          : { ...session.adapterConfig, network: { slaveId: 6, ip: '192.168.100.7' } }
      }}
    />,
  )

  await wait()
  assert.match(app.lastFrame() ?? '', /ecat/)
  assert.doesNotMatch(app.lastFrame() ?? '', /Slave ID|IPv4|Response|Raw command/)
  await click('ecat')
  await click('enet')
  await wait()
  assert.match(app.lastFrame() ?? '', /Slave ID/)
  assert.match(app.lastFrame() ?? '', /192.168.100.7/)
  assert.ok(requests.some((r) => r.type === 'adapter-config-command' && r.item === 'ip'))
  await click('Read version')
  assert.ok(requests.some((r) => r.type === 'adapter-config-command' && r.item === 'version'))
})

test('serial selector presents USB device name when discovery succeeds', async () => {
  const { app } = harness(
    <AdapterConfigPanel
      session={base}
      client={{
        ...client,
        request: async <T,>() => [{ port: '/dev/ttyACM0', name: 'Encos Gateway' }] as T,
      }}
      width={96}
      enabled
      onDialog={() => {}}
      run={async () => [{ port: '/dev/ttyACM0', name: 'Encos Gateway' }]}
    />,
  )

  await wait()
  assert.match(app.lastFrame() ?? '', /ttyACM0.*Encos Gateway/)
})

test('statistics poll serially and stop after panel unmount', async () => {
  let count = 0,
    inFlight = 0,
    maxInFlight = 0

  const polling: StudioClient = {
    ...client,
    request: async <T,>() => {
      count++
      maxInFlight = Math.max(maxInFlight, ++inFlight)
      await wait(30)
      inFlight--

      return {
        buses: [
          {
            slaveId: 0,
            busId: 0,
            status: 'valid',
            errorCounters: { tx: 0, rx: 2, kind: 'current' },
          },
        ],
      } as T
    },
  }

  const { app } = harness(<StatisticsPanel adapterKey="a" client={polling} width={96} />)

  await wait(650)
  assert.match(app.lastFrame() ?? '', /TX errors/)
  assert.ok(count >= 2)
  assert.equal(maxInFlight, 1)
  app.unmount()

  const stopped = count

  await wait(600)
  assert.equal(count, stopped)
})

test('CDC discovery is not dropped while the view-change operation still holds the action lock', async () => {
  const requests: Request[] = []
  const discovering: StudioClient = {
    ...client,
    request: async <T,>(request: Request) => {
      requests.push(request)
      return [{ port: '/dev/ttyACM0', name: 'Encos Gateway' }] as T
    },
  }

  const { app } = harness(
    <AdapterConfigPanel
      session={base}
      client={discovering}
      width={96}
      enabled={false}
      onDialog={() => {}}
      run={async () => undefined}
    />,
  )

  await wait()
  assert.ok(requests.some((request) => request.type === 'serial-ports'))
  assert.match(app.lastFrame() ?? '', /ttyACM0.*Encos Gateway/)
})

test('empty discovery allows manual input and vertically centers its message with the buttons', async () => {
  const requests: Request[] = []
  const empty: StudioClient = { ...client, request: async <T,>() => [] as T }

  const { app, click } = harness(
    <AdapterConfigPanel
      session={base}
      client={empty}
      width={96}
      enabled
      onDialog={() => {}}
      run={async (request) => {
        requests.push(request)
      }}
    />,
  )

  await wait()
  assert.match(app.lastFrame() ?? '', /Serial port/)
  app.stdin.write('/dev/ttyACM9')
  await wait()
  await click('Open')
  assert.ok(
    requests.some(
      (request) => request.type === 'adapter-config-open' && request.port === '/dev/ttyACM9',
    ),
  )

  const lines = (app.lastFrame() ?? '').split('\n')
  assert.equal(
    lines.findIndex((line) => line.includes('No USB CDC devices')),
    lines.findIndex((line) => line.includes('Refresh')),
  )
})

test('manually entered UPD path enables Download and sends the package path', async () => {
  const requests: Request[] = []
  const { app, click } = harness(
    <AdapterConfigPanel
      session={{ ...base, adapterConfig: { port: '/dev/ttyACM0', mode: 'ecat' } }}
      client={client}
      width={96}
      enabled
      onDialog={() => {}}
      run={async (request) => {
        requests.push(request)
      }}
    />,
  )

  await wait()
  await click('Firmware file', 2)
  app.stdin.write('/tmp/usb_device_update.upd')
  await wait()
  await click('Download')

  assert.ok(
    requests.some(
      (request) =>
        request.type === 'adapter-config-command' &&
        request.item === 'download' &&
        request.value === '/tmp/usb_device_update.upd',
    ),
  )
})
