// SPDX-License-Identifier: MIT

import { usePopupScroll } from '../popup-scroll.js'
import { formatShortcut } from './Footer.js'
import { Scrollbar } from './Scrollbar.js'
import { screenBox } from '../geometry.js'

import { useSpatialFocus } from '../navigation.js'

import { useInteractionBlocked } from '../interaction.js'

import React, { useEffect, useId, useRef, useState } from 'react'
import {
  Box,
  Text,
  useInput,
  type DOMElement,
} from 'ink'

import { colors, icons } from '../theme.js'
import { clampOverlay, useOverlay } from '../overlay.js'
import { MouseRegion, useMouseEvents } from '../mouse.js'

export interface MenuBarItem {
  id: string
  label: string
  shortcut?: string
  checked?: boolean
  disabled?: boolean
  separator?: boolean
  onSelect?: () => void
}

export interface MenuBarMenu {
  disabled?: boolean
  id: string
  label: string
  maxHeight?: number
  items: MenuBarItem[]
}

export interface MenuBarProps {
  menus: MenuBarMenu[]
  autoFocus?: boolean
  maxHeight?: number
}

export function MenuBar({ menus, autoFocus = false, maxHeight = 12 }: MenuBarProps) {
  const blocked = useInteractionBlocked()
  const id = useId()
  const { show, hide } = useOverlay()
  const [openId, setOpenId] = useState<string | undefined>(undefined)
  const [cursor, setCursor] = useState(0)
  const { isFocused, focus } = useSpatialFocus({ id, autoFocus, isActive: !blocked }, openId ? ['left', 'right', 'up', 'down'] : ['left', 'right'])
  const [activeItem, setActiveItem] = useState(0)
  const [hoveredTrigger, setHoveredTrigger] = useState<string | undefined>(undefined)
  const [hoveredItem, setHoveredItem] = useState<number | undefined>(undefined)
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number } | undefined>(undefined)
  const triggerRefs = useRef<Record<string, DOMElement | null>>({})
  const barRef = useRef<DOMElement | null>(null)
  const menusKey = menus.map(menu => `${menu.disabled}:${menu.id}:${menu.label}:${menu.items.map(item => item.id).join(',')}`).join('|')
  const openMenu = menus.find(menu => menu.id === openId)
  const popup = usePopupScroll(openMenu?.items.length ?? 0, activeItem, openId, openMenu?.maxHeight ?? maxHeight)

  useEffect(() => {
    if (!isFocused) setOpenId(undefined)
  }, [isFocused])

  const selectable = (items: MenuBarItem[]): number[] =>
    items.flatMap((item, index) => (!item.separator && !item.disabled ? [index] : []))

  const moveItem = (direction: 1 | -1): void => {
    if (openMenu === undefined) return
    const indices = selectable(openMenu.items)
    if (indices.length === 0) return
    const current = indices.indexOf(activeItem)
    const next = indices[(current + direction + indices.length) % indices.length]
    setActiveItem(next)
  }

  const activate = (item: MenuBarItem | undefined): void => {
    if (item === undefined || item.separator || item.disabled) return
    item.onSelect?.()
    setOpenId(undefined)
  }

  useInput(
    (_input, key) => {
      if (key.eventType === 'release') return
      if (key.escape) {
        if (openId !== undefined) queueMicrotask(() => focus(id))
        setOpenId(undefined)
        return
      }
      if (key.leftArrow || key.rightArrow) {
        if (!menus.length) return
        const index = openId === undefined ? cursor : menus.findIndex(menu => menu.id === openId)
        const next = (index + (key.rightArrow ? 1 : -1) + menus.length) % menus.length
        setCursor(next)
        if (openId !== undefined) setOpenId(menus[next].disabled?undefined:menus[next].id)
        setActiveItem(selectable(menus[next].items)[0] ?? 0)
        return
      }
      if (openMenu && (key.pageUp || key.pageDown || key.home || key.end)) {
        const indices = selectable(openMenu.items)
        const current = Math.max(0, indices.indexOf(activeItem))
        const next = key.home ? 0 : key.end ? indices.length - 1 : Math.max(0, Math.min(indices.length - 1, current + (key.pageUp ? -popup.capacity : popup.capacity)))
        if (indices[next] !== undefined) setActiveItem(indices[next])
        return
      }
      if (key.downArrow) {
        if (openId === undefined) {
          return
        } else {
          moveItem(1)
        }
        return
      }
      if (key.upArrow) {
        if (openId !== undefined) moveItem(-1)
        return
      }
      if (key.return || _input === ' ') {
        if (openId === undefined) {
          setOpenId(menus[cursor]?.disabled?undefined:menus[cursor]?.id)
          setActiveItem(selectable(menus[cursor]?.items ?? [])[0] ?? 0)
          return
        }
        activate(openMenu?.items[activeItem])
      }
    },
    { isActive: !blocked && isFocused },
  )

  useEffect(() => {
    if (openId === undefined) {
      hide()
      setMenuPosition(undefined)
      return
    }
    const menu = menus.find(item => item.id === openId)
    const trigger = triggerRefs.current[openId]
    if (menu === undefined || trigger === null || trigger === undefined) return
    const triggerBox = screenBox(trigger)
    const barBox = barRef.current === null ? undefined : screenBox(barRef.current)
    const height = popup.height
    const width = 34
    const position = clampOverlay(
      { x: triggerBox.x, y: barBox?.y ?? triggerBox.y, height: barBox?.height ?? triggerBox.height },
      { width, height },
      { columns: popup.screen.columns, rows: popup.screen.rows },
    )
    setMenuPosition(position)
    show(
      <Box
        width={width}
        flexDirection="column"
        borderBackgroundColor={colors.surface} borderStyle="bold"
        borderColor={colors.borderFocus}
        backgroundColor={colors.surface}
        paddingX={0}
      >
        <Box height={popup.capacity}><Box flexDirection="column" flexGrow={1} minWidth={0}>
        {menu.items.slice(popup.offset, popup.offset + popup.capacity).map((item, visibleIndex) => {
          const index = popup.offset + visibleIndex
          if (item.separator) {
            return (
              <Box key={`${item.id}-sep`} paddingY={0} height={1} overflow="hidden">
                <Text color={colors.border}>{'─'.repeat(width - 2)}</Text>
              </Box>
            )
          }
          const active = index === activeItem
          const hovered = index === hoveredItem
          return (
            <Box
              key={item.id}
              height={1} overflow="hidden"
              paddingX={1}
              justifyContent="space-between"
              backgroundColor={active ? colors.active : hovered ? colors.hover : undefined}
            >
              <Text wrap="truncate" color={item.disabled ? colors.muted : active ? colors.onPrimary : hovered ? colors.text : colors.subtle}>
                {item.checked === true ? `${icons.check} ` : ''}
                {item.label}
              </Text>
              {item.shortcut !== undefined ? (
                <Text color={active ? colors.onPrimary : colors.muted}>{formatShortcut(item.shortcut)}</Text>
              ) : null}
            </Box>
          )
        })}
        </Box><Scrollbar contentSize={menu.items.length} viewportSize={popup.capacity} offset={popup.offset} onChange={popup.scroll} /></Box>
      </Box>,
      position,
    )
  }, [openId, activeItem, hoveredItem, isFocused, menusKey, show, hide, focus, id, popup.offset, popup.capacity, popup.screen.rows, popup.screen.columns])

  useMouseEvents(event => {
    if (blocked) return
    if (openId === undefined || menuPosition === undefined) return
    if (popup.handleScroll(event, menuPosition, 34)) { setHoveredItem(undefined); return }
    for (let index = 0; index < menus.length; index++) {
      const trigger = triggerRefs.current[menus[index].id]
      if (!trigger) continue
      const box = screenBox(trigger)
      if (event.x >= box.x && event.x < box.x + box.width && event.y >= box.y && event.y < box.y + box.height) {
        if (event.action === 'move' || (event.action === 'press' && event.button === 'left')) {
          if(menus[index].disabled)return
          const targetId = menus[index].id
          setCursor(index)
          setHoveredTrigger(targetId)
          if (event.action === 'press' && targetId === openId) {
            setOpenId(undefined)
          } else if (targetId !== openId) {
            setOpenId(targetId)
            setActiveItem(selectable(menus[index].items)[0] ?? 0)
            setHoveredItem(undefined)
          }
        }
        return
      }
    }
    const menu = menus.find(item => item.id === openId)
    if (menu === undefined) return
    const inside = popup.inside(event, menuPosition, 34)
    if (event.action === 'move') {
      setHoveredItem(inside ? popup.indexAt(event, menuPosition, 34) : undefined)
      return
    }
    if (event.action === 'press' && event.button === 'left') {
      if (!inside) {
        setOpenId(undefined)
        return
      }
      const index = popup.indexAt(event, menuPosition, 34)
      if (index === undefined) return
      const item = menu.items[index]
      if (item !== undefined && !item.separator) {
        focus(id)
        setActiveItem(index)
        activate(item)
      }
    }
  })

  useEffect(() => () => hide(), [hide])

  return (
    <Box flexDirection="column" width="100%" flexShrink={0}>
      <Box
        backgroundColor={colors.surface}
        ref={barRef}
        width="100%"
        height={3}
        flexShrink={0}
        borderBackgroundColor={colors.surface} borderStyle={isFocused && openId === undefined ? 'bold' : 'single'}
        borderColor={isFocused && openId === undefined ? colors.borderFocus : colors.border}
        paddingX={1}
        gap={1}
      >
        {menus.map((menu, menuIndex) => {
          const open = menu.id === openId
          const hovered = !menu.disabled && (menu.id === hoveredTrigger || (isFocused && menuIndex === cursor))
          return (
            <MouseRegion focusId={id}
              key={menu.id}
              onHover={() => setHoveredTrigger(menu.id)}
              onLeave={() => setHoveredTrigger(value => (value === menu.id ? undefined : value))}
              onPress={() => {
                if(menu.disabled)return
                focus(id)
                setCursor(menuIndex)
                if (open) setOpenId(undefined)
                else {
                  setOpenId(menu.id)
                  setActiveItem(selectable(menu.items)[0] ?? 0)
                }
              }}
            >
              <Box
                ref={element => {
                  triggerRefs.current[menu.id] = element
                }}
                backgroundColor={open ? colors.active : hovered ? colors.hover : undefined}
                paddingX={1}
              >
                <Text color={menu.disabled?colors.muted:open ? colors.onPrimary : hovered ? colors.text : colors.subtle} bold={open}>
                  {menu.label}
                </Text>
              </Box>
            </MouseRegion>
          )
        })}
      </Box>
    </Box>
  )
}
