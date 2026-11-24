// SPDX-License-Identifier: MIT

export enum StatisticsStatus {
  Pending = 'pending',
  Valid = 'valid',
  Stale = 'stale',
}

export enum ErrorCounterKind {
  Current = 'current',
  LastErrorEvent = 'last-error-event',
}

/** Transport contract mirrors driver 4.2; absent counters never mean zero. */
export interface CanErrorCounters {
  tx: number
  rx: number

  kind: ErrorCounterKind
}

export interface BusStatistics {
  slaveId: number
  busId: number

  status: StatisticsStatus
  ageMs?: number

  errorCounters?: CanErrorCounters
}

export interface AdapterStatistics {
  buses: BusStatistics[]
}

export function supportsStatistics(type: string) {
  return ['ethernet', 'enet', 'can', 'socketcan', 'gsusb'].includes(type.toLowerCase())
}

export function statisticsRows(snapshot: AdapterStatistics) {
  return snapshot.buses.map((bus) => ({
    key: `${bus.slaveId}:${bus.busId}`,
    slave: bus.slaveId,
    bus: bus.busId,
    status: bus.status,
    age: bus.ageMs ?? '-',
    kind: bus.errorCounters
      ? bus.errorCounters.kind === ErrorCounterKind.Current
        ? 'Current'
        : 'Last error event'
      : '-',
    tx: bus.errorCounters?.tx ?? '-',
    rx: bus.errorCounters?.rx ?? '-',
  }))
}

export function readAdapterStatistics(adapter: {
  getStatistics?: () => AdapterStatistics | null
}): AdapterStatistics | null {
  return adapter.getStatistics?.() ?? null
}
