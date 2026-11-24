// SPDX-License-Identifier: MIT

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  statisticsRows,
  readAdapterStatistics,
  StatisticsStatus,
  ErrorCounterKind,
} from '../src/studio/adapter-statistics.js'

test('common statistics display required addresses and valid zero without changing counter semantics', () => {
  const rows = statisticsRows({
    buses: [
      {
        slaveId: 0,
        busId: 2,
        status: StatisticsStatus.Valid,
        ageMs: 0,
        errorCounters: { tx: 0, rx: 7, kind: ErrorCounterKind.LastErrorEvent },
      },
      {
        slaveId: 1,
        busId: 0,
        status: StatisticsStatus.Stale,
        ageMs: 2000,
        errorCounters: { tx: 3, rx: 0, kind: ErrorCounterKind.Current },
      },
    ],
  })

  assert.deepEqual(rows, [
    {
      key: '0:2',
      slave: 0,
      bus: 2,
      status: 'valid',
      age: 0,
      kind: 'Last error event',
      tx: 0,
      rx: 7,
    },
    { key: '1:0', slave: 1, bus: 0, status: 'stale', age: 2000, kind: 'Current', tx: 3, rx: 0 },
  ])
})

test('pending and heartbeat-only snapshots do not fabricate error counters', () => {
  assert.equal(readAdapterStatistics({}), null)

  const rows = statisticsRows({
    buses: [
      { slaveId: 0, busId: 0, status: StatisticsStatus.Pending },
      { slaveId: 0, busId: 1, status: StatisticsStatus.Valid, ageMs: 5 },
    ],
  })

  assert.deepEqual(
    rows.map(({ tx, rx, kind, age }) => ({ tx, rx, kind, age })),
    [
      { tx: '-', rx: '-', kind: '-', age: '-' },
      { tx: '-', rx: '-', kind: '-', age: 5 },
    ],
  )
})
