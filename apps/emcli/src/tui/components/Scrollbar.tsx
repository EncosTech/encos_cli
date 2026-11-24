// SPDX-License-Identifier: MIT
import React, { useRef, useState } from 'react'
import { Box, Text, type DOMElement } from 'ink'
import { MouseRegion, useMouseEvents } from '../mouse.js'
import { useInteractionBlocked } from '../interaction.js'
import { screenBox } from '../geometry.js'
import { colors } from '../theme.js'
export interface ScrollbarProps { orientation?: 'vertical' | 'horizontal'; focused?: boolean; contentSize: number; viewportSize: number; offset: number; onChange(offset: number): void }
export function Scrollbar({ contentSize, viewportSize, offset, onChange, orientation = 'vertical', focused = false }: ScrollbarProps) {
  const horizontal = orientation === 'horizontal'
  const ref = useRef<DOMElement | null>(null)
  const drag = useRef<number | null>(null)
  const [hovered, setHovered] = useState(false)
  const blocked = useInteractionBlocked()
  const height = Math.max(0, Math.round(viewportSize))
  const max = Math.max(0, contentSize - height)
  const thumb = Math.max(1, Math.floor(height * height / Math.max(1, contentSize)))
  const travel = height - thumb
  const start = max ? Math.round(Math.max(0, Math.min(max, offset)) / max * travel) : 0
  const move = (row: number) => onChange(Math.round(Math.max(0, Math.min(travel, row)) / Math.max(1, travel) * max))
  useMouseEvents(event => {
    if (blocked || event.action === 'release') { drag.current = null; return }
    if (drag.current !== null && event.action === 'move' && ref.current) move((horizontal ? event.x - screenBox(ref.current).x : event.y - screenBox(ref.current).y) - drag.current)
  })
  if (!max || !height) return null
  return <MouseRegion onHover={() => setHovered(true)} onLeave={() => setHovered(false)} onPress={event => {
    if (event.button !== 'left' || !ref.current) return
    const row = horizontal ? event.x - screenBox(ref.current).x : event.y - screenBox(ref.current).y
    if (row >= start && row < start + thumb) drag.current = row - start
    else onChange(Math.max(0, Math.min(max, offset + (row < start ? -height : height))))
  }} onWheel={event => onChange(Math.max(0, Math.min(max, offset + (event.button === 'wheel-up' ? -3 : 3))))}>
    <Box ref={ref} width={horizontal ? height : 1} height={horizontal ? 1 : height} flexShrink={0} flexDirection={horizontal ? 'row' : 'column'}>
      {Array.from({ length: height }, (_, row) => <Text key={row} color={row >= start && row < start + thumb ? (hovered || focused) ? colors.primary : colors.subtle : colors.border} backgroundColor={colors.surface}>{row >= start && row < start + thumb ? horizontal ? '━' : '┃' : horizontal ? '─' : '│'}</Text>)}
    </Box>
  </MouseRegion>
}
