// SPDX-FileCopyrightText: 2026 Encos
// SPDX-License-Identifier: MIT

import assert from 'node:assert/strict'
import test from 'node:test'
import * as driver from '@encos/encos-driver-native'
import { NativeSession } from '../src/studio/native-session.js'
import { dexHandJoints, formatDexHandPoints, parseDexHandSetting, type DexHandHandle } from '../src/studio/dex-hand.js'
import { deviceTree, parseDeviceId } from '../src/studio/devices.js'

test('DexHand lays out all twenty joints in 7, 7 and 6 ordered slots', () => {
  const joints = dexHandJoints(247)
  assert.equal(joints.length, 20)
  const layout = joints.map(({ motorId, jointLabel }) => [
    motorId & 0x1fffffff, motorId >>> 29, jointLabel,
  ])
  assert.deepEqual(layout, [
    [247, 1, 'Thumb 1'], [247, 2, 'Index 1'], [247, 3, 'Middle 1'], [247, 4, 'Ring 1'],
    [247, 5, 'Little 1'], [247, 6, 'Thumb 2'], [247, 7, 'Index 2'],
    [248, 1, 'Middle 2'], [248, 2, 'Ring 2'], [248, 3, 'Little 2'], [248, 4, 'Thumb 3'],
    [248, 5, 'Index 3'], [248, 6, 'Middle 3'], [248, 7, 'Ring 3'],
    [249, 1, 'Little 3'], [249, 2, 'Thumb 4'], [249, 3, 'Index 4'], [249, 4, 'Middle 4'],
    [249, 5, 'Ring 4'], [249, 6, 'Little 4'],
  ])
  assert.equal(parseDeviceId('0xF7', 'dexhand'), 247)
  assert.throws(() => parseDeviceId('248', 'dexhand'), /Base ID/)
})

test('DexHand settings convert between displayed percent and the wire units', () => {
  assert.deepEqual(parseDexHandSetting('sample-points', ['75.0', '87.5']), {
    item: 'sample-points', points: { nominal: 750, data: 875 },
  })
  assert.equal(formatDexHandPoints({ nominal: 750, data: 875 }), '75.0 87.5')
  assert.throws(() => parseDexHandSetting('sample-points', ['75.01', '87.5']), /sample points/)
  assert.throws(() => parseDexHandSetting('base-id', ['0']), /Base ID/)
})

const handPrototype = (driver as { DexHandWrapper?: { prototype: DexHandHandle } }).DexHandWrapper?.prototype

test('studio keeps twenty joints across management writes and releases previous addresses', {
  skip: !handPrototype && 'DexHand native driver is required',
  timeout: 25000,
}, async (t) => {
  const interfaceName = 'dex-hand-studio'
  const session = new NativeSession(() => {}, { demo: true })
  await session.initialize()
  const devices = () => session.state().adapters[0]
  const joints = () => devices().motors.filter((motor) => motor.dexHandKey)
  try {
    await session.request({ type: 'add', adapterType: 'Fake', interfaceName })
    const adapterKey = devices().key
    const bus = { slaveId: null, busId: 0 }
    const add = (deviceId: number) => session.request({
      type: 'add-device', kind: 'dexhand', adapterKey, ...bus, deviceId,
    })
    await add(11)
    assert.equal(joints().length, 20)
    const [hand] = devices().devices
    const handNode = deviceTree([devices()])[0].children![0].children![0]
    assert.equal(handNode.children?.length, 20)
    assert.ok(joints().every((motor) => motor.canfd && motor.dexHandKey === hand.key))
    await assert.rejects(add(13), /already uses/)
    await session.request({ type: 'select', motorKey: joints()[0].key })
    await assert.rejects(session.request({ type: 'write', item: 'id', values: ['7'] }), /fixed/)
    await assert.rejects(session.request({ type: 'read', item: 'can-timeout' }), /unavailable on DexHand joints/)
    await assert.rejects(session.request({ type: 'write', item: 'can-timeout', values: ['650'] }), /unavailable on DexHand joints/)
    await assert.rejects(session.request({ type: 'write', item: 'comm', values: ['canfd'] }), /unavailable on DexHand joints/)
    await assert.rejects(session.request({ type: 'canfd', enabled: false }), /require CAN FD/)
    await assert.rejects(session.request({ type: 'remove-device', deviceKey: joints()[0].key }), /Remove the DexHand/)
    await session.request({ type: 'view', view: 'batch' })
    await session.request({ type: 'batch-selection', motorKeys: [devices().motors[0].key, joints()[0].key] })
    await assert.rejects(session.request({ type: 'batch-write', item: 'can-timeout', values: ['650'] }), /unavailable on DexHand joints/)
    await session.request({ type: 'view', view: 'single' })
    await session.request({ type: 'select', deviceKey: hand.key })
    let baseId = 11, points = { nominal: 750, data: 875 }, failNextWrite = true
    t.mock.method(handPrototype!, 'getBaseId', async () => ({ status: 0, value: baseId }))
    t.mock.method(handPrototype!, 'getSamplePoints', async () => ({ status: 0, value: points }))
    t.mock.method(handPrototype!, 'setSamplePoints', async (next: typeof points) => {
      points = next
      return { status: 0, value: points }
    })
    t.mock.method(handPrototype!, 'setBaseId', async (next: number) => {
      if (failNextWrite) {
        failNextWrite = false
        return { status: 2 }
      }
      baseId = next
      return { status: 0, value: baseId }
    })
    const setting = (item: string, values?: string[]) =>
      session.request({ type: 'dex-hand-setting', deviceKey: hand.key, item, values })
    assert.equal(await setting('base-id'), '11')
    assert.equal(await setting('sample-points'), '75.0 87.5')
    assert.equal(await setting('sample-points', ['76.0', '88.0']), '76.0 88.0')
    assert.deepEqual(points, { nominal: 760, data: 880 })
    await assert.rejects(setting('base-id', ['12']), /failed to save/)
    assert.equal(devices().devices[0].key, hand.key)
    assert.deepEqual(joints().map((motor) => motor.motorId), dexHandJoints(11).map((motor) => motor.motorId))
    assert.equal(await setting('base-id', ['12']), '12')
    const [moved] = devices().devices
    assert.equal(session.state().selectedDevice, moved.key)
    assert.equal(moved.deviceId, 12)
    assert.deepEqual(joints().map((motor) => motor.motorId), dexHandJoints(12).map((motor) => motor.motorId))
    await session.request({ type: 'remove-device', deviceKey: moved.key })
    assert.deepEqual(devices().devices, [])
    assert.deepEqual(joints(), [])
    assert.equal(devices().motors.length, 8)
    await add(11)
    assert.equal(joints().length, 20)
  } finally {
    await session.dispose()
  }
})
