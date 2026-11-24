// SPDX-License-Identifier: MIT
import {FieldLabel} from './FieldLabel.js'

import { usePopupScroll } from '../popup-scroll.js'
import { Scrollbar } from './Scrollbar.js'
import { screenBox } from '../geometry.js'

import { useSpatialFocus } from '../navigation.js'

import { useInteractionBlocked } from '../interaction.js'

import React, { useEffect, useId, useRef, useState } from 'react'
import { Box, Text, useInput, type DOMElement } from 'ink'

import { colors, icons } from '../theme.js'
import { clampOverlay, useOverlay } from '../overlay.js'
import { MouseRegion, useMouseEvents } from '../mouse.js'

export interface DropdownOption<T extends string = string> {
  value: T
  label: string
  description?: string
  badge?: string
}

interface DropdownBase<T extends string> {
  size?: 'small' | 'large'
  label: string
  options: DropdownOption<T>[]
  width?: number
  maxHeight?: number
  autoFocus?: boolean
}

export interface SingleDropdownProps<T extends string = string> extends DropdownBase<T> {
  multiple?: false
  value: T
  onChange: (value: T) => void
}

export interface MultiDropdownProps<T extends string = string> extends DropdownBase<T> {
  multiple: true
  values: T[]
  onChange: (values: T[]) => void
}

export type DropdownProps<T extends string = string> =
  | SingleDropdownProps<T>
  | MultiDropdownProps<T>

