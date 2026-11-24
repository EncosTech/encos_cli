// SPDX-License-Identifier: MIT
import { flagString, type ParsedArgs } from './args.js'

export interface OpenRuntimeOptions {
  pluginPath?: string
  packageRoot?: string
  logLevel?: number
}

export function runtimeOptionsFromArgs(args: ParsedArgs): OpenRuntimeOptions {
  const pluginPath = flagString(args, 'plugin-path') ?? process.env.ENCOS_PLUGIN_PATH
  return pluginPath === undefined || pluginPath === '' ? {} : { pluginPath }
}

export interface AdapterTiming {
  bitrate?: number
  dbitrate?: number
  sample_point?: number
  dsample_point?: number
}

export function adapterTiming(args: ParsedArgs): AdapterTiming {
  const timing: AdapterTiming = {}
  const integer = (field: keyof AdapterTiming, option: string): number | undefined => {
    const raw = flagString(args, option)
    if (raw === undefined) return undefined
    const value = Number(raw)
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`--${option} 必须是正整数 bit/s，收到 '${raw}'`)
    }
    return value
  }
  const ratio = (field: keyof AdapterTiming, option: string): number | undefined => {
    const raw = flagString(args, option)
    if (raw === undefined) return undefined
    const value = Number(raw)
    if (!Number.isFinite(value) || value <= 0 || value > 1) {
      throw new Error(`--${option} 必须是 (0, 1] 内的采样点，收到 '${raw}'`)
    }
    return value
  }
  const bitrate = integer('bitrate', 'bitrate')
  const dbitrate = integer('dbitrate', 'dbitrate')
  const samplePoint = ratio('sample_point', 'sample-point')
  const dSamplePoint = ratio('dsample_point', 'dsample-point')
  if (bitrate !== undefined) timing.bitrate = bitrate
  if (dbitrate !== undefined) timing.dbitrate = dbitrate
  if (samplePoint !== undefined) timing.sample_point = samplePoint
  if (dSamplePoint !== undefined) timing.dsample_point = dSamplePoint
  return timing
}

export function timingExtend(timing: AdapterTiming): Record<string, number | bigint> | undefined {
  if (Object.keys(timing).length === 0) return undefined

  const extend: Record<string, number | bigint> = { ...timing }

  // Native bindings encode Number as a JSON double and BigInt as a JSON integer.
  for (const key of ['bitrate', 'dbitrate'] as const) {
    const value = timing[key]

    if (value !== undefined) extend[key] = BigInt(value)
  }

  return extend
}
