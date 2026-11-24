// SPDX-License-Identifier: MIT
import React, { useEffect, useRef, useState } from 'react'
import { Box } from 'ink'
import { Slider, type SliderProps } from './Slider.js'
import { TextInput } from './TextInput.js'

export interface SliderInputProps extends SliderProps {
  inputWidth?: number
  /** Decimal places (0–10). Omit to preserve variable decimal precision. */
  precision?: number
}
/** One-row numeric control: valid numeric drafts update immediately; Enter/blur normalizes the displayed value. */
export function SliderInput({ value, onChange, min = 0, max = 100, step, precision, width = 36, inputWidth = 10, disabled = false, autoFocus = false }: SliderInputProps) {
  const digits = precision === undefined || !Number.isFinite(precision) ? undefined : Math.max(0, Math.min(10, Math.trunc(precision)))
  const format = (number: number) => digits === undefined ? String(number) : number.toFixed(digits)
  const [draft, setDraft] = useState(() => format(value))
  const previousDigits = useRef(digits)
  const emitted = useRef<number | undefined>(undefined)
  useEffect(() => {
    // A controlled parent echo must not erase trailing decimal points or zeros.
    if (value !== emitted.current || digits !== previousDigits.current) setDraft(format(value))
    previousDigits.current = digits
    emitted.current = undefined
  }, [value, digits])
  const normalize = (next: number) => {
    const snapped = step !== undefined && step > 0 ? min + Math.round((next - min) / step) * step : next
    const upper = Math.max(min, max)
    const rounded = Number(Math.max(min, Math.min(upper, snapped)).toFixed(digits ?? 10))
    // Bounds take precedence when they are not representable at this precision.
    return Math.max(min, Math.min(upper, rounded))
  }
  const publish = (next: number) => {
    if (!disabled && next !== value) {
      emitted.current = next
      onChange(next)
    }
  }
  const apply = (next: number) => {
    const normalized = normalize(next)
    setDraft(format(normalized))
    publish(normalized)
  }
  const parse = (text: string) => /^-?(?:\d+\.?\d*|\.\d+)$/.test(text.trim()) ? Number(text) : NaN
  const edit = (text: string) => {
    if (disabled) return
    setDraft(text)
    const number = parse(text)
    if (Number.isFinite(number)) publish(normalize(number))
  }
  const commit = () => {
    if (disabled) return
    const number = parse(draft)
    if (!Number.isFinite(number)) { setDraft(format(value)); return }
    apply(number)
  }
  const total = Math.max(9, Math.floor(width))
  const field = Math.max(5, Math.min(Math.floor(inputWidth), total - 3))
  return <Box width={total} height={1} gap={1} flexShrink={0}>
    <Slider value={value} onChange={apply} min={min} max={max} step={step ?? (digits === undefined ? 0.1 : 10 ** -digits)} width={total - field - 1} disabled={disabled} autoFocus={autoFocus} />
    <TextInput size="small" width={field} value={draft} onChange={edit} onSubmit={commit} onBlur={commit} disabled={disabled} />
  </Box>
}