export function Dropdown<T extends string = string>(props: DropdownProps<T>) {
  const { label, options, width = 30, maxHeight = 12, autoFocus = false, size = 'large' } = props
  const multiple = props.multiple === true
  const selectedValues: T[] = multiple ? props.values : [props.value]
  const selectedKey = selectedValues.join('\u0000')
  const optionsKey = options.map(option => option.value).join('\u0000')
  const blocked = useInteractionBlocked()
  const id = useId()
  const { show, hide } = useOverlay()
  const triggerRef = useRef<DOMElement | null>(null)
  const [open, setOpen] = useState(false)
  const { isFocused, focus } = useSpatialFocus({ id, autoFocus, isActive: !blocked }, open ? ['up', 'down', 'left', 'right'] : [])
  const [hoveredTrigger, setHoveredTrigger] = useState(false)
  const [hoveredOption, setHoveredOption] = useState<number | undefined>(undefined)
  const [active, setActive] = useState(() => Math.max(0, options.findIndex(option => option.value === selectedValues[0])))
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number } | undefined>(undefined)
  const popup = usePopupScroll(options.length, active, open ? id : undefined, maxHeight)

  useEffect(() => {
    if (!isFocused) setOpen(false)
  }, [isFocused])

  useEffect(() => {
    if (open && multiple) {
      // Toggling a checkbox changes the selection, not the navigation cursor.
      setActive(current => Math.max(0, Math.min(current, options.length - 1)))
    } else {
      setActive(Math.max(0, options.findIndex(option => option.value === selectedValues[0])))
    }
  }, [selectedKey, optionsKey, open, multiple])

  const commit = (option: DropdownOption<T>): void => {
    if (multiple) {
      const next = new Set(props.values)
      if (next.has(option.value)) next.delete(option.value)
      else next.add(option.value)
      props.onChange([...next])
    } else {
      props.onChange(option.value)
      setOpen(false)
    }
  }

  useInput(
    (input, key) => {
      if (key.eventType === 'release') return
      if (key.escape) {
        if (open) queueMicrotask(() => focus(id))
        setOpen(false)
        return
      }
      if (key.return || (open && input === ' ')) {
        if (!open) {
          setOpen(true)
          return
        }
        const option = options[active]
        if (option !== undefined) commit(option)
        return
      }
      if (open && (key.pageUp || key.pageDown || key.home || key.end)) {
        setActive(current => key.home ? 0 : key.end ? Math.max(0, options.length - 1) : Math.max(0, Math.min(options.length - 1, current + (key.pageUp ? -popup.capacity : popup.capacity))))
        return
      }
      if (key.upArrow) {
        if (!open) {
          return
        }
        if (!options.length) return
        setActive(current => (current - 1 + options.length) % options.length)
      } else if (key.downArrow) {
        if (!open) {
          return
        }
        if (!options.length) return
        setActive(current => (current + 1) % options.length)
      }
    },
    { isActive: !blocked && isFocused },
  )

  useEffect(() => {
    if (!open) {
      hide()
      setMenuPosition(undefined)
      return
    }
    const element = triggerRef.current
    if (element === null) return
    const box = screenBox(element)
    const screen = {
      columns: popup.screen.columns,
      rows: popup.screen.rows,
    }
    const position = clampOverlay(
      { x: box.x, y: box.y, height: box.height+(size==='small'?1:0) },
      { width, height: popup.height },
      screen,
    )
    setMenuPosition(position)
    show(
      <Box
        width={width}
        flexDirection="column"
        borderBackgroundColor={colors.surface} borderStyle={{ topLeft: '├', top: '─', topRight: '┤', left: '│', right: '│', bottomLeft: '└', bottom: '─', bottomRight: '┘' }}
        borderColor={colors.borderFocus}
        backgroundColor={colors.surface}
        paddingX={0}
      >
        <Box height={popup.capacity}><Box flexDirection="column" flexGrow={1} minWidth={0}>
        {options.slice(popup.offset, popup.offset + popup.capacity).map((option, visibleIndex) => {
          const index = popup.offset + visibleIndex
          const current = index === active
          const hovered = index === hoveredOption
          const checked = selectedValues.includes(option.value)
          return (
            <Box
              key={option.value}
              height={1} overflow="hidden"
              paddingX={1}
              justifyContent="space-between"
              backgroundColor={current ? colors.active : hovered ? colors.hover : undefined}
            >
              <Text
                color={current ? colors.onPrimary : hovered ? colors.text : colors.subtle}
                wrap="truncate" bold={current}
              >
                {multiple ? `[${checked ? icons.check : ' '}] ` : ''}
                {option.label}
              </Text>
              {option.badge !== undefined ? (
                <Text color={current ? colors.onPrimary : colors.muted}>{option.badge}</Text>
              ) : null}
            </Box>
          )
        })}
        </Box><Scrollbar contentSize={options.length} viewportSize={popup.capacity} offset={popup.offset} onChange={popup.scroll} /></Box>
      </Box>,
      position,
    )
  }, [open, size, active, hoveredOption, selectedKey, optionsKey, isFocused, width, popup.offset, popup.capacity, popup.screen.rows, popup.screen.columns])

  useEffect(() => () => hide(), [hide])

  useMouseEvents(event => {
    if (blocked) return
    if (!open || menuPosition === undefined) return
    if (popup.handleScroll(event, menuPosition, width)) { setHoveredOption(undefined); return }
    const inside = popup.inside(event, menuPosition, width)
    if (event.action === 'move') {
      setHoveredOption(inside ? popup.indexAt(event, menuPosition, width) : undefined)
      return
    }
    if (event.action === 'press' && event.button === 'left') {
      if (!inside) {
        setOpen(false)
        return
      }
      const index = popup.indexAt(event, menuPosition, width)
      if (index === undefined) return
      const option = options[index]
      if (option !== undefined) {
        focus(id)
        setActive(index)
        commit(option)
      }
    }
  })

  const selected = options.find(option => option.value === selectedValues[0])
  const triggerLabel = multiple
    ? selectedValues.length === 0
      ? 'none'
      : `${selectedValues.length} selected`
    : (selected?.label ?? props.value)
  const highlighted = isFocused || hoveredTrigger

  return (
    <Box flexDirection="column" width={width}>
      {label?<FieldLabel>{label}</FieldLabel>:null}
      <MouseRegion focusId={id}
        onHover={() => setHoveredTrigger(true)}
        onLeave={() => setHoveredTrigger(false)}
        onPress={() => {
          focus(id)
          setOpen(current => !current)
        }}
      >
        <Box
          ref={triggerRef}
          width={width}
          borderBackgroundColor={colors.surface} borderStyle={size==='small'?undefined:'single'}
          borderColor={open ? colors.active : highlighted ? colors.borderFocus : colors.border}
          backgroundColor={open ? colors.active : highlighted ? colors.hover : colors.surface}
          paddingX={1}
          justifyContent="space-between"
        >
          <Text color={open ? colors.onPrimary : colors.text}>{triggerLabel}</Text>
          <Text color={open ? colors.onPrimary : colors.muted}>{open ? '▲' : '▼'}</Text>
        </Box>
      </MouseRegion>

    </Box>
  )
}
