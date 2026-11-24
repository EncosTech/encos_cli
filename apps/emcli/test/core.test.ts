// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict'
import test from 'node:test'

import { summarizeSamples, percentile } from '../src/stats.js'
import { parseMotorConnection, parseMotorTarget, parseScanTarget } from '../src/target.js'

test('parses motor targets with all supported scopes', () => {
  assert.deepEqual(parseMotorTarget('Can:can0:ALL'), {
    adapterType: 'Can',
    adapterId: 'can0',
    scope: 'adapter',
  })
  assert.deepEqual(parseMotorTarget('Can:can0:0:1'), {
    adapterType: 'Can',
    adapterId: 'can0',
    scope: 'motor',
    busId: 0,
    motorId: 1,
  })
  assert.deepEqual(parseMotorTarget('Ethercat:eth0:3:0:ALL'), {
    adapterType: 'Ethercat',
    adapterId: 'eth0',
    scope: 'bus',
    slaveId: 3,
    busId: 0,
  })
  assert.throws(() => parseMotorTarget('Can:can0'), /无效目标/)
})

test('parses scan targets and trajectory connections', () => {
  assert.deepEqual(parseScanTarget('Ethercat:eth0:3:0'), {
    adapterType: 'Ethercat',
    adapterId: 'eth0',
    slaveId: 3,
    busId: 0,
  })
  assert.deepEqual(parseMotorConnection('Ethercat:eth0:0:1'), {
    adapterType: 'Ethercat',
    adapterId: 'eth0',
    busId: 0,
    motorId: 1,
  })
  assert.deepEqual(parseMotorConnection('Ethercat:eth0:3:0:2'), {
    adapterType: 'Ethercat',
    adapterId: 'eth0',
    slaveId: 3,
    busId: 0,
    motorId: 2,
  })
})

test('computes percentiles and MdAPE like the legacy bench', () => {
  const summary = summarizeSamples([1, 2, 3, 4, 5])
  assert.equal(summary.meanUs, 3)
  assert.equal(summary.p50Us, 3)
  assert.equal(percentile([1, 2, 3, 4, 5], 0.01), 1.04)
  assert.equal(summary.opsPerSecond, 1e6 / 3)
  assert.equal(summary.errorPercent, 40)
})
