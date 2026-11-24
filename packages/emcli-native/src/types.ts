// SPDX-License-Identifier: MIT
//
// @encos/emcli-native 公共 TypeScript 类型。
// 这些类型是设计契约；与 native/include/emcli_perf_abi.h 保持一一对应。

/** 平台包后缀，与 @encos/encos-driver-native 的命名规则一致。 */
export type PlatformSuffix = 'linux-x64-gnu' | 'linux-arm64-gnu' | 'win32-x64'

/** 一个已由驱动侧创建并扫描到的电机地址。 */
export interface MotorAddress {
  /** 适配器类型，例如 "Can" / "Ethercat"。 */
  adapterType: string
  /** 适配器接口名，例如 "can0" / "eth0"。 */
  interfaceName: string
  /** EtherCAT 从站号；CAN 等无此概念时省略。 */
  slaveId?: number
  /** 总线号。 */
  busId: number
  /** 总线上的电机 ID。 */
  motorId: number
  /** 该电机是否使用 CAN FD。 */
  canfd?: boolean
}

/** 引擎事件（非致命诊断）。 */
export interface NativeEvent {
  timeNs: number
  level: 'debug' | 'info' | 'warn' | 'error'
  code: number
  message: string
}

/** 单个电机的遥测快照。 */
export interface MotorSnapshot {
  adapterIndex: number
  slaveId: number | null
  busId: number
  motorId: number
  errorCode: number
  online: boolean
  busy: boolean
  logging: boolean
  holding: boolean
  hasStatus: boolean
  sent: number
  received: number
  lost: number
  positionRad: number
  speedRadPerSec: number
  currentA: number
  torqueNm: number
  motorTemperatureC: number
  mosTemperatureC: number
  lastSampleUs: number
}

export interface BenchOptions {
  /** 待测电机；必须已经由驱动侧创建并完成扫描。 */
  motors: MotorAddress[]
  /** 测试档位，默认 [10, 5, 3, 2, 1]。 */
  periodsMs?: number[]
  /** 每档尝试次数，默认 500。 */
  attempts?: number
  /** 采样间隔基数，默认 5 ms。 */
  sampleGapMs?: number
  /** 附加均匀随机抖动上限，默认 1000 µs。 */
  sampleJitterUs?: number
  /** 每档预热，默认 200 ms。 */
  warmupMs?: number
  /** 丢包阈值：尝试数低于该值时的绝对丢包上限，默认 50。 */
  minPacketThreshold?: number
  /** 低于尝试数阈值时允许的丢包数，默认 5。 */
  maxDropCountBeforeThreshold?: number
  /** 达到尝试数阈值后允许的丢包率，默认 0.1。 */
  maxDropRateAfterThreshold?: number
  /** 是否尝试实时优先级，默认 true。 */
  realtime?: boolean
  /** 是否尝试 CPU 亲和，默认 true。 */
  cpuAffinity?: boolean
  /** 随机种子；0 表示随机，非 0 用于可复现测试。 */
  seed?: number
}

export interface BenchPeriodResult {
  periodMs: number
  state: 'pending' | 'warmup' | 'sampling' | 'done'
  stopReason: 'ok' | 'loss-limit' | 'interrupted' | 'error'
  attempts: number
  valid: number
  lost: number
  meanUs: number
  p1Us: number
  p5Us: number
  p50Us: number
  p95Us: number
  p99Us: number
  opsPerSecond: number
  errorPercent: number
}

export interface BenchUpdate {
  phase: 'idle' | 'running' | 'stopping' | 'finished' | 'error'
  currentPeriod: number
  periods: BenchPeriodResult[]
  motors: MotorSnapshot[]
  elapsedSeconds: number
  events: NativeEvent[]
}

export interface BenchResult {
  phase: 'finished' | 'error'
  periods: BenchPeriodResult[]
  errorMessage?: string
}

export interface BenchSession {
  readonly id: number
  start(): void
  poll(): BenchUpdate
  stop(drainMs?: number): BenchResult
  dispose(): void
  [Symbol.dispose](): void
}

export interface BenchApi {
  create(options: BenchOptions): BenchSession
}

export interface StressOptions {
  motors: MotorAddress[]
  /** 发送周期，默认 1 ms。 */
  loopPeriodMs?: number
  /** 预热，默认 100 ms。 */
  warmupDelayMs?: number
  /** 停止后的 drain 等待，默认 200 ms。 */
  drainDelayMs?: number
  realtime?: boolean
  cpuAffinity?: boolean
}

