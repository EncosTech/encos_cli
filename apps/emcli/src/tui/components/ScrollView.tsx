// SPDX-License-Identifier: MIT
import React, { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Box, measureElement, useBoxMetrics, useInput, type DOMElement } from 'ink'
import { MouseRegion } from '../mouse.js'
import { screenBox } from '../geometry.js'
import { useSpatialFocus, useFocusedElements } from '../navigation.js'
import { useInteractionBlocked } from '../interaction.js'
import { Scrollbar } from './Scrollbar.js'
export function ScrollView({ children }: { children: ReactNode }) {
  const viewport = useRef<DOMElement | null>(null), content = useRef<DOMElement | null>(null)
  const view = useBoxMetrics(viewport), body = useBoxMetrics(content)
  const focused = useFocusedElements()
  const [horizontalOffset, setHorizontalOffset] = useState(0)
  const [contentWidth, setContentWidth] = useState(0)
  const [offset, setOffset] = useState(0)
  const max = Math.max(0, body.height - view.height)
  const maxX = Math.max(0, contentWidth - Math.round(view.width))
  useEffect(() => {
    if (!content.current) return
    const origin = measureElement(content.current).x
    let right = origin + measureElement(content.current).width
    const walk = (node: DOMElement) => {
      const box = measureElement(node)
      right = Math.max(right, box.x + box.width)
      if (node.style.overflow === 'hidden' || node.style.overflowX === 'hidden') return
      for (const child of node.childNodes) if (child.nodeName !== '#text') walk(child as DOMElement)
    }
    walk(content.current)
    setContentWidth(Math.round(right - origin))
  })
  const scrollX = (next: number) => setHorizontalOffset(Math.max(0, Math.min(maxX, next)))
  useEffect(() => { setHorizontalOffset(value => Math.min(value, maxX)) }, [maxX])
  const id = useId(), blocked = useInteractionBlocked()
  const { isFocused, focus } = useSpatialFocus({ id, isActive: (max > 0 || maxX > 0) && !blocked }, maxX ? ['up', 'down', 'left', 'right'] : ['up', 'down'])
  useEffect(() => {
    if (!viewport.current || !content.current) return
    for (const element of focused.elements()) {
      let parent: DOMElement | undefined = element
      while (parent && parent !== content.current) parent = parent.parentNode
      if (!parent) continue
      const box = screenBox(element), frame = screenBox(viewport.current)
      if (box.y < frame.y) setOffset(value => Math.max(0, value + box.y - frame.y))
      else if (box.y + box.height > frame.y + frame.height) setOffset(value => Math.min(max, value + box.y + box.height - frame.y - frame.height))
      if (box.x < frame.x) setHorizontalOffset(value => Math.max(0, value + box.x - frame.x))
      else if (box.x + box.width > frame.x + frame.width) setHorizontalOffset(value => Math.min(maxX, value + box.x + box.width - frame.x - frame.width))
      break
    }
  }, [focused.activeId, view.height, view.width])
  const scroll = (next: number) => setOffset(Math.max(0, Math.min(max, next)))
  useEffect(() => { setOffset(value => Math.min(value, max)) }, [max])
  useInput((_input, key) => {
    if (key.eventType === 'release') return
    if (key.leftArrow) scrollX(horizontalOffset - 3)
    if (key.rightArrow) scrollX(horizontalOffset + 3)
    if (key.upArrow) scroll(offset - 1)
    if (key.downArrow) scroll(offset + 1)
    if (key.pageUp) scroll(offset - view.height)
    if (key.pageDown) scroll(offset + view.height)
    if (key.home) scroll(0)
    if (key.end) scroll(max)
  }, { isActive: isFocused && !blocked && (max > 0 || maxX > 0) })
  return <MouseRegion stretch fill focusId={max > 0 || maxX > 0 ? id : undefined} onPress={() => { if (max || maxX) focus(id) }} onWheel={max > 0 || maxX > 0 ? event => { const delta = event.button === 'wheel-up' ? -3 : 3; if (max) scroll(offset + delta); else scrollX(horizontalOffset + delta) } : undefined}>
    <Box flexGrow={1} flexBasis={0} minHeight={0} minWidth={0} flexDirection="column">
    <Box flexGrow={1} flexBasis={0} minHeight={0} minWidth={0}>
      <Box ref={viewport} flexDirection="column" flexGrow={1} flexBasis={0} minWidth={0} minHeight={0} overflow="hidden" contentOffsetY={Math.min(offset, max)} contentOffsetX={Math.min(horizontalOffset, maxX)}>
        <Box ref={content} flexDirection="column" flexShrink={0}>{children}</Box>
      </Box>
      <Scrollbar focused={isFocused} contentSize={body.height} viewportSize={view.height} offset={Math.min(offset, max)} onChange={scroll} />
    </Box>
    <Scrollbar focused={isFocused} orientation="horizontal" contentSize={contentWidth} viewportSize={view.width} offset={Math.min(horizontalOffset, maxX)} onChange={scrollX} />
    </Box>
  </MouseRegion>
}
