// SPDX-FileCopyrightText: 2026 Encos
// SPDX-License-Identifier: MIT

import { useSpatialFocus } from '../navigation.js'

import { useInteractionBlocked } from '../interaction.js'

import React, { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Box, Text, useInput, useBoxMetrics, type DOMElement } from 'ink'

import { screenBox } from '../geometry.js'
import { Scrollbar } from './Scrollbar.js'
import { colors, icons, statusColor } from '../theme.js'
import { ContextMenu } from './ContextMenu.js'
import type { MenuBarItem } from './MenuBar.js'
import { MouseRegion } from '../mouse.js'

export type TreeNodeKind = 'adapter' | 'slave' | 'bus' | 'motor' | 'group' | 'imu' | 'battery' | 'pms' | 'glove' | 'dexhand'
export type TreeNodeStatus = 'ok' | 'warn' | 'error' | 'idle' | 'info'

export interface TreeNode {
  id: string
  label: string
  children?: TreeNode[]
  kind?: TreeNodeKind
  status?: TreeNodeStatus
  badge?: string
}

export interface TreeListProps {
  nodes: TreeNode[]
  height?: number
  autoFocus?: boolean
  borderless?: boolean
  compact?: boolean
  value?: string
  checkedIds?: string[]
  onToggle?: (node:TreeNode)=>void
  contextMenu?: (node: TreeNode) => MenuBarItem[]
  onSelect?: (node: TreeNode) => void
}

interface FlatRow {
  node: TreeNode
  depth: number
  parentId?: string
  guide: string
}

const kindIcon: Record<TreeNodeKind, string> = {
  adapter: '◈',
  bus: '', slave: '',
  motor: '●',
  group: '▣', imu: '', battery: '', pms: '', glove: '', dexhand: '',
}

function flatten(nodes: TreeNode[], expanded: Set<string>, depth = 0, parentId?: string, ancestors: boolean[] = []): FlatRow[] {
  const rows: FlatRow[] = []
  nodes.forEach((node, index) => {
    const last = index === nodes.length - 1
    const guide = depth ? ancestors.slice(1).map(continues => continues ? '│  ' : '   ').join('') + (last ? '└─ ' : '├─ ') : ''
    rows.push({ node, depth, parentId, guide })
    if (node.children?.length && expanded.has(node.id)) rows.push(...flatten(node.children, expanded, depth + 1, node.id, [...ancestors, !last]))
  })
  return rows
}

/** Selection values always refer to leaves, including descendants of collapsed nodes. */
export function treeLeafIds(node:TreeNode):string[]{return node.children===undefined?[node.id]:node.children.flatMap(treeLeafIds)}
export function toggleTreeSelection(node:TreeNode,checkedIds:readonly string[]):string[]{
 const keys=treeLeafIds(node),values=new Set(checkedIds),remove=keys.length>0&&keys.every(key=>values.has(key))
 for(const key of keys){if(remove)values.delete(key);else values.add(key)}
 return [...values]
}

