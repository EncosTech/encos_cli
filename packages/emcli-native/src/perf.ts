// SPDX-FileCopyrightText: 2026 Encos
// SPDX-License-Identifier: MIT
//
// @encos/emcli-native 的本地性能模块入口。
//
// 该模块要求调用方先初始化 @encos/encos-driver-native：addon 的 DT_NEEDED
// 只有 libencosdriver 的 SONAME，加载时复用进程内已存在的驱动实例。

import { existsSync } from 'node:fs'
import { Module } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { EmcliNativeError } from './errors.js'
import type { MotorAddress } from './types.js'

export interface NativeScanOptions {
  timing?:Partial<Record<'bitrate'|'dbitrate'|'sample_point'|'dsample_point',number>>
  type: string
  interfaceName: string
  slaveId?: number
  busId?: number
}

export interface NativeScanRow {
  slaveId: number | null
  busId: number
  motorId: number
  eff: boolean
  canfd: boolean
}

export interface NativeBenchOptions {
  timing?:Partial<Record<'bitrate'|'dbitrate'|'sample_point'|'dsample_point',number>>
  motors: MotorAddress[]
  periodMs: number
  attempts: number
  warmupMs?: number
  sampleGapMs?: number
  jitterUs?: number
}

export interface NativeBenchResult {
  samples: number[]
  lost: number
  attempts: number
  error: string
  /** 可执行参数探测的普通电机数，0 表示仅施加控制负载。 */
  probeMotorCount?: number
}

export interface NativeStressOptions {
  timing?:Partial<Record<'bitrate'|'dbitrate'|'sample_point'|'dsample_point',number>>
  motors: MotorAddress[]
  periodMs: number
}

export interface NativeStressMotor {
  slaveId: number | null
  busId: number
  motorId: number
  sent: number
  received: number
}

export interface NativeStressUpdate {
  sent: number
  received: number
  periodMs?: number
  elapsedMs: number
  measurementMs: number
  drainMs: number
  drainAdditional: number
  outstandingBefore: number
  outstandingAfter: number
  motors: NativeStressMotor[]
  error: string
  final: boolean
}

export interface NativeStressSession {
  start(): void
  poll(): NativeStressUpdate
  stop(drainMs?: number): NativeStressUpdate
  dispose(): void
  [Symbol.dispose](): void
}

export interface NativePlayMotor extends MotorAddress {
  trajectoryIndex?: number
  holding?: boolean
}

export interface NativePlayOptions {
  timing?:Partial<Record<'bitrate'|'dbitrate'|'sample_point'|'dsample_point',number>>
  motors: NativePlayMotor[]
  times: number[]
  positions: number[]
  motorCount: number
  periodMs: number
  startupMs?: number
  returnMs?: number
  endless?: boolean
  returnToInitial?: boolean
  usePvt?: boolean
  kp?: number
  kd?: number
  velocity?: number
  torque?: number
  maxSpeed?: number
  maxCurrent?: number
}

export interface NativePlayMotorUpdate {
  feedbackPosition?: number|null
  speed?:number|null
  current?:number|null
  torque?:number|null
  motorTemperature?:number|null
  mosTemperature?:number|null
  motorError?:number|null
  slaveId: number | null
  busId: number
  motorId: number
  sent: number
  received: number
  positionRad: number
  holding: boolean
}

export interface NativePlayUpdate {
  paused?:boolean
  phase: number
  elapsedMs: number
  sent: number
  received: number
  motors: NativePlayMotorUpdate[]
  error: string
  final: boolean
}

export interface NativePlaySession {
  requestReturn():void
  pause(paused:boolean):void
  start(): void
  poll(): NativePlayUpdate
  stop(): NativePlayUpdate
  dispose(): void
  [Symbol.dispose](): void
}

export interface EmcliNativeInfo {
  version: string
  addonPath: string
  abi: number
}

export interface EmcliNativeApi {
  slave(args: string[], execute?: boolean, timeoutMs?: number): {
    handled: boolean
    code?: number
    replies?: string[]
    commands?: string[]
    serial?: boolean
    endpoint?: string
    download?: string
  }

  scanSlaves(options:NativeScanOptions):Array<{index:number;uuid:string}>
  motorLog(motors:NativePlayMotor[],directory?:string):void
  readonly info: EmcliNativeInfo
  scan(options: NativeScanOptions): NativeScanRow[]
  bench(options: NativeBenchOptions): NativeBenchResult
  stress(options: NativeStressOptions): NativeStressSession
  play(options: NativePlayOptions): NativePlaySession
  dispose(): void
}

