// SPDX-License-Identifier: MIT

import test from 'node:test'
import assert from 'node:assert/strict'
import { NativeSession } from '../src/studio/native-session.js'
import type { PerformanceUpdate } from '../src/studio/protocol.js'

test(
  'backend enforces configuration isolation and statistics do not stop stress',
  { timeout: 20000 },
  async () => {
    const updates: PerformanceUpdate[] = []

    const session = new NativeSession(
      (event) => {
        if (event.type === 'performance') updates.push(event.update)
      },
      { demo: true },
    )

    await session.initialize()

    try {
      await session.request({ type: 'view', view: 'adapter-config' })

      await assert.rejects(
        session.request({ type: 'add', adapterType: 'Fake', interfaceName: 'isolated' }),
        /unavailable/,
      )

      await session.request({ type: 'view', view: 'single' })
      await session.request({ type: 'add', adapterType: 'Fake', interfaceName: 'statistics-test' })

      const adapter = session.state().adapters[0]

      await session.request({
        type: 'stress-start',
        scope: { adapterKey: adapter.key },
        motorKeys: adapter.motors.slice(0, 1).map((m) => m.key),
        frequencyHz: 10,
      })

      const before = updates.length

      assert.equal(
        await session.request({ type: 'adapter-statistics', adapterKey: adapter.key }),
        null,
      )

      await assert.rejects(
        session.request({ type: 'view', view: 'adapter-config' }),
        /Disconnect all adapters/,
      )

      assert.equal(session.state().view, 'single')

      assert.equal(
        updates.slice(before).some((update) => !update.running),
        false,
        'read-only stats and rejected view must not stop stress',
      )

      await session.request({ type: 'stress-stop' })
      await session.request({ type: 'remove', adapterKey: adapter.key })
      await session.request({ type: 'view', view: 'adapter-config' })

      await assert.rejects(
        session.request({ type: 'adapter-config-open', port: 'invalid' }),
        /valid serial port/,
      )
    } finally {
      await session.request({ type: 'shutdown' })
    }
  },
)
