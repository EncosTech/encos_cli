// SPDX-FileCopyrightText: 2026 Encos
// SPDX-License-Identifier: MIT

import {jsonMode,jsonSample,setJsonResult} from '../json-output.js'

import {
  loadEmcliNative,
  type EmcliNativeApi,
  type NativeBenchResult,
} from '@encos/emcli-native'

import { flagInteger, flagNumberValue, rejectUnknownFlags, type ParsedArgs } from '../args.js'
import { formatFixed, formatPercent } from '../format.js'
import { adapterTiming, openRuntime, runtimeOptionsFromArgs } from '../runtime.js'
import { dropRate, summarizeSamples } from '../stats.js'
import { parseInteger, parseMotorTarget, type MotorTarget } from '../target.js'

const DEFAULT_PERIODS = [10, 5, 3, 2, 1]

interface BenchMotor {
  adapterType: string
  interfaceName: string
  slaveId?: number
  busId: number
  motorId: number
}

export async function runBench(args: ParsedArgs): Promise<number> {
  rejectUnknownFlags(args, [
    'sample-jitter-us',
    'min-packet-threshold',
    'max-drop-count-before-threshold',
    'max-drop-rate-after-threshold',
    'attempts',
    'warmup-ms',
    'periods',
  ])
  if (args.positionals.length === 0) {
    throw new Error('用法: emcli bench <Type:Id[:slave:bus:ALL|motor]...>')
  }
  const attempts = flagInteger(args, 'attempts') ?? 500
  const jitterUs = flagInteger(args, 'sample-jitter-us') ?? 1000
  const minPacketThreshold = flagInteger(args, 'min-packet-threshold') ?? 50
  const maxDropCount = flagInteger(args, 'max-drop-count-before-threshold') ?? 5
  const maxDropRate = flagNumberValue(args, 'max-drop-rate-after-threshold') ?? 0.1
  const warmupMs = flagInteger(args, 'warmup-ms') ?? 200
  const periods = parsePeriods(args)

  const runtime = await openRuntime(runtimeOptionsFromArgs(args))
  try {
    const native = loadEmcliNative()
    const motors = resolveMotors(native, runtime.getAvailableInterface.bind(runtime), args.positionals,adapterTiming(args))
    if(!jsonMode)console.log(
      '\n| Hz | period ms | mean us | P1 us | P5 us | P50 us | P95 us | P99 us | op/s | err% (MdAPE) | valid | lost/sent (rate) | status |',
    )
    if(!jsonMode)console.log(
      '|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|:---|',
    )
    const reports:unknown[]=[];setJsonResult({motors:motors.map(motor=>({...motor,slaveId:motor.slaveId??null})),reports})
    for (const periodMs of periods) {
      const result = native.bench({
        motors,
        timing:adapterTiming(args),
        periodMs,
        attempts,
        warmupMs,
        sampleGapMs: 5,
        jitterUs,
      })
      const lossLimited =
        (result.attempts < minPacketThreshold && result.lost > maxDropCount) ||
        (result.attempts >= minPacketThreshold &&
          dropRate(result.lost, result.attempts) > maxDropRate)
      const status = result.error ? 'error' : result.probeMotorCount === 0 ? 'no probes' : lossLimited ? 'loss limit' : 'ok'
      const report={periodMs,...summarizeSamples(result.samples),attempts:result.attempts,lost:result.lost,status,error:result.error||null}
      reports.push(report);if(jsonMode)jsonSample(report)
      if (result.error !== '') {
        console.error(`Error: ${result.error}`)
        if(!jsonMode)printResult(periodMs, result, status)
        return 1
      }
      if(!jsonMode)printResult(periodMs, result, status)
      if (lossLimited) return 1
    }
    return 0
  } finally {
    runtime.dispose()
  }
}

