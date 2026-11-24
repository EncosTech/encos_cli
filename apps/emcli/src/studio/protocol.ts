// SPDX-FileCopyrightText: 2026 Encos
// SPDX-License-Identifier: MIT

import type {
  ImuStatusResult,
  BatteryStatusResult,
  BatteryPassiveCommands,
  PmsStatus,
  GloveStatus,
} from '@encos/encos-driver-native'
import type { AdapterTiming } from '../runtime-options.js'

export type { AdapterTiming } from '../runtime-options.js'

import type { NativePlayUpdate, NativeStressUpdate } from '@encos/emcli-native'
import type { BenchSummary } from '../stats.js'

export interface TestScope {
  adapterKey: string
  slaveId?: number | null
  busId?: number
  dexHandKey?: string
}

export type PerformanceUpdate = { scope: TestScope; running: boolean; error?: string } & (
  | {
      kind: 'bench'
      rows: Array<
        BenchSummary & { periodMs: number; attempts: number; lost: number; status: string }
      >
    }
  | { kind: 'stress'; snapshot: NativeStressUpdate }
)

export interface ControlCommand {
  mode: ControlMode
  values: number[]
  stopMode?: 'full' | 'dynamic' | 'regenerative'
}

export type ControlMode = 'pvt' | 'position' | 'speed' | 'current' | 'torque' | 'stop'

export type GraphMetric = 'position' | 'speed' | 'current' | 'power'

export type DeviceKind = 'motor' | 'imu' | 'battery' | 'pms' | 'glove' | 'dexhand'

export interface DeviceAddress {
  key: string
  adapterKey: string
  slaveId: number | null
  busId: number | null
  deviceId: number
  kind: Exclude<DeviceKind, 'motor'>
  origin: 'manual' | 'scan'
}

export interface MotorAddress {
  key: string
  adapterKey: string
  slaveId: number | null
  busId: number
  motorId: number
  canfd: boolean
  eff: boolean
  dexHandKey?: string
  jointLabel?: string
  jointDisplayOrder?: number
  origin?: 'manual' | 'scan'
  properties?: import('@encos/encos-driver-native').MotorProperties
}

export interface AdapterInfo {
  key: string
  type: string
  interfaceName: string
  buses: Array<{ slaveId: number | null; busId: number }>
  motors: MotorAddress[]
  devices: DeviceAddress[]
  timing?: AdapterTiming
  busTiming?: Record<string, AdapterTiming>
}

export type StudioView = 'single' | 'batch' | 'play' | 'adapter-config'

export interface PlayConfig {
  logDirectory?: string
  dryRun?: boolean
  path: string
  timing?: AdapterTiming
  endless: boolean
  frequency: number
  maxSpeed: number
  maxCurrent: number
}

export interface PlayState {
  adapters?: AdapterInfo[]
  config: PlayConfig
  motors: MotorAddress[]
  phase: string
  snapshot?: NativePlayUpdate
  window?: Array<{ sent: number; received: number }>
  logging: boolean
  logPath?: string
}

export interface FileListing {
  path: string
  parent: string
  entries: Array<{ name: string; path: string; directory: boolean }>
}

export interface SessionState {
  adapterConfig?: import('./adapter-config.js').AdapterConfigState
  play?: PlayState
  view?: StudioView
  batchKeys?: string[]
  batchCommand?: ControlCommand
  adapters: AdapterInfo[]
  selected?: string
  selectedDevice?: string
  control?: ControlMode
  controlCommand?: ControlCommand
  graph: GraphMetric[]
}

export interface Telemetry {
  motorKey: string
  timestamp: number
  position?: number
  speed?: number
  current?: number
  power?: number
  motorTemperature?: number
  mosTemperature?: number
  error?: number
}