interface NativeAddon {
  slave(config:string):string
  scanSlaves(config:string):string
  motorLog(config:string):void
  scan(configJson: string): string
  stressStart(configJson: string): void
  stressPoll(): string
  stressStop(drainMs: number): string
  bench(configJson: string): string
  playStart(configJson: string): void
  playRequestReturn():void
  playPause(paused:boolean):void
  playPoll(): string
  playStop(): string
}

export interface LoadEmcliNativeOptions {
  /** 显式指定 emcli_perf.node；默认查找包内 build/native 目录。 */
  addonPath?: string
}

function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..')
}

function addonCandidates(options: LoadEmcliNativeOptions): string[] {
  const candidates: string[] = []
  if (options.addonPath !== undefined) candidates.push(resolve(options.addonPath))
  if (process.env.EMCLI_PERF_ADDON !== undefined && process.env.EMCLI_PERF_ADDON !== '') {
    candidates.push(resolve(process.env.EMCLI_PERF_ADDON))
  }
  const root = packageRoot()
  candidates.push(join(root, 'build', 'emcli_perf.node'))
  candidates.push(join(root, 'native', 'emcli_perf.node'))
  candidates.push(join(process.cwd(), 'packages', 'emcli-native', 'build', 'emcli_perf.node'))
  return [...new Set(candidates)]
}

let cachedAddon: { path: string; addon: NativeAddon } | undefined

function loadAddon(options: LoadEmcliNativeOptions): { path: string; addon: NativeAddon } {
  if (cachedAddon !== undefined) return cachedAddon
  let lastError: unknown
  for (const path of addonCandidates(options)) {
    if (!existsSync(path)) continue
    try {
      const module = new Module(path)
      process.dlopen(module, path)
      const addon = module.exports as Partial<NativeAddon>
      for (const name of [
        'scan',
        'stressStart',
        'stressPoll',
        'stressStop',
        'bench',
        'playStart',
        'playPoll',
        'playStop',
        'playRequestReturn',
        'slave',
        'scanSlaves',
        'motorLog',
      ] as const) {
        if (typeof addon[name] !== 'function') {
          throw new Error(`native addon is missing ${name}()`)
        }
      }
      cachedAddon = { path, addon: addon as NativeAddon }
      return cachedAddon
    } catch (error) {
      lastError = error
    }
  }
  throw new EmcliNativeError(
    'EMCLI_ENGINE_LIB_MISSING',
    '未找到可用的 emcli 原生性能模块 emcli_perf.node。',
    {
      detail:
        '请先构建：pnpm build:perf\n' +
        '或设置 EMCLI_PERF_ADDON 指向已构建的 .node。\n' +
        'bench/stress/scan/play 不再提供 JS 回退实现。',
      cause: lastError,
    },
  )
}

class StressSession implements NativeStressSession {
  #started = false
  #stopped = false
  #last: NativeStressUpdate | undefined

  constructor(
    private readonly addon: NativeAddon,
    private readonly options: NativeStressOptions,
  ) {}

