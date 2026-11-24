// SPDX-License-Identifier: MIT

import React from 'react'
import { Text } from 'ink'

import { colors } from '../theme.js'

export interface BadgeProps {
  label: string
  color?: string
  variant?: 'solid' | 'outline' | 'muted'
}

export function Badge({ label, color = colors.primary, variant = 'solid' }: BadgeProps) {
  if (variant === 'outline') {
    return (
      <Text color={color} dimColor>
        [{label}]
      </Text>
    )
  }
  if (variant === 'muted') {
    return <Text color={colors.muted}>{label}</Text>
  }
  return (
    <Text backgroundColor={color} color={colors.onPrimary} bold>
      {' '}
      {label}{' '}
    </Text>
  )
}
