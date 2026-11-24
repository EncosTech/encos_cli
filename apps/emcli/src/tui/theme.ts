// SPDX-License-Identifier: MIT

/** One resting surface; only interaction and semantic emphasis introduce contrast. */
const baseBackground = '#242b35'
const foreground = '#e0e0e0'
export const colors = {
  background: baseBackground,
  panel: baseBackground,
  text: foreground,
  label: foreground,
  muted: '#8a929c',
  subtle: '#bac2cc',
  primary: '#0178d4',
  accent: '#ffa62b',
  success: '#4ebf71',
  warning: '#f0b429',
  danger: '#e85561',
  cyan: '#54c7ec',
  surface: baseBackground,
  surfaceAlt: baseBackground,
  border: '#526170',
  borderFocus: '#0178d4',
  hover: '#384c60',
  active: '#0178d4',
  selected: '#384c60',
  onPrimary: '#ffffff',
} as const

export const icons = {
  arrow: '›',
  chevronDown: '▾',
  chevronRight: '▸',
  dot: '●',
  diamond: '◆',
  check: '✓',
  cross: '✕',
  spinner: '◌',
  branch: '├─',
  lastBranch: '└─',
  pipe: '│',
} as const

export const statusColor = {
  ok: colors.success,
  warn: colors.warning,
  error: colors.danger,
  idle: colors.muted,
  info: colors.cyan,
} as const

export interface StatusTone {
  color: string
  label: string
}

export const tones: Record<'ok' | 'warn' | 'error' | 'idle' | 'info', StatusTone> = {
  ok: { color: colors.success, label: 'online' },
  warn: { color: colors.warning, label: 'warning' },
  error: { color: colors.danger, label: 'fault' },
  idle: { color: colors.muted, label: 'idle' },
  info: { color: colors.cyan, label: 'info' },
}
