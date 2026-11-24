// SPDX-License-Identifier: MIT
import { stripVTControlCharacters } from 'node:util'

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'unknown'
export interface LogInput {
  message: string
  timestamp?: number
  level?: LogLevel
  source?: string
  stream?: 'stdout' | 'stderr'
}
export interface LogEntry extends Readonly<LogInput> {
  readonly id: number
  readonly receivedAt: number
  readonly level: LogLevel
}
export interface LogStoreOptions { maxEntries?: number; flushIntervalMs?: number }
export interface LogStore {
  append(entry: LogInput): void
  appendMany(entries: readonly LogInput[]): void
  clear(): void
  dispose(): void
  getSnapshot(): readonly LogEntry[]
  subscribe(listener: () => void): () => void
}
export function cleanLogText(text: string): string {
  return stripVTControlCharacters(text).replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '').replace(/\t/g, '    ')
}
export function createLogStore({ maxEntries = 5000, flushIntervalMs = 50 }: LogStoreOptions = {}): LogStore {
  if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new RangeError('maxEntries must be a positive integer')
  if (!Number.isFinite(flushIntervalMs) || flushIntervalMs < 0) throw new RangeError('flushIntervalMs must be non-negative')
  let snapshot: readonly LogEntry[] = Object.freeze([])
  let pending: LogEntry[] = []
  let nextId = 1, disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const listeners = new Set<() => void>()
  const notify = () => { for (const listener of listeners) listener() }
  const flush = () => {
    timer = undefined
    if (!pending.length || disposed) return
    snapshot = Object.freeze([...snapshot, ...pending].slice(-maxEntries))
    pending = []
    notify()
  }
  const appendMany = (entries: readonly LogInput[]) => {
    if (disposed || !entries.length) return
    for (const entry of entries) {
      pending.push(Object.freeze({
        ...entry, id: nextId++, receivedAt: Date.now(), level: entry.level ?? 'unknown',
        message: cleanLogText(entry.message),
        source: entry.source === undefined ? undefined : cleanLogText(entry.source).replace(/\n/g, ' '),
      }))
      // Bound pending storage too, even if producers outpace the UI.
      if (pending.length >= maxEntries * 2) pending = pending.slice(-maxEntries)
    }
    if (pending.length > maxEntries) pending = pending.slice(-maxEntries)
    if (flushIntervalMs === 0) flush()
    else if (timer === undefined) { timer = setTimeout(flush, flushIntervalMs); timer.unref?.() }
  }
  const clear = () => {
    clearTimeout(timer); timer = undefined; pending = []
    snapshot = Object.freeze([]); notify()
  }
  return {
    append: entry => appendMany([entry]), appendMany,
    clear: () => { if (!disposed) clear() },
    dispose: () => { if (disposed) return; disposed = true; clear(); listeners.clear() },
    getSnapshot: () => snapshot,
    subscribe: listener => { if (!disposed) listeners.add(listener); return () => { listeners.delete(listener) } },
  }
}
