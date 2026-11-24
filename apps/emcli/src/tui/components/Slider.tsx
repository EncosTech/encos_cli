// SPDX-License-Identifier: MIT

import { screenBox } from '../geometry.js'

import { useSpatialFocus } from '../navigation.js'

import { useInteractionBlocked } from '../interaction.js'
import React, { useId, useRef, useState } from 'react'
import { Box, Text,  useInput, measureElement, type DOMElement } from 'ink'
import { MouseRegion, useMouseEvents } from '../mouse.js'
import { colors } from '../theme.js'
export interface SliderProps { value: number; onChange(value: number): void; min?: number; max?: number; step?: number; width?: number; disabled?: boolean; autoFocus?: boolean }
export function Slider({ value, onChange, min = 0, max = 100, step = 1, width = 24, disabled = false, autoFocus = false }: SliderProps) {
  const blocked = useInteractionBlocked()
  const id = useId(), ref = useRef<DOMElement | null>(null), dragging = useRef(false)
  const { isFocused, focus } = useSpatialFocus({ id, autoFocus, isActive: !blocked && !disabled }, ['left', 'right'])
  const [hovered, setHovered] = useState(false)
  const length = Math.max(2, Math.floor(width)), upper = Math.max(min, max), increment = step > 0 ? step : 1
  const change = (next: number) => { if (!disabled) onChange(Number(Math.max(min, Math.min(upper, min + Math.round((next - min) / increment) * increment)).toFixed(10))) }
  const position = upper === min ? 0 : Math.round((Math.max(min, Math.min(upper, value)) - min) / (upper - min) * (length - 1))
  const point = (x: number) => { if (ref.current) change(min + (x - screenBox(ref.current).x) / (length - 1) * (upper - min)) }
  useMouseEvents(event => { if (blocked || disabled) { dragging.current = false; return } if (event.action === 'release') dragging.current = false; else if (dragging.current && event.action === 'move') point(event.x) })
  useInput((_input, key) => { if (key.leftArrow) change(value - increment); if (key.rightArrow) change(value + increment); if (key.home) change(min); if (key.end) change(upper) }, { isActive: !blocked && isFocused && !disabled })
  return <MouseRegion focusId={id} disabled={disabled} onHover={() => setHovered(true)} onLeave={() => setHovered(false)} onPress={event => { if (disabled || event.button !== 'left') return; focus(id); dragging.current = true; point(event.x) }}><Box ref={ref} width={length}><Text color={disabled ? colors.muted : colors.primary}>{'━'.repeat(position)}<Text color={isFocused || hovered ? colors.accent : colors.text}>●</Text><Text color={colors.border}>{'─'.repeat(length - position - 1)}</Text></Text></Box></MouseRegion>
}
