// SPDX-License-Identifier: MIT
import React, { useEffect, useId, useRef, useState } from 'react'
import { Box, Text, measureElement, useInput, useWindowSize, type DOMElement } from 'ink'
import { useSpatialFocus } from '../navigation.js'
import { useInteractionBlocked } from '../interaction.js'
import { colors } from '../theme.js'
import { MouseRegion } from '../mouse.js'

export interface TabItem { id: string; label: string; badge?: string }
export interface TabsProps { items: TabItem[]; value: string; onChange(id: string): void; autoFocus?: boolean }

/** Textual's underline moves between measured label spans, without flashing the tabs. */
export function Tabs({ items, value, onChange, autoFocus = false }: TabsProps) {
  const blocked = useInteractionBlocked()
  const id = useId()
  const { isFocused, focus } = useSpatialFocus({ id, autoFocus, isActive: !blocked }, ['left', 'right'])
  const [hoveredId, setHoveredId] = useState<string>()
  const root = useRef<DOMElement | null>(null)
  const labels = useRef<Record<string, DOMElement | null>>({})
  const current = useRef<[number, number] | null>(null)
  const [range, setRange] = useState<[number, number]>([0, 0])
  const [width, setWidth] = useState(0)
  const { columns } = useWindowSize()
  const layoutKey = JSON.stringify(items)

  useEffect(() => {
    if (!root.current) return
    const row = measureElement(root.current)
    setWidth(row.width)
    const node = labels.current[value]
    if (!node) { current.current = null; setRange([0, 0]); return }
    const tab = measureElement(node)
    const target: [number, number] = [tab.x - row.x + 1, tab.x - row.x + tab.width - 1]
    const from = current.current
    if (!from) { current.current = target; setRange(target); return }
    if (from[0] === target[0] && from[1] === target[1]) return
    const started = Date.now()
    const timer = setInterval(() => {
      const progress = Math.min(1, (Date.now() - started) / 130)
      const eased = (1 - Math.cos(Math.PI * progress)) / 2
      const next: [number, number] = [from[0] + (target[0] - from[0]) * eased, from[1] + (target[1] - from[1]) * eased]
      current.current = next
      setRange(next)
      if (progress === 1) clearInterval(timer)
    }, 16)
    return () => clearInterval(timer)
  }, [value, layoutKey, columns])

  const index = Math.max(0, items.findIndex(item => item.id === value))
  useInput((_input, key) => {
    if (!items.length) return
    if (key.leftArrow) onChange(items[(index - 1 + items.length) % items.length].id)
    if (key.rightArrow) onChange(items[(index + 1) % items.length].id)
  }, { isActive: !blocked && isFocused })

  const start = Math.max(0, Math.min(width, Math.round(range[0])))
  const end = Math.max(start, Math.min(width, Math.round(range[1])))
  return <Box ref={root} height={2} backgroundColor={colors.surface}>
    {items.map(item => {
      const active = item.id === value
      const background = isFocused && active ? colors.active : colors.surface
      return <MouseRegion key={item.id} focusId={id} onHover={() => setHoveredId(item.id)} onLeave={() => setHoveredId(undefined)} onPress={() => { focus(id); onChange(item.id) }}>
        <Box ref={node => { labels.current[item.id] = node }} height={2} paddingX={1}>
          <Text backgroundColor={background} color={active || hoveredId === item.id ? colors.text : colors.muted} bold={active}>
            {item.label}{item.badge ? ` ${item.badge}` : ''}
          </Text>
        </Box>
      </MouseRegion>
    })}
    <Box position="absolute" left={0} top={1} width={width} height={1}>
      <Text backgroundColor={colors.surface} color={isFocused ? colors.subtle : colors.border}>{'─'.repeat(start)}<Text color={colors.primary}>{'━'.repeat(end - start)}</Text>{'─'.repeat(Math.max(0, width - end))}</Text>
    </Box>
  </Box>
}
