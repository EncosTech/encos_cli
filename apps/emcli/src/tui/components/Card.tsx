// SPDX-License-Identifier: MIT

import React, { useRef, useState, useId, type ReactNode } from 'react'
import stringWidth from 'string-width'
import { Box, Text, useBoxMetrics, useInput, type DOMElement } from 'ink'

import { ScrollView } from './ScrollView.js'
import { Badge } from './Badge.js'
import { MouseRegion } from '../mouse.js'
import { useSpatialFocus } from '../navigation.js'
import { useInteractionBlocked } from '../interaction.js'
import { colors } from '../theme.js'

export interface CardProps {
  title: string
  subtitle?: string
  badge?: string
  badgeColor?: string
  accent?: string
  footer?: ReactNode
  footerGap?: number
  children?: ReactNode
  collapsible?: boolean
  collapsed?: boolean
  defaultCollapsed?: boolean
  onCollapsedChange?(collapsed: boolean): void
  scrollable?: boolean
  flexGrow?: number
  width?: number
  height?: number
  paddingX?: number
  paddingY?: number
}

/** Native border and a clipped title overlay share the same actual layout rectangle. */
export function Card({
  title,
  collapsible = false,
  collapsed: controlledCollapsed,
  defaultCollapsed = false,
  onCollapsedChange,
  badge,
  badgeColor = colors.primary,
  accent = colors.border,
  footer,
  footerGap = 1,
  children,
  scrollable = true,
  flexGrow,
  width,
  height,
  paddingX = 1,
  paddingY = 0,
}: CardProps) {
  const [localCollapsed, setLocalCollapsed] = useState(defaultCollapsed)
  const collapsed = collapsible && (controlledCollapsed ?? localCollapsed)
  const id = useId(), blocked = useInteractionBlocked()
  const {isFocused, focus} = useSpatialFocus({id, isActive: collapsible && !blocked}, ['left', 'right'])
  const toggle = () => {setLocalCollapsed(!collapsed);onCollapsedChange?.(!collapsed)}
  useInput((input, key) => {if (key.eventType === 'release') return;if (key.return || input === ' ' || (key.leftArrow && !collapsed) || (key.rightArrow && collapsed)) toggle()}, {isActive: collapsible && !blocked && isFocused})
  const ref = useRef<DOMElement | null>(null)
  const metrics = useBoxMetrics(ref)
  const cardWidth = Math.max(2, Math.floor(metrics.hasMeasured ? metrics.width : width ?? 40))
  const titleText = title
  if (collapsed) {
    const label = `─ ▶ ${title} `
    return <Box ref={ref} width={width ?? '100%'} height={1} minHeight={1} flexShrink={0} backgroundColor={colors.surface}>
      <MouseRegion stretch focusId={id} onPress={event => {if (event.button === 'left') {focus(id);toggle()}}}>
        <Box width="100%" height={1} overflow="hidden"><Text color={accent} wrap="truncate">─ <Text bold color={isFocused ? colors.primary : colors.text}>▶ {title} </Text><Text color={accent}>{'─'.repeat(Math.max(0,cardWidth-stringWidth(label)))}</Text></Text></Box>
      </MouseRegion>
    </Box>
  }
  return (
    <Box ref={ref} flexDirection="column" flexGrow={collapsed ? 0 : flexGrow ?? (width === undefined && height === undefined ? 1 : 0)} flexBasis={collapsed || height !== undefined || flexGrow === 0 ? undefined : width === undefined ? 0 : undefined} flexShrink={flexGrow !== 0 && width === undefined && height === undefined ? 1 : 0} minWidth={4} minHeight={collapsed ? 2 : 3} width={width} height={collapsed ? 2 : height}
      borderStyle="single" borderColor={accent} borderBackgroundColor={colors.surface}
      backgroundColor={colors.surface} paddingX={paddingX} paddingY={paddingY}>
      {!collapsed && badge !== undefined ? (
        <Box flexShrink={0} justifyContent="flex-end" alignItems="center" marginBottom={1}>
          {badge !== undefined ? <Badge label={badge} color={badgeColor} /> : null}
        </Box>
      ) : null}
      {!collapsed ? scrollable ? <ScrollView>{children}</ScrollView> : children : null}
      {!collapsed && footer !== undefined ? <Box flexShrink={0} marginTop={footerGap}>{footer}</Box> : null}
      <Box position="absolute" top={-1} left={1} maxWidth={Math.max(0, cardWidth - 4)} height={1} overflow="hidden">
        <MouseRegion focusId={collapsible ? id : undefined} onPress={event => {if (collapsible && event.button === 'left') {focus(id);toggle()}}}><Text backgroundColor={colors.surface} bold color={isFocused ? colors.primary : colors.text} wrap="truncate"> {collapsible ? collapsed ? '▶ ' : '▼ ' : ''}{titleText} </Text></MouseRegion>
      </Box>
    </Box>
  )
}
