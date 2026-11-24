// SPDX-License-Identifier: MIT

const DEGREES_PER_RADIAN = 180 / Math.PI
const RADIANS_PER_DEGREE = Math.PI / 180

export function radiansToDegrees(radians: number): number {
  return radians * DEGREES_PER_RADIAN
}

export function degreesToRadians(degrees: number): number {
  return degrees * RADIANS_PER_DEGREE
}

export function formatFloat(value: number, digits = 6): string {
  if (!Number.isFinite(value)) return '-'
  return value.toFixed(digits).replace(/\.?0+$/, '') || '0'
}

export function formatFixed(value: number, digits: number): string {
  if (!Number.isFinite(value)) return '-'
  return value.toFixed(digits)
}

export function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`
}

export function formatMotorError(code: number): string {
  const names: Record<number, string> = {
    0: 'NoError',
    1: 'OverTemperature',
    2: 'OverCurrent',
    3: 'VoltageHigh',
    4: 'VoltageLow',
    5: 'EncoderError',
    6: 'BrakeVoltageHigh',
    7: 'DriverError',
    8: 'OverTemperatureWarning',
    9: 'OutputEncoderError',
    10: 'FetOverTemperature',
    11: 'OverSpeed',
    12: 'TemperatureWarning',
    255: 'NoResponse',
  }
  return names[code] ?? `Error(${code})`
}

export function printTable(headers: readonly string[], rows: readonly (readonly string[])[]): void {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map(row => (row[column] ?? '').length)),
  )
  const line = (cells: readonly string[]): string =>
    cells.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join('  ')
  console.log(line(headers))
  console.log(widths.map(width => '-'.repeat(width)).join('  '))
  for (const row of rows) {
    console.log(line(headers.map((_, column) => row[column] ?? '')))
  }
}

export function clearScreen(): void {
  process.stdout.write('\x1b[H\x1b[2J')
}

export function formatEvent(status: {
  error: number
  position: number
  speed: number
  current: number
  motorTemperature: number
  mosTemperature: number
}): string {
  return [
    `pos ${formatFixed(radiansToDegrees(status.position), 2)}°`,
    `spd ${formatFixed(status.speed, 3)}`,
    `cur ${formatFixed(status.current, 3)}`,
    `temp ${formatFixed(status.motorTemperature, 1)}/${formatFixed(status.mosTemperature, 1)}`,
    formatMotorError(status.error),
  ].join(' ')
}

/** 旧 CLI 的 FormatCliFloat：固定 6 位。 */
export function formatCliFloat(value: number): string {
  return Number.isFinite(value) ? value.toFixed(6) : ''
}

export function formatTime(seconds: number): string {
  return seconds.toFixed(3)
}

export function formatControlHeader(): string {
  return [
    'pos_deg'.padStart(10),
    'spd'.padStart(9),
    'tor'.padStart(9),
    'cur'.padStart(9),
    'tmp'.padStart(9),
    'mos_tmp'.padStart(9),
    'err',
  ].join('  ')
}

export function formatBatchControlHeader(): string {
  return [
    'slave'.padStart(5),
    'bus'.padStart(5),
    'id'.padStart(5),
    formatControlHeader(),
  ].join('  ')
}

export function formatControlRow(values: {
  positionDeg: number
  speed: number
  torque: number
  current: number
  motorTemperature: number
  mosTemperature: number
  error: string
}): string {
  const cell = (value: number, width: number): string =>
    (Number.isFinite(value) ? value.toFixed(6) : '-').padStart(width)
  return [
    cell(values.positionDeg, 10),
    cell(values.speed, 9),
    cell(values.torque, 9),
    cell(values.current, 9),
    cell(values.motorTemperature, 9),
    cell(values.mosTemperature, 9),
    values.error,
  ].join('  ')
}

export function formatBatchControlRow(
  slaveId: number | null,
  busId: number,
  motorId: number,
  row: string,
): string {
  return [
    (slaveId === null ? '' : String(slaveId)).padStart(5),
    String(busId).padStart(5),
    String(motorId).padStart(5),
    row,
  ].join('  ')
}

export interface StatsTotals {
  sent: number
  received: number
}

/** 旧 stress 的 AppendStatsLine。 */
export function formatStatsLine(
  label: string,
  totals: StatsTotals,
  measurementSeconds: number,
  indentLevel: number,
): string {
  const lost = Math.max(0, totals.sent - totals.received)
  const dropRate = totals.sent === 0 ? 0 : (lost / totals.sent) * 100
  const fps = measurementSeconds <= 0 ? 0 : totals.received / measurementSeconds
  const indent = '  '.repeat(indentLevel)
  return (
    `${indent}${label}: drop_rate=${dropRate.toFixed(2)}% ` +
    `drop=${lost}/${totals.sent} actual_fps=${fps.toFixed(2)}`
  )
}