export function TreeList({ nodes, height: explicitHeight, autoFocus = false, onSelect, borderless = false, compact = false, value, contextMenu, checkedIds, onToggle }: TreeListProps) {
  const requestedHeight = explicitHeight ?? (borderless ? undefined : 10)
  const root = useRef<DOMElement|null>(null)
  const metrics = useBoxMetrics(root)
  const height = Math.max(1, Math.floor(requestedHeight ?? (metrics.hasMeasured ? metrics.height - (borderless ? 0 : 2) : 10)))
  const blocked = useInteractionBlocked()
  const id = useId()
  const rowRefs = useRef<Record<string, DOMElement | null>>({})
  const [selectedId, setSelectedId] = useState(() => nodes[0]?.id ?? '')
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const initial = new Set<string>()
    const walk = (list: TreeNode[]): void => {
      for (const node of list) {
        if (node.children !== undefined && node.children.length > 0) initial.add(node.id)
        if (node.children !== undefined) walk(node.children)
      }
    }
    walk(nodes)
    return initial
  })

  const rows = useMemo(() => flatten(nodes, expanded), [nodes, expanded])
  const selectedIndex = Math.max(0, rows.findIndex(row => row.node.id === (value ?? selectedId)))
  const selectedNode = rows[selectedIndex]
  const { isFocused, focus } = useSpatialFocus({ id, autoFocus, isActive: !blocked }, [
    ...(selectedIndex > 0 ? ['up' as const] : []),
    ...(selectedIndex < rows.length - 1 ? ['down' as const] : []),
    ...(selectedNode && (expanded.has(selectedNode.node.id) || selectedNode.parentId) ? ['left' as const] : []),
    ...(selectedNode?.node.children?.length && !expanded.has(selectedNode.node.id) ? ['right' as const] : []),
  ])
  const [offset, setOffset] = useState(0)
  const [hoveredId, setHoveredId] = useState<string | undefined>(undefined)

  useEffect(() => {
    setOffset(current => Math.max(0, Math.min(Math.max(0, rows.length - height), selectedIndex < current ? selectedIndex : selectedIndex >= current + height ? selectedIndex - height + 1 : current)))
  }, [selectedIndex, height, rows.length])

  const select = (nodeId: string) => {
    setSelectedId(nodeId)
    const row = rows.find(row => row.node.id === nodeId)
    if (row && checkedIds===undefined) onSelect?.(row.node)
  }
  const known = useRef(new Set<string>())
  useEffect(() => {
    const added: string[] = [], present = new Set<string>(), branches = new Set<string>()
    const visit = (list: TreeNode[]) => list.forEach(node => {present.add(node.id);if (node.children?.length) {branches.add(node.id);if (!known.current.has(node.id)) added.push(node.id);visit(node.children)}})
    visit(nodes);known.current = new Set([...known.current].filter(id => present.has(id)).concat([...branches]))
    setExpanded(current => new Set([...current].filter(id => present.has(id)).concat(added)))
  }, [nodes])

  const expand = (id: string): void => {
    setExpanded(current => new Set(current).add(id))
  }
  const collapse = (id: string): void => {
    setExpanded(current => {
      const next = new Set(current)
      next.delete(id)
      return next
    })
  }

  useInput(
    (_input, key) => {
      if (key.eventType === 'release'||key.ctrl) return
      const row = rows[selectedIndex]
      if (row === undefined) return
      if (key.upArrow) {
        select(rows[Math.max(0, selectedIndex - 1)].node.id)
      } else if (key.downArrow) {
        select(rows[Math.min(rows.length - 1, selectedIndex + 1)].node.id)
      } else if (key.pageUp) {
        select(rows[Math.max(0, selectedIndex - height)].node.id)
      } else if (key.pageDown) {
        select(rows[Math.min(rows.length - 1, selectedIndex + height)].node.id)
      } else if (key.return || _input === ' ') {
        if(checkedIds!==undefined&&(_input===' '||row.node.children===undefined)){onToggle?.(row.node);return}
        if (row.node.children !== undefined && row.node.children.length > 0) {
          if (expanded.has(row.node.id)) collapse(row.node.id)
          else expand(row.node.id)
        }
      } else if (key.rightArrow) {
        if (row.node.children !== undefined && row.node.children.length > 0) expand(row.node.id)
      } else if (key.leftArrow) {
        if (expanded.has(row.node.id)) {
          collapse(row.node.id)
        } else if (row.parentId !== undefined) {
          select(row.parentId)
        }
      }
    },
    { isActive: !blocked && isFocused },
  )

  const scroll = (next: number) => setOffset(Math.max(0, Math.min(Math.max(0, rows.length - height), next)))
  const visible = rows.slice(offset, offset + height)
  return (
    <MouseRegion stretch fill={requestedHeight === undefined} onWheel={rows.length > height ? event => scroll(offset + (event.button === 'wheel-up' ? -3 : 3)) : undefined}><Box
      ref={root}
      flexGrow={1}
      minHeight={0}
      flexShrink={1}
      flexDirection="row"
      height={requestedHeight === undefined ? undefined : height + (borderless ? 0 : 2)}
      borderBackgroundColor={colors.surface} borderStyle={borderless ? undefined : isFocused ? 'bold' : 'single'}
      borderColor={isFocused ? colors.borderFocus : colors.border}
      paddingX={0}
    >
      <Box flexGrow={1} minWidth={0} flexDirection="column">{visible.map(row => {
        const selected = row.node.id === rows[selectedIndex]?.node.id
        const hasChildren = row.node.children !== undefined && row.node.children.length > 0
        const isOpen = expanded.has(row.node.id)
        const icon = hasChildren ? (isOpen ? '▼' : '▶') : ' '
        const nodeIcon = compact ? '' : kindIcon[row.node.kind ?? 'group']
        const status = row.node.status
        const keys=checkedIds===undefined?[]:treeLeafIds(row.node)
        const checked=keys.length>0&&keys.every(key=>checkedIds?.includes(key))
        const partial=!checked&&keys.some(key=>checkedIds?.includes(key))
        const rowBackground = row.node.id === hoveredId ? colors.hover : colors.surface
        const content = (
          <MouseRegion focusId={id}
            key={row.node.id}
            stretch
            onHover={() => setHoveredId(row.node.id)}
            onLeave={() => setHoveredId(undefined)}
            onPress={event => {
              if (event.button !== 'left') return
              focus(id)
              const element = rowRefs.current[row.node.id]
              const toggleX = element ? screenBox(element).x + row.guide.length : -1
              const hitToggle = event.x >= toggleX && event.x < toggleX + 2
              if(checkedIds!==undefined){
                select(row.node.id)
                if(hasChildren&&hitToggle){if(isOpen)collapse(row.node.id);else expand(row.node.id)}
                else onToggle?.(row.node)
                return
              }
              if ((selected || hitToggle) && hasChildren) {
                select(row.node.id)
                if (isOpen) collapse(row.node.id)
                else expand(row.node.id)
              } else {
                select(row.node.id)
              }
            }}
          >
            <Box
              ref={node => { rowRefs.current[row.node.id] = node }}
              width="100%" height={1} overflow="hidden"
              backgroundColor={rowBackground}
            >
              <Text color={colors.border} backgroundColor={rowBackground}>{row.guide}</Text>
              {!compact || hasChildren ? <Text color={colors.muted} backgroundColor={rowBackground}>{icon} </Text> : null}
              <Box flexGrow={1} minWidth={0} justifyContent="space-between" backgroundColor={rowBackground}>
                <Text color={colors.subtle} wrap="truncate">
                  {checkedIds!==undefined?`[${checked?'✓':partial?'−':' '}] `:nodeIcon ? `${nodeIcon} ` : ''}<Text bold={selected} color={selected ? colors.onPrimary : colors.subtle} backgroundColor={selected ? (isFocused ? colors.active : colors.selected) : rowBackground}>{row.node.label}</Text>
                  {status !== undefined ? <Text color={statusColor[status]}> {icons.dot}</Text> : null}
                </Text>
                {row.node.badge !== undefined ? <Text color={selected && isFocused ? colors.onPrimary : colors.muted}>  {row.node.badge} </Text> : null}
              </Box>
            </Box>
          </MouseRegion>
        )
        const items = contextMenu?.(row.node) ?? []
        return items.length ? <ContextMenu key={row.node.id} items={items} restoreFocusId={id} keyboardActive={isFocused && selected} onOpen={() => {focus(id);select(row.node.id)}}>{content}</ContextMenu> : content
      })}</Box>
      <Scrollbar contentSize={rows.length} viewportSize={height} offset={offset} onChange={scroll} />
    </Box></MouseRegion>
  )
}
