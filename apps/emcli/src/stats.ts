// SPDX-License-Identifier: MIT

export function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return Number.NaN
  const index = fraction * (sorted.length - 1)
  const lower = Math.floor(index)
  const upper = Math.min(lower + 1, sorted.length - 1)
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower)
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((left, right) => left - right)
  return percentile(sorted, 0.5)
}

export interface BenchSummary {
  count: number
  meanUs: number
  p1Us: number
  p5Us: number
  p50Us: number
  p95Us: number
  p99Us: number
  opsPerSecond: number
  errorPercent: number
}

export function summarizeSamples(samplesUs: readonly number[]): BenchSummary {
  if (samplesUs.length === 0) {
    return {
      count: 0,
      meanUs: Number.NaN,
      p1Us: Number.NaN,
      p5Us: Number.NaN,
      p50Us: Number.NaN,
      p95Us: Number.NaN,
      p99Us: Number.NaN,
      opsPerSecond: Number.NaN,
      errorPercent: Number.NaN,
    }
  }
  const sorted = [...samplesUs].sort((left, right) => left - right)
  const p50 = percentile(sorted, 0.5)
  const deviations = sorted.map(value => Math.abs(value - p50) / value)
  return {
    count: sorted.length,
    meanUs: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    p1Us: percentile(sorted, 0.01),
    p5Us: percentile(sorted, 0.05),
    p50Us: p50,
    p95Us: percentile(sorted, 0.95),
    p99Us: percentile(sorted, 0.99),
    opsPerSecond: 1e6 / p50,
    errorPercent: 100 * median(deviations),
  }
}

export function dropRate(lost: number, attempts: number): number {
  return attempts === 0 ? 0 : lost / attempts
}
