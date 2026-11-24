// SPDX-License-Identifier: MIT

import assert from 'node:assert/strict'
import test from 'node:test'

import { timingExtend } from '../src/runtime-options.js'

test('native adapter timing preserves integer rates and fractional sample points', () => {
  const timing = {
    bitrate: 250000,
    dbitrate: 5000000,
    sample_point: 0.875,
    dsample_point: 0.882,
  }

  assert.deepEqual(timingExtend(timing), {
    bitrate: 250000n,
    dbitrate: 5000000n,
    sample_point: 0.875,
    dsample_point: 0.882,
  })
  assert.equal(timing.bitrate, 250000)
})

test('unspecified timing stays omitted at the native boundary', () => {
  assert.equal(timingExtend({}), undefined)
  assert.deepEqual(timingExtend({ sample_point: 0.875 }), { sample_point: 0.875 })
})
