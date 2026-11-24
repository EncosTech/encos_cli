// SPDX-FileCopyrightText: 2026 Encos
// SPDX-License-Identifier: MIT

import type { BusWrapper, Runtime } from '@encos/encos-driver-native'
import type { Setting } from './catalog.js'
import { parseDeviceId } from './devices.js'

const fingers = ['Thumb', 'Index', 'Middle', 'Ring', 'Little']
const fingerCount = fingers.length
const jointsPerFinger = 4
const slotsPerGroup = 7

export function dexHandJoints(baseId: number) {
  return Array.from({ length: fingerCount * jointsPerFinger }, (_, index) => {
    const physicalId = baseId + Math.floor(index / slotsPerGroup)
    const subId = (index % slotsPerGroup) + 1
    const finger = index % fingerCount
    const joint = Math.floor(index / fingerCount)
    return {
      motorId: physicalId | (subId << 29),
      jointLabel: `${fingers[finger]} ${joint + 1}`,
      jointDisplayOrder: finger * jointsPerFinger + joint,
    }
  })
}

export const DEX_HAND_SETTINGS: Setting[] = [
  { id: 'base-id', label: 'Base ID', fields: ['ID'] },
  { id: 'sample-points', label: 'Sample points', fields: ['Arbitration', 'Data'], unit: '%' },
]

export function parseDexHandSetting(item: string, values: string[]) {
  if (item === 'base-id' && values.length === 1)
    return { item, baseId: parseDeviceId(values[0], 'dexhand') } as const
  if (item === 'sample-points' && values.length === 2) {
    const points = values.map((value) =>
      /^\d+(?:\.\d)?$/.test(value.trim()) ? Number(value) : NaN,
    )
    if (points.every((point) => Number.isFinite(point) && point >= 0 && point <= 100))
      return {
        item,
        points: { nominal: Math.round(points[0] * 10), data: Math.round(points[1] * 10) },
      } as const
  }
  throw new Error('Enter a base ID or two sample points from 0 to 100% with up to one decimal place')
}

export type DexHandSamplePoints = { nominal: number; data: number }
type Reply<T> = { status: number; value?: T }

// The new management API is optional when using an older native driver for ordinary motors.
export interface DexHandHandle {
  getBaseId(): Promise<Reply<number>>
  setBaseId(id: number): Promise<Reply<number>>
  getSamplePoints(): Promise<Reply<DexHandSamplePoints>>
  setSamplePoints(points: DexHandSamplePoints): Promise<Reply<DexHandSamplePoints>>
}

export function createDexHand(bus: BusWrapper, runtime: Runtime, baseId: number) {
  const getDexHand = (bus as BusWrapper & { getDexHand?: (id: number) => DexHandHandle }).getDexHand
  const deleteDexHand = (runtime as Runtime & { deleteDexHand?: (hand: DexHandHandle) => boolean })
    .deleteDexHand
  if (!getDexHand || !deleteDexHand)
    throw new Error('DexHand requires the native driver with DexHand management support')
  return {
    handle: getDexHand.call(bus, baseId),
    remove: (handle: DexHandHandle) => deleteDexHand.call(runtime, handle),
  }
}

export function dexHandValue<T>({ status, value }: Reply<T>): T {
  if (status === 0 && value !== undefined) return value
  const errors = [
    'Missing value in DexHand response',
    'DexHand rejected the parameters',
    'DexHand failed to save the settings',
    'DexHand firmware update in progress',
    'DexHand request timed out',
    'DexHand request canceled',
    'DexHand has a pending request',
  ]
  throw new Error(errors[status] ?? `Unexpected DexHand status ${status}`)
}

export function formatDexHandPoints({ nominal, data }: DexHandSamplePoints) {
  return `${(nominal / 10).toFixed(1)} ${(data / 10).toFixed(1)}`
}
