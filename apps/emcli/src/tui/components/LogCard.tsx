// SPDX-License-Identifier: MIT
import React, { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Box, Text, useBoxMetrics, useInput, type DOMElement } from 'ink'
import stringWidth from 'string-width'
import { useClipboardCopy } from '../clipboard.js'
import { Card } from './Card.js'
import { Scrollbar } from './Scrollbar.js'
import { MouseRegion, useMouseEvents } from '../mouse.js'
import { screenBox } from '../geometry.js'
import { useSpatialFocus } from '../navigation.js'
import { useInteractionBlocked } from '../interaction.js'
import { colors } from '../theme.js'
import { cleanLogText, type LogEntry, type LogLevel, type LogStore } from '../log-store.js'

export interface LogCardProps {
  store: LogStore
  title?: string
  width?: number
  height?: number
  flexGrow?: number
  collapsible?: boolean
  collapsed?: boolean
  defaultCollapsed?: boolean
  onCollapsedChange?(collapsed: boolean): void
  autoFocus?: boolean
  levels?: readonly LogLevel[]
  sources?: readonly string[]
  query?: string
  showTimestamp?: boolean
  showSource?: boolean
  wrap?: boolean
  follow?: boolean
  defaultFollow?: boolean
  onFollowChange?(follow: boolean): void
  onCopy?(entries: readonly LogEntry[]): void | Promise<void>
}
const tones: Record<LogLevel, string> = {
  trace: colors.muted, debug: colors.cyan, info: colors.text, warn: colors.warning,
  error: colors.danger, fatal: colors.danger, unknown: colors.subtle,
}
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
function chunks(text: string, width: number): string[] {
  const result: string[] = []
  let line = '', cells = 0
  for (const { segment } of segmenter.segment(text)) {
    const size = stringWidth(segment)
    if (cells + size > width && line) { result.push(line); line = ''; cells = 0 }
    if (size > width) { line += '�'; cells++; continue }
    line += segment; cells += size
  }
  result.push(line)
  return result
}
function time(entry: LogEntry) {
  const date = new Date(Number.isFinite(entry.timestamp) ? entry.timestamp! : entry.receivedAt)
  return Number.isNaN(date.getTime()) ? '--:--:--' : date.toTimeString().slice(0, 8)
}
interface Row { entry: LogEntry; line: number; prefix: string; message: string }

