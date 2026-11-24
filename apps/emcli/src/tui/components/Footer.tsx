// SPDX-License-Identifier: MIT

import { useInteractionBlocked } from '../interaction.js'
import React from 'react'
import { Box, Text, useInput } from 'ink'
import { MouseRegion } from '../mouse.js'
import { colors } from '../theme.js'
export interface FooterAction { key: string; label: string; onPress(): void; disabled?: boolean }
export const formatShortcut = (key: string) => key.replace(/ctrl\+/gi, "^")
export function Footer({ actions, hints = [] }: { actions: FooterAction[]; hints?: Array<{key: string; label: string}> }) {
  const blocked = useInteractionBlocked()
  useInput((input, key) => { if (key.meta || key.shift || key.eventType === 'release') return; const pressed = key.ctrl ? `ctrl+${input}` : input; actions.find(action => action.key.toLowerCase() === pressed && !action.disabled)?.onPress() }, { isActive: !blocked })
  return <Box width="100%" minHeight={1} flexWrap="wrap" flexShrink={0} backgroundColor={colors.panel}>{actions.map(action => <MouseRegion key={action.key} onPress={() => { if (!action.disabled) action.onPress() }}><Text color={action.disabled ? colors.muted : colors.text}> <Text bold color={action.disabled ? colors.muted : colors.accent}>{formatShortcut(action.key)}</Text> {action.label}  </Text></MouseRegion>)}{hints.map(hint => <Text key={hint.key} color={colors.text}> <Text bold color={colors.accent}>{formatShortcut(hint.key)}</Text> {hint.label} </Text>)}</Box>
}