export type Request = (
  | { type: 'interfaces' }
  | { type: 'serial-ports' }
  | { type: 'adapter-statistics'; adapterKey: string }
  | { type: 'adapter-config-open'; port: string }
  | { type: 'adapter-config-close' }
  | {
      type: 'adapter-config-command'
      item: import('./adapter-config.js').AdapterConfigItem
      value?: string
    }
  | { type: 'files'; path: string; extensions?: string[] }
  | { type: 'play-load'; config: PlayConfig }
  | { type: 'play-start' | 'play-pause' | 'play-stop' | 'play-log' }
  | { type: 'view'; view: StudioView }
  | { type: 'batch-selection'; motorKeys: string[] }
  | { type: 'batch-control'; command: ControlCommand }
  | { type: 'batch-disable' }
  | { type: 'batch-brake'; engaged: boolean }
  | { type: 'batch-write'; item: string; values: string[] }
  | { type: 'bench'; scope: TestScope; motorKeys?: string[] }
  | { type: 'stress-start'; scope: TestScope; motorKeys?: string[]; frequencyHz?: number }
  | { type: 'stress-stop' }
  | { type: 'add'; adapterType: string; interfaceName: string; timing?: AdapterTiming }
  | {
      type: 'add-device'
      kind: Exclude<DeviceKind, 'glove'>
      adapterKey: string
      slaveId: number | null
      busId: number
      deviceId: number
    }
  | { type: 'add-glove'; adapterKey: string; slaveId: number }
  | { type: 'device-action'; deviceKey: string; action: DeviceAction }
  | { type: 'dex-hand-setting'; deviceKey: string; item: string; values?: string[] }
  | {
      type: 'bus-timing'
      adapterKey: string
      slaveId: number | null
      busId: number
      timing: AdapterTiming
    }
  | { type: 'remove-device'; deviceKey: string }
  | { type: 'scan'; adapterKey?: string; busId?: number; slaveId?: number }
  | { type: 'remove'; adapterKey: string }
  | { type: 'select'; motorKey?: string; deviceKey?: string }
  | {
      type: 'control'
      mode: ControlMode
      values: number[]
      stopMode?: 'full' | 'dynamic' | 'regenerative'
    }
  | { type: 'disable' }
  | { type: 'brake'; engaged: boolean }
  | { type: 'read'; item: string }
  | { type: 'ranges' }
  | { type: 'write'; item: string; values: string[] }
  | { type: 'graph'; metrics: GraphMetric[] }
  | { type: 'graph-active'; active: boolean }
  | { type: 'canfd'; enabled: boolean; motorKey?: string }
  | { type: 'shutdown' }
) & { expectedMotor?: string; expectedView?: StudioView }

export interface RequestMessage {
  id: number
  request: Request
}

export type DeviceAction =
  | { kind: 'imu'; operation: 'start' | 'stop' }
  | { kind: 'battery'; operation: 'clear' | 'charge' | 'discharge'; enabled?: boolean }
  | { kind: 'battery'; operation: 'commands'; commands: BatteryPassiveCommands }
  | { kind: 'pms'; operation: 'channels'; channels: number[]; enabled: boolean }
  | { kind: 'glove'; operation: 'all' }
  | { kind: 'glove'; operation: 'mask'; finger: number; mask: number }

export type DeviceSample = { deviceKey: string; timestamp: number } & (
  | { kind: 'imu'; status: ImuStatusResult }
  | { kind: 'battery'; status: BatteryStatusResult }
  | { kind: 'pms'; status: PmsStatus | undefined }
  | { kind: 'glove'; status: GloveStatus }
)

export type Event =
  | { type: 'play'; state: PlayState }
  | { type: 'performance'; update: PerformanceUpdate }
  | { type: 'device-status'; sample: DeviceSample }
  | { type: 'state'; state: SessionState }
  | { type: 'telemetry'; sample: Telemetry }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }

export type Reply =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: string }

export interface StudioClient {
  request<T = unknown>(request: Request): Promise<T>
  subscribe(listener: (event: Event) => void): () => void
  close(): Promise<void>
}

export interface Interfaces {
  version: string
  types: Array<{ type: string; interfaces: string[] }>
}

export const EMPTY_SESSION: SessionState = {
  adapters: [],
  graph: ['position', 'speed', 'current', 'power'],
}