  start(): void {
    if (this.#started) throw new EmcliNativeError('EMCLI_INVALID_STATE', 'stress session already started')
    this.addon.stressStart(
      JSON.stringify({
        periodMs: this.options.periodMs,
        timing:this.options.timing,
        motors: this.options.motors.map(motor => ({
          type: motor.adapterType,
          interfaceName: motor.interfaceName,
          slaveId: motor.slaveId ?? null,
          busId: motor.busId,
          motorId: motor.motorId,
        })),
      }),
    )
    this.#started = true
  }

  poll(): NativeStressUpdate {
    if (!this.#started) throw new EmcliNativeError('EMCLI_INVALID_STATE', 'stress session not started')
    return JSON.parse(this.addon.stressPoll()) as NativeStressUpdate
  }

  stop(drainMs = 0): NativeStressUpdate {
    if (!this.#started) throw new EmcliNativeError('EMCLI_INVALID_STATE', 'stress session not started')
    if (this.#stopped && this.#last !== undefined) return this.#last
    const result = JSON.parse(this.addon.stressStop(drainMs)) as NativeStressUpdate
    this.#stopped = true
    this.#last = result
    return result
  }

  dispose(): void {
    if (this.#started && !this.#stopped) {
      try {
        this.stop()
      } catch {
        // 清理路径继续。
      }
    }
  }

  [Symbol.dispose](): void {
    this.dispose()
  }
}

class PlaySession implements NativePlaySession {
  #started = false
  #stopped = false
  #last: NativePlayUpdate | undefined

  constructor(
    private readonly addon: NativeAddon,
    private readonly options: NativePlayOptions,
  ) {}

  start(): void {
    if (this.#started) throw new EmcliNativeError('EMCLI_INVALID_STATE', 'play session already started')
    this.addon.playStart(
      JSON.stringify({
        periodMs: this.options.periodMs,
        timing:this.options.timing,
        startupMs: this.options.startupMs ?? 2000,
        returnMs: this.options.returnMs ?? 2000,
        endless: this.options.endless ?? false,
        returnToInitial: this.options.returnToInitial ?? true,
        usePvt: this.options.usePvt ?? true,
        kp: this.options.kp ?? 0,
        kd: this.options.kd ?? 1,
        velocity: this.options.velocity ?? 0,
        torque: this.options.torque ?? 0,
        maxSpeed: this.options.maxSpeed ?? 20,
        maxCurrent: this.options.maxCurrent ?? 10,
        times: this.options.times,
        positions: this.options.positions,
        motorCount: this.options.motorCount,
        motors: this.options.motors.map(motor => ({
          type: motor.adapterType,
          interfaceName: motor.interfaceName,
          slaveId: motor.slaveId ?? null,
          busId: motor.busId,
          motorId: motor.motorId,
          trajectoryIndex: motor.trajectoryIndex ?? -1,
          holding: motor.holding ?? false,
        })),
      }),
    )
    this.#started = true
  }

  requestReturn():void {
    if(!this.#started||this.#stopped)throw new Error('Play is not running')
    this.addon.playRequestReturn()
  }

  pause(paused:boolean):void {
    if(!this.#started||this.#stopped)throw new Error('Play is not running')
    this.addon.playPause(paused)
  }

  poll(): NativePlayUpdate {
    if (!this.#started) throw new EmcliNativeError('EMCLI_INVALID_STATE', 'play session not started')
    return JSON.parse(this.addon.playPoll()) as NativePlayUpdate
  }

  stop(): NativePlayUpdate {
    if (!this.#started) throw new EmcliNativeError('EMCLI_INVALID_STATE', 'play session not started')
    if (this.#stopped && this.#last !== undefined) return this.#last
    const result = JSON.parse(this.addon.playStop()) as NativePlayUpdate
    this.#stopped = true
    this.#last = result
    return result
  }

  dispose(): void {
    if (this.#started && !this.#stopped) {
      try {
        this.stop()
      } catch {
        // 清理路径继续。
      }
    }
  }

  [Symbol.dispose](): void {
    this.dispose()
  }
}

export function loadEmcliNative(options: LoadEmcliNativeOptions = {}): EmcliNativeApi {
  const { path, addon } = loadAddon(options)
  return {
    info: { version: '0.1.0', addonPath: path, abi: 1 },
    slave(args, execute = true, timeoutMs = 3000) {
      return JSON.parse(addon.slave(JSON.stringify({ args, execute, timeoutMs })))
    },

    scanSlaves(options){return JSON.parse(addon.scanSlaves(JSON.stringify(options)))},
    motorLog(motors,directory){addon.motorLog(JSON.stringify({directory:directory??'',motors:motors.map(m=>({...m,type:m.adapterType}))}))},
    scan(scanOptions) {
      const config: Record<string, unknown> = {
        type: scanOptions.type,
        timing:scanOptions.timing,
        interfaceName: scanOptions.interfaceName,
      }
      if (scanOptions.slaveId !== undefined) config.slaveId = scanOptions.slaveId
      if (scanOptions.busId !== undefined) config.busId = scanOptions.busId
      return JSON.parse(addon.scan(JSON.stringify(config))) as NativeScanRow[]
    },
    bench(benchOptions) {
      const result = JSON.parse(
        addon.bench(
          JSON.stringify({
            periodMs: benchOptions.periodMs,
            timing:benchOptions.timing,
            attempts: benchOptions.attempts,
            warmupMs: benchOptions.warmupMs ?? 200,
            sampleGapMs: benchOptions.sampleGapMs ?? 5,
            jitterUs: benchOptions.jitterUs ?? 1000,
            motors: benchOptions.motors.map(motor => ({
              type: motor.adapterType,
              interfaceName: motor.interfaceName,
              slaveId: motor.slaveId ?? null,
              busId: motor.busId,
              motorId: motor.motorId,
            })),
          }),
        ),
      ) as NativeBenchResult
      return result
    },
    stress(stressOptions) {
      return new StressSession(addon, stressOptions)
    },
    play(playOptions) {
      return new PlaySession(addon, playOptions)
    },
    dispose() {
      // addon 没有进程级资源需要释放；stress session 由调用方 stop。
    },
  }
}
