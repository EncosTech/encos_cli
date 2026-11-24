// SPDX-License-Identifier: MIT
import React, { useEffect, useId, useRef, useState } from 'react'
import { Box, Text, useInput, type DOMElement } from 'ink'
import { useClipboardCopy } from '../clipboard.js'
import stringWidth from 'string-width'
import { useSpatialFocus } from '../navigation.js'
import { useInteractionBlocked } from '../interaction.js'
import { screenBox } from '../geometry.js'
import { colors } from '../theme.js'
import { MouseRegion, useMouseEvents } from '../mouse.js'

export interface TextInputProps {
  value: string
  onChange(value: string): void
  onSubmit?(value: string): void
  onBlur?(): void
  placeholder?: string
  size?: 'small' | 'large'
  width?: number
  disabled?: boolean
  password?: boolean
  autoFocus?: boolean
}
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const characters = (text: string) => Array.from(segmenter.segment(text), part => part.segment)

export function TextInput({ value, onChange, onSubmit, onBlur, placeholder = '', size = 'large', width = 30, disabled = false, password = false, autoFocus = false }: TextInputProps) {
  const blocked = useInteractionBlocked(), id = useId()
  const copyText = useClipboardCopy()
  const ref = useRef<DOMElement | null>(null)
  const { isFocused, focus } = useSpatialFocus({ id, autoFocus, isActive: !blocked && !disabled }, ['left', 'right'])
  const [cursor, setCursor] = useState(characters(value).length)
  const [anchor, setAnchor] = useState<number | undefined>()
  const dragging = useRef(false)
  const [cursorVisible, setCursorVisible] = useState(true)
  const [cursorActivity, setCursorActivity] = useState(0)
  useEffect(() => {
    setCursorVisible(true)
    if (!isFocused || blocked || disabled) return
    const timer = setInterval(() => setCursorVisible(visible => !visible), 500)
    return () => clearInterval(timer)
  }, [isFocused, blocked, disabled, cursorActivity])
  const touchCursor = () => {
    setCursorVisible(true)
    setCursorActivity(activity => activity + 1)
  }
  useEffect(() => {
    if (!isFocused || blocked || disabled) {
      dragging.current = false
      setAnchor(undefined)
    }
  }, [isFocused, blocked, disabled])
  const showCursor = isFocused && !blocked && !disabled && cursorVisible
  const wasFocused = useRef(false), blur = useRef(onBlur)
  blur.current = onBlur
  useEffect(() => {
    if (wasFocused.current && !isFocused) blur.current?.()
    wasFocused.current = isFocused
  }, [isFocused])
  const chars = characters(value), at = Math.min(cursor, chars.length)
  const selectionStart = Math.min(at, anchor ?? at)
  const selectionEnd = Math.min(chars.length, Math.max(at, anchor ?? at))
  const hasSelection = selectionStart < selectionEnd
  const copy = () => {
    if (hasSelection && !password && !disabled && !blocked)
      void copyText(chars.slice(selectionStart, selectionEnd).join(''))
  }
  const moveCursor = (next: number, extend = false) => {
    setAnchor(extend ? anchor ?? at : undefined)
    setCursor(next)
    touchCursor()
  }
  const replaceSelection = (insert: string[]) => {
    chars.splice(selectionStart, selectionEnd - selectionStart, ...insert)
    onChange(chars.join(''))
    setCursor(selectionStart + insert.length)
    setAnchor(undefined)
    touchCursor()
  }
  const display = password ? chars.map(() => '•') : chars
  const available = Math.max(1, Math.floor(width) - (size === 'large' ? 4 : 2))
  let start = 0
  // Reserve a cell for the insertion cursor, including the position after the last character.
  while (start < at && stringWidth(display.slice(start, at).join('')) + Math.max(1, stringWidth(display[at] ?? ' ')) > available) start++
  let end = start, used = 0
  while (end < display.length && used + stringWidth(display[end]) <= available) used += stringWidth(display[end++])
  const visible = display.slice(start, end)
  const padding = ' '.repeat(Math.max(0, available - used))
  const indexAt = (x: number) => {
    if (!ref.current) return at
    const column = Math.max(0, x - screenBox(ref.current).x - (size === 'large' ? 2 : 1))
    let index = start, cell = 0
    while (index < end && cell + stringWidth(display[index]) <= column) cell += stringWidth(display[index++])
    // Extend the viewport one character at a time while dragging outside it.
    if (column >= available && index < chars.length) index++
    if (column === 0 && start > 0) index = start - 1
    return index
  }
  useMouseEvents(event => {
    if (blocked || disabled || !isFocused) { dragging.current = false; return }
    if (!dragging.current) return
    if (event.action === 'move' || event.action === 'release') {
      if (event.action === 'move' && event.button !== 'left') { dragging.current = false; return }
      setCursor(indexAt(event.x))
      touchCursor()
      if (event.action === 'release') dragging.current = false
    }
  })
  useInput((input, key) => {
    if (key.eventType === 'release') return
    if (key.ctrl && key.shift && input.toLowerCase() === 'c') {
      copy(); return
    }
    if (key.return) return onSubmit?.(value)
    if (key.ctrl && input === 'a') {
      setAnchor(0); setCursor(chars.length); touchCursor(); return
    }
    if (key.leftArrow) return moveCursor(!key.shift && hasSelection ? selectionStart : Math.max(0, at - 1), key.shift)
    if (key.rightArrow) return moveCursor(!key.shift && hasSelection ? selectionEnd : Math.min(chars.length, at + 1), key.shift)
    if (key.home) return moveCursor(0, key.shift)
    if (key.end) return moveCursor(chars.length, key.shift)
    if (key.delete && !key.backspace) {
      if (hasSelection) return replaceSelection([])
      chars.splice(at, 1); onChange(chars.join('')); touchCursor(); return
    }
    if (key.backspace) {
      if (hasSelection) return replaceSelection([])
      if (at > 0) { chars.splice(at - 1, 1); onChange(chars.join('')); setCursor(at - 1); touchCursor() }
      return
    }
    if (key.ctrl || key.meta || key.escape || key.tab || key.upArrow || key.downArrow || key.pageUp || key.pageDown) return
    const clean = characters(input.replace(/[\x00-\x1f\x7f]/g, ''))
    if (clean.length) replaceSelection(clean)
  }, { isActive: !blocked && isFocused && !disabled })
  let hint = ''
  for (const char of characters(placeholder)) { if (stringWidth(hint + char) > available) break; hint += char }
  return <MouseRegion focusId={id} disabled={disabled} onPress={event => {
    if (event.button === 'right') { dragging.current = false; copy(); return }
    if (disabled || event.button !== 'left' || !ref.current) return
    const index = indexAt(event.x)
    dragging.current = true
    setAnchor(index); setCursor(index); touchCursor(); focus(id)
  }}><Box ref={ref} width={width} height={size === 'large' ? 3 : 1} paddingX={1} borderBackgroundColor={colors.surface} borderStyle={size === 'large' ? 'single' : undefined} borderColor={isFocused ? colors.primary : colors.border} backgroundColor={colors.surface}>
    <Text color={disabled ? colors.muted : colors.text} underline={size === 'small'} wrap="truncate">
      {!value && !isFocused ? <Text color={colors.muted}>{hint}{' '.repeat(available - stringWidth(hint))}</Text> : <>
        {visible.map((char, index) => {
          const position = start + index
          if (showCursor && position === at) return <Text key={index} backgroundColor={colors.text} color={colors.background}>{char}</Text>
          if (isFocused && position >= selectionStart && position < selectionEnd) return <Text key={index} backgroundColor={colors.active} color={colors.onPrimary}>{char}</Text>
          return char
        })}
        {showCursor && at === chars.length ? <><Text backgroundColor={colors.text} color={colors.background}>▏</Text>{padding.slice(1)}</> : padding}
      </>}
    </Text>
  </Box></MouseRegion>
}
