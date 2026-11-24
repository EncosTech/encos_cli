// SPDX-License-Identifier: MIT
import React, {useEffect, useMemo, useRef, useState} from 'react'
import {Box, Text, useBoxMetrics, useInput, type DOMElement} from 'ink'
import stringWidth from 'string-width'
import {useMouseEvents, type MouseEvent} from '../mouse.js'
import {screenBox} from '../geometry.js'
import {useInteractionBlocked} from '../interaction.js'
import {colors} from '../theme.js'
import {Scrollbar} from './Scrollbar.js'

const segmenter = new Intl.Segmenter(undefined, {granularity: 'grapheme'})
interface Cell {text: string; start: number; end: number; x: number; width: number}
interface Row {cells: Cell[]; start: number; end: number}
export function SelectableText({text, height, onCopy}: {text: string; height: number; onCopy(text: string): void}) {
  const ref = useRef<DOMElement|null>(null), metrics = useBoxMetrics(ref)
  const blocked = useInteractionBlocked()
  const width = Math.max(1, Math.floor(metrics.width || 40))
  const rows = useMemo(() => {
    const result: Row[] = []; let row: Row = {cells: [], start: 0, end: 0}, x = 0
    for (const {segment, index} of segmenter.segment(text)) {
      if (segment === '\n' || segment === '\r\n') {
        row.end = index; result.push(row); row = {cells: [], start: index + segment.length, end: index + segment.length}; x = 0; continue
      }
      const size = stringWidth(segment)
      if (x + size > width && row.cells.length) {result.push(row); row = {cells: [], start: index, end: index}; x = 0}
      row.cells.push({text: segment, start: index, end: index + segment.length, x, width: size})
      row.end = index + segment.length; x += size
    }
    result.push(row); return result
  }, [text, width])
  const [offset, setOffset] = useState(0), [anchor, setAnchor] = useState(0), [cursor, setCursor] = useState(0)
  const drag = useRef<MouseEvent|null>(null)
  const max = Math.max(0, rows.length - height), top = Math.min(offset, max)
  const start = Math.min(anchor, cursor), end = Math.max(anchor, cursor)
  const copy = () => {if (start < end) onCopy(text.slice(start, end))}
  const locate = (event: MouseEvent, position = top) => {
    if (!ref.current) return 0
    const box = screenBox(ref.current)
    const row = rows[Math.max(0, Math.min(rows.length - 1, position + Math.max(0, Math.min(height - 1, event.y - box.y))))]
    const x = event.x - box.x
    return row.cells.find(cell => x < cell.x + cell.width / 2)?.start ?? row.end
  }
  useMouseEvents(event => {
    if (blocked || event.action === 'release') {drag.current = null; return}
    if (!ref.current) return
    const box = screenBox(ref.current), inside = event.x >= box.x && event.x < box.x + width && event.y >= box.y && event.y < box.y + height
    if (event.action === 'move' && drag.current) {drag.current = event; setCursor(locate(event)); return}
    if (!inside) return
    if (event.action === 'wheel') {setOffset(Math.max(0, Math.min(max, top + (event.button === 'wheel-up' ? -3 : 3)))); return}
    if (event.action !== 'press') return
    if (event.button === 'right') {drag.current = null; copy()}
    if (event.button === 'left') {const point = locate(event); setAnchor(point); setCursor(point); drag.current = event}
  })
  const tick = useRef(() => {})
  tick.current = () => {
    if (blocked || !drag.current || !ref.current) return
    const box = screenBox(ref.current), y = drag.current.y - box.y
    const next = Math.max(0, Math.min(max, top + (y < 0 ? -1 : y >= height ? 1 : 0)))
    if (next !== top) {setOffset(next); setCursor(locate(drag.current, next))}
  }
  useEffect(() => {const timer = setInterval(() => tick.current(), 80); return () => clearInterval(timer)}, [])
  useInput((input, key) => {
    if (key.eventType === 'release') return
    if (key.ctrl && key.shift && input.toLowerCase() === 'c') copy()
    else if (key.pageUp || key.pageDown) setOffset(Math.max(0, Math.min(max, top + (key.pageUp ? -height : height))))
  }, {isActive: !blocked})
  return <Box height={height}>
    <Box ref={ref} flexGrow={1} flexBasis={0} minWidth={0} flexDirection="column" overflow="hidden">
      {rows.slice(top, top + height).map((row, i) => <Text key={top + i} wrap="truncate" color={colors.text}>{row.cells.length ? row.cells.map(cell => <Text key={cell.start} backgroundColor={cell.start < end && cell.end > start ? colors.active : undefined} color={cell.start < end && cell.end > start ? colors.onPrimary : colors.text}>{cell.text}</Text>) : ' '}</Text>)}
    </Box>
    <Box width={1} flexShrink={0}><Scrollbar contentSize={rows.length} viewportSize={height} offset={top} onChange={setOffset}/></Box>
  </Box>
}