export function LogCard({
  store, title = 'Logs', width, height, flexGrow, autoFocus = false, levels, sources, query = '',
  showTimestamp = true, showSource = true, wrap = true, follow, defaultFollow = true,
  onFollowChange, onCopy, collapsible = false, collapsed: controlledCollapsed, defaultCollapsed = false, onCollapsedChange,
}: LogCardProps) {
  const [localCollapsed, setLocalCollapsed] = useState(defaultCollapsed)
  const collapsed = collapsible && (controlledCollapsed ?? localCollapsed)
  const setCollapsed = (next: boolean) => {setLocalCollapsed(next);onCollapsedChange?.(next)}
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const entries = useMemo(() => snapshot.filter(entry =>
    (!levels || levels.includes(entry.level)) && (!sources || sources.includes(entry.source ?? '')) &&
    entry.message.toLowerCase().includes(query.toLowerCase())), [snapshot, levels, sources, query])
  const [localFollow, setLocalFollow] = useState(defaultFollow)
  const following = follow ?? localFollow
  const [position, setPosition] = useState<{ id: number; line: number }>()
  const [selectedId, setSelectedId] = useState<number>()
  const [anchorId, setAnchorId] = useState<number>()
  const [pausedAt, setPausedAt] = useState(snapshot.at(-1)?.id ?? 0)
  const dragging = useRef(false)
  const dragY = useRef<number | undefined>(undefined)
  const viewport = useRef<DOMElement | null>(null)
  const metrics = useBoxMetrics(viewport)
  const copyText = useClipboardCopy()
  const blocked = useInteractionBlocked() || collapsed, id = useId()
  const { isFocused, focus } = useSpatialFocus({ id, autoFocus, isActive: !blocked }, ['up', 'down'])
  // Reserve a scrollbar column so appearing/disappearing overflow never changes wrapping.
  const columns = Math.max(1, Math.floor(metrics.width || (width ?? 80) - 5))
  const capacity = Math.max(1, Math.floor(metrics.height || (height ?? 14) - 3))
  const rows = useMemo(() => entries.flatMap(entry => {
    const metadata = [showTimestamp ? time(entry) : '', entry.level.toUpperCase(),
      showSource ? entry.source ?? '' : ''].filter(Boolean).join(' ') + ' '
    const prefix = chunks(metadata, Math.max(1, Math.floor(columns / 2)))[0]
    const messageWidth = Math.max(1, columns - stringWidth(prefix))
    const lines = entry.message.split('\n').flatMap(line => {
      const parts = chunks(line, messageWidth)
      return wrap ? parts : [parts[0]]
    })
    return lines.map((message, line): Row => ({ entry, line, prefix: line === 0 ? prefix : ' '.repeat(stringWidth(prefix)), message }))
  }), [entries, columns, showTimestamp, showSource, wrap])
  const maxOffset = Math.max(0, rows.length - capacity)
  const exact = position ? rows.findIndex(row => row.entry.id === position.id && row.line === position.line) : 0
  const located = exact < 0 && position ? rows.findIndex(row => row.entry.id === position.id) : exact
  const offset = following ? maxOffset : Math.min(maxOffset, Math.max(0, located))
  const currentIndex = Math.max(0, selectedId === undefined ? (following ? entries.length - 1 : 0) : entries.findIndex(entry => entry.id === selectedId))
  const anchorIndex = anchorId === undefined ? currentIndex : Math.max(0, entries.findIndex(entry => entry.id === anchorId))
  const selected = new Set(entries.slice(Math.min(currentIndex, anchorIndex), Math.max(currentIndex, anchorIndex) + 1).map(entry => entry.id))
  const latestId = snapshot.at(-1)?.id ?? 0
  const requestedFollow = useRef(following)
  useEffect(() => { requestedFollow.current = following }, [following])
  const setFollowing = (next: boolean) => {
    if (next === requestedFollow.current) return
    requestedFollow.current = next
    setLocalFollow(next)
    if (!next) setPausedAt(latestId)
    onFollowChange?.(next)
  }
  const priorFollow = useRef(following)
  useEffect(() => {
    if (priorFollow.current && !following) setPausedAt(latestId)
    priorFollow.current = following
  }, [following, latestId])
  useEffect(() => { if (!isFocused || blocked) dragging.current = false }, [isFocused, blocked])
  const scroll = (next: number) => {
    const target = Math.max(0, Math.min(maxOffset, next))
    const row = rows[target]
    setPosition(row ? { id: row.entry.id, line: row.line } : undefined)
    setFollowing(target === maxOffset)
  }
  const move = (index: number, extend = false) => {
    const target = entries[Math.max(0, Math.min(entries.length - 1, index))]
    if (!target) return
    setAnchorId(extend ? anchorId ?? entries[currentIndex]?.id : undefined)
    setSelectedId(target.id)
    const first = rows.findIndex(row => row.entry.id === target.id)
    scroll(first < offset ? first : first >= offset + capacity ? first - capacity + 1 : offset)
  }
  const copy = (fallback?: LogEntry) => {
    const records = anchorId !== undefined || !fallback
      ? entries.filter(entry => selected.has(entry.id))
      : [fallback]
    if (!records.length) return
    const text = records.map(entry => [showTimestamp ? time(entry) : '', entry.level.toUpperCase(),
      showSource ? entry.source ?? '' : '', entry.message].filter(Boolean).join(' ')).join('\n')
    void copyText(text, onCopy ? () => onCopy(records) : undefined)
  }
  useInput((input, key) => {
    if (key.eventType === 'release') return
    if (key.ctrl && key.shift && input.toLowerCase() === 'c') return copy()
    if (key.upArrow) move(currentIndex - 1, key.shift)
    else if (key.downArrow) move(currentIndex + 1, key.shift)
    else if (key.pageUp || key.pageDown) {
      const next = Math.max(0, Math.min(maxOffset, offset + (key.pageUp ? -capacity : capacity)))
      scroll(next)
      const entry = rows[next]?.entry
      if (entry) { setSelectedId(!key.shift && next === maxOffset ? undefined : entry.id); setAnchorId(key.shift ? anchorId ?? entries[currentIndex]?.id : undefined) }
    } else if (key.home) move(0, key.shift)

  }, { isActive: isFocused && !blocked })
  const point = (y: number) => {
    if (!viewport.current) return
    const relative = y - screenBox(viewport.current).y
    const rowIndex = Math.max(0, Math.min(rows.length - 1, offset + relative))
    const row = rows[rowIndex]
    if (!row) return
    setSelectedId(row.entry.id)
    if (relative < 0) scroll(offset - 1)
    else if (relative >= capacity) scroll(offset + 1)
  }
  useMouseEvents(event => {
    if (blocked || !isFocused) { dragging.current = false; return }
    if (!dragging.current) return
    if (event.action === 'release') { point(event.y); dragging.current = false; dragY.current = undefined }
    else if (event.action === 'move' && event.button === 'left') { dragY.current = event.y; point(event.y) }
    else if (event.action === 'move') dragging.current = false
  })
  // Use the latest viewport/offset on every tick, even when the pointer stops moving.
  const autoScroll = useRef(() => {})
  autoScroll.current = () => {
    if (!dragging.current || blocked || !isFocused || dragY.current === undefined || !viewport.current) return
    const relative = dragY.current - screenBox(viewport.current).y
    if (relative < 0 || relative >= capacity) point(dragY.current)
  }
  useEffect(() => {
    const timer = setInterval(() => autoScroll.current(), 80)
    return () => clearInterval(timer)
  }, [])
  const newCount = entries.filter(entry => entry.id > pausedAt).length
  return <Box width={width} height={collapsed ? 1 : height ?? (flexGrow ? undefined : 14)} flexGrow={collapsed ? 0 : flexGrow} flexBasis={!collapsed && flexGrow ? 0 : undefined} flexShrink={0} minHeight={collapsed ? 1 : 6} minWidth={8}>
    <MouseRegion stretch fill focusId={id} onPress={event => { if (event.button === 'right') { dragging.current = false; copy() } else if (event.button === 'left') focus(id) }}
      onWheel={event => scroll(offset + (event.button === 'wheel-up' ? -3 : 3))}>
      <Card collapsible={collapsible} collapsed={collapsed} onCollapsedChange={setCollapsed} title={cleanLogText(title).replace(/\n/g, ' ')} scrollable={false} accent={!collapsed && isFocused ? colors.borderFocus : colors.border} paddingX={1}
        footerGap={0} footer={<Text color={colors.muted} wrap="truncate">{entries.length} entries · {following ? 'Following' : `Paused${newCount ? ` · ${newCount} new` : ''}`}</Text>}>
        <Box flexGrow={1} flexBasis={0} minHeight={0}>
          <Box ref={viewport} flexGrow={1} flexBasis={0} minWidth={0} flexDirection="column" overflow="hidden">
            {!rows.length ? <Text color={colors.muted}>{snapshot.length ? 'No matching logs' : 'No logs'}</Text> :
              rows.slice(offset, offset + capacity).map(row => <MouseRegion key={`${row.entry.id}:${row.line}`} stretch focusId={id} onPress={event => {
                if (event.button === 'right') { dragging.current = false; copy(row.entry); return }
                if (event.button !== 'left') return
                focus(id); setSelectedId(row.entry.id); setAnchorId(row.entry.id); dragging.current = true; dragY.current = event.y
              }}><Box width="100%" height={1} backgroundColor={isFocused && selected.has(row.entry.id) ? colors.selected : colors.surface}>
                <Text color={tones[row.entry.level]}>{row.prefix}</Text>
                <Text color={colors.text} wrap="truncate">{row.message}</Text>
              </Box></MouseRegion>)}
          </Box>
          <Box width={1} flexShrink={0}><Scrollbar focused={isFocused} contentSize={rows.length} viewportSize={capacity} offset={offset} onChange={scroll} /></Box>
        </Box>
      </Card>
    </MouseRegion>
  </Box>
}
