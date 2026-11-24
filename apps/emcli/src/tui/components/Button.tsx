// SPDX-License-Identifier: MIT

import { useSpatialFocus } from '../navigation.js'

import { useInteractionBlocked } from '../interaction.js'

import React, { useEffect, useId, useRef, useState } from 'react'
import { Box, Text,  useInput } from 'ink'

import { colors } from '../theme.js'
import { MouseRegion } from '../mouse.js'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success' | 'warning'

export interface ButtonProps {
  label: string
  onPress?: () => void
  variant?: ButtonVariant
  icon?: string
  shortcut?: string
  disabled?: boolean
  autoFocus?: boolean
  size?: 'large' | 'medium' | 'small'
  width?: number
}

export function buttonPalette(variant: ButtonVariant, hovered: boolean, pressed: boolean, disabled = false) {
  const base = { primary: colors.primary, danger: '#b33958', success: colors.success, warning: '#ffa62b', secondary: '#2a313a', ghost: colors.surface }[variant]
  const mix = (color: string, target: string, amount: number) => '#' + [1, 3, 5].map(start => {
    const a = parseInt(color.slice(start, start + 2), 16)
    const b = parseInt(target.slice(start, start + 2), 16)
    return Math.round(a + (b - a) * amount).toString(16).padStart(2, '0')
  }).join('')
  const light = mix(base, '#ffffff', variant === 'secondary' || variant === 'ghost' ? 0.06 : 0.25)
  const dark = mix(base, '#000000', 0.3)
  // Textual's active effect swaps edge lighting and applies a background tint.
  const tint = (color: string) => disabled ? mix(color, colors.background, 0.55) : pressed ? mix(color, colors.background, 0.3) : color
  return {
    bg: tint(pressed ? base : hovered ? mix(base, '#000000', 0.15) : base),
    top: tint(pressed ? dark : hovered ? base : light),
    bottom: tint(pressed ? light : dark),
    fg: disabled ? mix(variant === 'warning' ? '#171e28' : colors.text, colors.background, 0.55) : variant === 'warning' ? '#171e28' : colors.text,
  }
}

export function Button({
  label,
  onPress,
  variant = 'secondary',
  icon,
  shortcut,
  disabled = false,
  autoFocus = false,
  width,
  size = 'large',
}: ButtonProps) {
  const blocked = useInteractionBlocked()
  const id = useId()
  const [hovered, setHovered] = useState(false)
  const { isFocused, focus } = useSpatialFocus({ id, autoFocus, isActive: !blocked && !disabled })
  const [pressed, setPressed] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const activate = () => {
    if (disabled || blocked) return
    setPressed(true)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setPressed(false), 200)
    onPress?.()
  }
  const style = buttonPalette(variant, !disabled && hovered, !disabled && pressed, disabled)
  const caption = `${icon ? icon + ' ' : ''}${label}${shortcut ? '  ' + shortcut : ''}`
  const buttonWidth = Math.max(size === 'large' ? 16 : size === 'medium' ? 12 : 8, width ?? caption.length + 4)
  const face = style.bg

  useInput(
    (input, key) => {
      if (disabled || key.ctrl || key.meta || key.eventType === 'release') return
      if (key.return || input === ' ') {
        activate()
      }
    },
    { isActive: !blocked && isFocused && !disabled },
  )

  return (
    <MouseRegion focusId={id} disabled={disabled}
      onHover={() => setHovered(true)}
      onLeave={() => setHovered(false)}
      onPress={() => {
        if (disabled) return
        focus(id)
        activate()
      }}
    >
      <Box width={buttonWidth} height={size === 'small' ? 1 : 3} backgroundColor={size === 'medium' ? colors.surface : face} flexShrink={0} flexDirection="column">
        {size === 'medium' && <Text color={face} backgroundColor={colors.surface}>{'▄'.repeat(buttonWidth)}</Text>}
        {size === 'large' && <Text color={style.top} backgroundColor={face}>{'▔'.repeat(buttonWidth)}</Text>}
        <Box width={buttonWidth} backgroundColor={face} justifyContent="center">
          <Text color={style.fg} backgroundColor={face} bold inverse={isFocused} wrap="truncate">{caption}</Text>
        </Box>
        {size === 'medium' && <Text color={face} backgroundColor={colors.surface}>{'▀'.repeat(buttonWidth)}</Text>}
        {size === 'large' && <Text color={style.bottom} backgroundColor={face}>{'▁'.repeat(buttonWidth)}</Text>}
      </Box>
    </MouseRegion>
  )
}
