// SPDX-License-Identifier: MIT
export interface ChartPoint { timestamp: number; value: number }
export interface ChartSeries {
  id?: string
  label: string
  color: string
  yAxisId?: string
  data: readonly number[] | readonly ChartPoint[]
}
export interface ChartSeriesDefinition { id: string; label: string; color: string; yAxisId?: string }
export interface ChartSample extends ChartPoint { seriesId: string }
export interface ChartStoreOptions {
  series: readonly ChartSeriesDefinition[]
  retentionMs?: number
  maxPointsPerSeries?: number
  flushIntervalMs?: number
}
export interface ChartStore {
  append(seriesId: string, value: number, timestamp?: number): void
  appendMany(samples: readonly ChartSample[]): void
  clear(): void
  dispose(): void
  subscribe(listener: () => void): () => void
  getSnapshot(): readonly ChartSeries[]
}
export function createChartStore({series, retentionMs = 10000, maxPointsPerSeries = 10000, flushIntervalMs = 50}: ChartStoreOptions): ChartStore {
  if (!Number.isFinite(retentionMs) || retentionMs <= 0) throw new RangeError('retentionMs must be positive')
  if (!Number.isInteger(maxPointsPerSeries) || maxPointsPerSeries < 1) throw new RangeError('maxPointsPerSeries must be a positive integer')
  if (!Number.isFinite(flushIntervalMs) || flushIntervalMs < 0) throw new RangeError('flushIntervalMs must be non-negative')
  const definitions = series.map(item => ({...item}))
  if (new Set(definitions.map(item => item.id)).size !== definitions.length) throw new Error('Chart series IDs must be unique')
  const pending = new Map(definitions.map(item => [item.id, [] as ChartPoint[]]))
  let snapshot: readonly ChartSeries[] = Object.freeze(definitions.map(item => Object.freeze({...item, data: Object.freeze([])})))
  let disposed = false, timer: ReturnType<typeof setTimeout> | undefined
  const listeners = new Set<() => void>()
  const notify = () => { for (const listener of listeners) listener() }
  const flush = () => {
    timer = undefined
    const cutoff = Date.now() - retentionMs
    snapshot = Object.freeze(definitions.map((definition, index) => {
      const points = [...snapshot[index].data as readonly ChartPoint[], ...pending.get(definition.id)!]
        .filter(point => point.timestamp >= cutoff).sort((a,b) => a.timestamp - b.timestamp).slice(-maxPointsPerSeries)
      pending.set(definition.id, [])
      return Object.freeze({...definition, data: Object.freeze(points)})
    }))
    notify()
  }
  const appendMany = (samples: readonly ChartSample[]) => {
    if (disposed || !samples.length) return
    for (const sample of samples) if (!pending.has(sample.seriesId)) throw new Error(`Unknown chart series: ${sample.seriesId}`)
    for (const sample of samples) {
      const points = pending.get(sample.seriesId)!
      if (!Number.isFinite(sample.timestamp)) continue
      points.push(Object.freeze({timestamp: sample.timestamp, value: sample.value}))
      if (points.length >= maxPointsPerSeries * 2) pending.set(sample.seriesId, points.slice(-maxPointsPerSeries))
    }
    if (flushIntervalMs === 0) flush()
    else if (timer === undefined) { timer = setTimeout(flush, flushIntervalMs); timer.unref?.() }
  }
  const clear = () => {
    clearTimeout(timer); timer = undefined
    for (const key of pending.keys()) pending.set(key, [])
    snapshot = Object.freeze(definitions.map(item => Object.freeze({...item, data: Object.freeze([])})))
    notify()
  }
  return {
    append: (seriesId, value, timestamp = Date.now()) => appendMany([{seriesId,value,timestamp}]),
    appendMany, getSnapshot: () => snapshot,
    subscribe: listener => { if (!disposed) listeners.add(listener); return () => { listeners.delete(listener) } },
    clear: () => { if (!disposed) clear() },
    dispose: () => { if (disposed) return; disposed = true; clear(); listeners.clear() },
  }
}