function parsePeriods(args: ParsedArgs): number[] {
  const raw = args.flags.get('periods')
  if (raw === undefined) return DEFAULT_PERIODS
  if (typeof raw !== 'string') throw new Error('--periods 需要逗号分隔的毫秒数')
  const periods = raw
    .split(',')
    .map(value => Number(value.trim()))
    .filter(value => Number.isFinite(value) && value > 0)
  if (periods.length === 0) throw new Error('--periods 至少需要一个正数')
  return periods
}

function resolveMotors(
  native: EmcliNativeApi,
  availableInterfaces: (type: string) => string[],
  links: string[],
  timing:ReturnType<typeof adapterTiming>,
): BenchMotor[] {
  const result: BenchMotor[] = []
  const seen = new Set<string>()
  const append = (motor: BenchMotor): void => {
    const key = `${motor.adapterType}:${motor.interfaceName}:${motor.slaveId}:${motor.busId}:${motor.motorId}`
    if (seen.has(key)) return
    seen.add(key)
    result.push(motor)
  }
  const scan = (type: string, interfaceName: string, slaveId?: number, busId?: number): void => {
    for (const row of native.scan({timing,
      type,
      interfaceName,
      ...(slaveId === undefined ? {} : { slaveId }),
      ...(busId === undefined ? {} : { busId }),
    })) {
      append({
        adapterType: type,
        interfaceName,
        ...(row.slaveId === null ? {} : { slaveId: row.slaveId }),
        busId: row.busId,
        motorId: row.motorId,
      })
    }
  }

  for (const link of links) {
    const target = parseBenchTarget(link)
    const interfaces =
      target.adapterId === 'ALL' ? availableInterfaces(target.adapterType) : [target.adapterId]
    for (const interfaceName of interfaces) {
      if (target.scope === 'motor' && target.motorId !== undefined && target.busId !== undefined) {
        append({
          adapterType: target.adapterType,
          interfaceName,
          ...(target.slaveId === undefined ? {} : { slaveId: target.slaveId }),
          busId: target.busId,
          motorId: target.motorId,
        })
      } else {
        scan(target.adapterType, interfaceName, target.slaveId, target.busId)
      }
    }
  }
  if (result.length === 0) throw new Error('没有匹配到电机')
  return result
}

function parseBenchTarget(value: string): MotorTarget {
  const parts = value.split(':')
  if (parts.length === 2) {
    return { adapterType: parts[0], adapterId: parts[1], scope: 'adapter' }
  }
  if (parts.length === 3) {
    if (parts[2] === 'ALL') {
      return { adapterType: parts[0], adapterId: parts[1], scope: 'adapter' }
    }
    return {
      adapterType: parts[0],
      adapterId: parts[1],
      scope: 'bus',
      busId: parseInteger(parts[2], 'BusId'),
    }
  }
  return parseMotorTarget(value)
}

function printResult(periodMs: number, result: NativeBenchResult, status: string): void {
  const summary = summarizeSamples(result.samples)
  const valid = result.samples.length
  const rate = dropRate(result.lost, result.attempts)
  const columns = [
    formatFixed(1000 / periodMs, 2),
    String(periodMs),
    valid === 0 ? '-' : formatFixed(summary.meanUs, 2),
    valid === 0 ? '-' : formatFixed(summary.p1Us, 2),
    valid === 0 ? '-' : formatFixed(summary.p5Us, 2),
    valid === 0 ? '-' : formatFixed(summary.p50Us, 2),
    valid === 0 ? '-' : formatFixed(summary.p95Us, 2),
    valid === 0 ? '-' : formatFixed(summary.p99Us, 2),
    valid === 0 ? '-' : formatFixed(summary.opsPerSecond, 2),
    valid === 0 ? '-' : formatFixed(summary.errorPercent, 2),
    String(valid),
    result.probeMotorCount === 0 ? '-' : `${result.lost}/${result.attempts} (${formatPercent(rate)})`,
    status,
  ]
  console.log(`| ${columns.join(' | ')} |`)
}