export interface StressUpdate {
  phase: 'idle' | 'running' | 'stopping' | 'finished' | 'error'
  motors: MotorSnapshot[]
  elapsedSeconds: number
  configuredPeriodMs: number
  measuredPeriodP50Ms: number
  sent: number
  received: number
  lost: number
  loopOverruns: number
  events: NativeEvent[]
}

export interface StressResult {
  phase: 'finished' | 'error'
  sent: number
  received: number
  lost: number
  drainReceived: number
  errorMessage?: string
}

export interface StressSession {
  readonly id: number
  start(): void
  poll(): StressUpdate
  stop(drainMs?: number): StressResult
  dispose(): void
  [Symbol.dispose](): void
}

export interface StressApi {
  create(options: StressOptions): StressSession
}

/** 轨迹数据：timesSec 严格递增，positionsDeg 行优先 [sample][motor]。 */
export interface PlayTrajectory {
  timesSec: Float64Array
  positionsDeg: Float32Array
  sampleCount: number
  motorCount: number
}

export interface PlayOptions {
  /** 轨迹列对应的电机，顺序必须与 CSV 表头一致。 */
  motors: MotorAddress[]
  trajectory: PlayTrajectory
  /** 同总线但不参与轨迹、需要在播放期间保持位置的电机。 */
  holdingMotors?: MotorAddress[]
  /** 与 holdingMotors 对应；null 表示启动时读取当前位置。 */
  holdingPositionsRad?: Array<number | null>
  /** 控制周期，默认 1000 µs。 */
  controlPeriodUs?: number
  mode?: 'pvt' | 'pos'
  kp?: number
  kd?: number
  velocity?: number
  torque?: number
  maxSpeedRadPerSec?: number
  maxCurrentA?: number
  endless?: boolean
  returnToInitial?: boolean
  startupTransitionMs?: number
  returnTransitionMs?: number
  log?: { enabled?: boolean; directory?: string }
}

export interface PlayUpdate {
  phase: 'idle' | 'startup' | 'running' | 'paused' | 'returning' | 'finished' | 'error'
  motors: MotorSnapshot[]
  currentSample: number
  elapsedSeconds: number
  durationSeconds: number
  controlPeriodUs: number
  logging: boolean
  endless: boolean
  lastOverrunUs: number
  maxOverrunUs: number
  sent: number
  received: number
  lost: number
  loopOverruns: number
  events: NativeEvent[]
}

export interface PlayResult {
  phase: 'finished' | 'error'
  sent: number
  received: number
  elapsedSeconds: number
  errorMessage?: string
}

export interface PlaySession {
  readonly id: number
  start(): void
  pause(): void
  resume(): void
  setLogging(enabled: boolean): void
  poll(): PlayUpdate
  stop(drainMs?: number): PlayResult
  dispose(): void
  [Symbol.dispose](): void
}

export interface PlayApi {
  create(options: PlayOptions): PlaySession
}

/** 平台包 native/manifest.json 的结构。 */
export interface PlatformManifest {
  schema: number
  package: string
  version: string
  nativeAbi: number
  napi: number
  driverVersion: string
  driverSoname: string
  compiler: string
  glibcBaseline?: string
  files: Record<string, { sha256: string; mode?: string }>
}

export interface DriverPaths {
  /** 驱动平台包根目录。 */
  packageRoot: string
  /** 驱动版本（平台包 package.json 的 version）。 */
  version: string
  /** 驱动动态库绝对路径。 */
  libPath: string
  /** 插件目录；不存在时为空字符串。 */
  pluginPath: string
  /** 驱动 addon 路径（native/encosdriver.node）。 */
  addonPath: string
}

export interface NativePaths {
  /** @encos/emcli-native 包根。 */
  packageRoot: string
  loaderPath: string
  enginePath: string
  manifest: PlatformManifest
  driver: DriverPaths
}

export interface ResolveOptions {
  /** SEA 释放目录；提供后从 <nativeRoot>/perf 与 <nativeRoot>/driver 读取。 */
  nativeRoot?: string
  /** 显式驱动平台包根目录。 */
  driverPackageRoot?: string
  /** 显式驱动动态库路径。 */
  driverLibPath?: string
  /** 显式插件目录。 */
  pluginPath?: string
  platform?: NodeJS.Platform
  arch?: string
  /** 允许驱动版本与构建版本不同（仅开发用）。 */
  allowDriverVersionMismatch?: boolean
  /** 是否校验平台包 manifest 中声明的 SHA-256；默认 false（load 时默认 true）。 */
  verifyIntegrity?: boolean
}

export interface LoadOptions extends ResolveOptions {
  /** 诊断日志回调。 */
  logger?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void
}
