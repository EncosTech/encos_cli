// SPDX-License-Identifier: MIT

import React, { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Box, Text, useBoxMetrics, useInput, type DOMElement } from 'ink'

import stringWidth from 'string-width'

import { colors } from '../theme.js'
import {MouseRegion} from '../mouse.js'
import {useSpatialFocus} from '../navigation.js'
import {useInteractionBlocked} from '../interaction.js'

import type { ChartPoint, ChartSeries, ChartStore } from '../chart-store.js'
export type { ChartPoint, ChartSeries } from '../chart-store.js'

export interface ChartYAxis {
  id: string
  label?: string
  position?: 'left' | 'right'
  color?: string
  min?: number
  max?: number
}

export interface LineChartProps {
  series?: readonly ChartSeries[]
  store?: ChartStore
  width?: number
  height?: number
  /** Wall-clock window for timestamped points. */
  windowMs?: number
  /** Controlled wall-clock time for replay/testing; disables the internal clock. */
  now?: number
  refreshIntervalMs?: number
  yAxes?: readonly ChartYAxis[]
  /** Fixed legend cell width; defaults to the longest label plus a value field. */
  legendItemWidth?: number
  yMin?: number
  yMax?: number
  /** Stable series IDs (label fallback) excluded from drawing and autoscaling. */
  hiddenSeriesIds?: readonly string[]
  onHiddenSeriesChange?: (ids: string[]) => void
  showLegend?: boolean
  showAxis?: boolean
  title?: string
}
const EMPTY: readonly ChartSeries[] = []
const noSubscribe = () => () => {}
const emptySnapshot = () => EMPTY

interface Segment {
  text: string
  color: string
}

const BRAILLE_BITS: Record<string, number> = {
  '0,0': 0x01,
  '0,1': 0x02,
  '0,2': 0x04,
  '0,3': 0x40,
  '1,0': 0x08,
  '1,1': 0x10,
  '1,2': 0x20,
  '1,3': 0x80,
}

function fit(text: string, width: number): string {
  let result = ''
  for (const {segment} of new Intl.Segmenter(undefined, {granularity:'grapheme'}).segment(text)) {
    if (stringWidth(result + segment) > width) break
    result += segment
  }
  return result + ' '.repeat(Math.max(0, width - stringWidth(result)))
}

function formatTick(value: number): string {
  const abs = Math.abs(value)
  if (abs > 0 && abs < 0.01) return value.toExponential(1)
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  if (abs >= 100) return value.toFixed(0)
  if (abs >= 10) return value.toFixed(1)
  return value.toFixed(2)
}

// Choose decimal intervals that remain legible at the available terminal resolution.
function ticks(min: number, max: number, count: number): number[] {
  const raw = (max - min) / Math.max(1, count - 1)
  const power = 10 ** Math.floor(Math.log10(raw))
  const step = ([1, 2, 2.5, 5, 10].find(value => value * power >= raw) ?? 10) * power
  if (!Number.isFinite(step) || step <= 0) return []
  const first = Math.ceil(min / step - 1e-10)
  const last = Math.floor(max / step + 1e-10)
  return Array.from({length: Math.max(0, Math.min(100, last - first + 1))}, (_, index) =>
    Number(((first + index) * step).toPrecision(12)))
}

function pointLine(
  from: { x: number; y: number },
  to: { x: number; y: number },
): Array<{ x: number; y: number }> {
  const points: Array<{ x: number; y: number }> = []
  let x0 = from.x
  let y0 = from.y
  const x1 = to.x
  const y1 = to.y
  const dx = Math.abs(x1 - x0)
  const sx = x0 < x1 ? 1 : -1
  const dy = -Math.abs(y1 - y0)
  const sy = y0 < y1 ? 1 : -1
  let error = dx + dy
  for (let guard = 0; guard < 4096; guard += 1) {
    points.push({ x: x0, y: y0 })
    if (x0 === x1 && y0 === y1) break
    const doubled = 2 * error
    if (doubled >= dy) {
      error += dy
      x0 += sx
    }
    if (doubled <= dx) {
      error += dx
      y0 += sy
    }
  }
  return points
}

function groupSegments(cells: Array<{ char: string; color: string }>): Segment[] {
  const segments: Segment[] = []
  for (const cell of cells) {
    const last = segments[segments.length - 1]
    if (last !== undefined && last.color === cell.color) {
      last.text += cell.char
    } else {
      segments.push({ text: cell.char, color: cell.color })
    }
  }
  return segments
}

function LegendItem({hidden,color,children,onToggle}:{hidden:boolean;color:string;children:React.ReactNode;onToggle:()=>void}) {
  const id=useId(),blocked=useInteractionBlocked()
  const {isFocused,focus}=useSpatialFocus({id,isActive:!blocked})
  const [hovered,setHovered]=useState(false)
  useInput((input,key)=>{if(!key.ctrl&&!key.meta&&key.eventType!=='release'&&(key.return||input===' '))onToggle()},{isActive:!blocked&&isFocused})
  return <MouseRegion focusId={id} onHover={()=>setHovered(true)} onLeave={()=>setHovered(false)} onPress={event=>{if(event.button==='left'&&!blocked){focus(id);onToggle()}}}>
    <Text color={hidden?colors.muted:color} inverse={isFocused} underline={hovered} wrap="truncate">{hidden?'□':'■'} {children}</Text>
  </MouseRegion>
}
const seriesId=(item:ChartSeries)=>item.id??item.label

export function LineChart({
  series, store, width, height, windowMs = 10000, now, refreshIntervalMs = 50,
  hiddenSeriesIds, onHiddenSeriesChange, yAxes, legendItemWidth, yMin, yMax, showLegend = true, showAxis = true, title,
}: LineChartProps) {
  const injected = useSyncExternalStore(store?.subscribe ?? noSubscribe, store?.getSnapshot ?? emptySnapshot, store?.getSnapshot ?? emptySnapshot)
  const data = store ? injected : series ?? EMPTY
  const [internalHidden,setInternalHidden]=useState<string[]>([])
  const hidden=hiddenSeriesIds??internalHidden
  const toggle=(id:string)=>{
    const next=hidden.includes(id)?hidden.filter(key=>key!==id):[...hidden,id]
    if(hiddenSeriesIds===undefined)setInternalHidden(next)
    onHiddenSeriesChange?.(next)
  }
  const root = useRef<DOMElement | null>(null)
  const metrics = useBoxMetrics(root)
  const measuredWidth = Math.max(1, Math.floor(width ?? (metrics.hasMeasured ? metrics.width : 64)))
  const measuredHeight = Math.max(1, Math.floor(height ?? (metrics.hasMeasured ? metrics.height : 12)))
  const timed = Boolean(store) || data.some(item => item.data.some(value => typeof value !== 'number'))
  const duration = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 10000
  const [clock, setClock] = useState(Date.now)
  useEffect(() => {
    if (!timed || now !== undefined) return
    setClock(Date.now())
    const timer = setInterval(() => setClock(Date.now()), Math.max(16, Number.isFinite(refreshIntervalMs) ? refreshIntervalMs : 50))
    return () => clearInterval(timer)
  }, [timed, now, refreshIntervalMs])
  const endTime = now ?? clock
  const chart = useMemo(() => {
    const inferredIds = [...new Set(data.map(item => item.yAxisId ?? 'default'))]
    const axes: readonly ChartYAxis[] = yAxes?.length ? yAxes : (inferredIds.length ? inferredIds : ['default'])
      .map((id, index) => ({id, position: index === 0 ? 'left' : 'right'}))
    if (new Set(axes.map(axis => axis.id)).size !== axes.length) throw new Error('Y axis IDs must be unique')
    const axisId = (item: ChartSeries) => item.yAxisId ?? axes[0].id
    for (const item of data) if (!axes.some(axis => axis.id === axisId(item))) throw new Error(`Unknown Y axis: ${axisId(item)}`)
    const axisWidth = showAxis ? Math.min(9, Math.max(0, Math.floor((measuredWidth - 2) / axes.length))) : 0
    const left = axes.filter(axis => axis.position !== 'right')
    const right = axes.filter(axis => axis.position === 'right')
    const gutter = axisWidth * left.length
    const plotWidth = Math.max(1, measuredWidth - axisWidth * axes.length)
    const axisRows = showAxis ? 1 : 0
    const headerRows = showAxis && (axes.length > 1 || axes.some(axis => axis.label)) ? 1 : 0
    const desiredCellWidth = legendItemWidth !== undefined && Number.isFinite(legendItemWidth)
      ? Math.max(8, Math.floor(legendItemWidth)) : Math.max(16, ...data.map(item => stringWidth(item.label) + 14))
    const cellWidth = Math.min(measuredWidth, desiredCellWidth)
    const legendColumns = Math.max(1, Math.floor(measuredWidth / cellWidth))
    const requestedLegendRows = showLegend ? Math.ceil(data.length / legendColumns) : 0
    const availableLegendRows = Math.max(0, measuredHeight - (title !== undefined ? 1 : 0) - axisRows - headerRows - 3)
    const legendRows = Math.min(requestedLegendRows, availableLegendRows)
    const hiddenLegend = requestedLegendRows > legendRows
    const plotHeight = Math.max(0, measuredHeight - legendRows - (title !== undefined ? 1 : 0) - axisRows - headerRows)
    const dotWidth = plotWidth * 2, dotHeight = Math.max(1, plotHeight * 4)
    const visible = data.map(item => {
      const points = item.data.map((point, index) => typeof point === 'number'
        ? {x: item.data.length <= 1 ? 0.5 : index / (item.data.length - 1), value: point}
        : {x: (point.timestamp - (endTime - duration)) / duration, value: point.value})
        .filter(point => Number.isFinite(point.x) && point.x >= 0 && point.x <= 1)
        .sort((a,b) => a.x - b.x)
      return {...item, points}
    })
    let hasSamples = false
    const scales = new Map(axes.map((axis, index) => {
      let low = Infinity, high = -Infinity
      for (const item of visible) if (!hidden.includes(seriesId(item)) && axisId(item) === axis.id) for (const point of item.points) {
        if (Number.isFinite(point.value)) { low = Math.min(low, point.value); high = Math.max(high, point.value) }
      }
      if (Number.isFinite(low)) hasSamples = true
      else { low = 0; high = 0 }
      const padding = high === low ? Math.max(1, Math.abs(low) * 0.08) : (high - low) * 0.08
      const lower = axis.min ?? (index === 0 ? yMin : undefined)
      const upper = axis.max ?? (index === 0 ? yMax : undefined)
      const min = Number.isFinite(lower) ? lower! : low - padding
      let max = Number.isFinite(upper) ? upper! : high + padding
      if (max <= min) max = min + 1
      const labels = new Map<number, string>()
      for (const value of ticks(min, max, Math.max(2, Math.floor(plotHeight / 3) + 1))) {
        labels.set(Math.round((max - value) / (max - min) * Math.max(0, plotHeight - 1)), formatTick(value))
      }
      return [axis.id, {min, max, range: max - min, labels}] as const
    }))
    const cellBits = new Map<number, number>(), cellColor = new Map<number, string>()
    const paint = (point: {x:number;y:number}, color:string) => {
      if (point.x < 0 || point.x >= dotWidth || point.y < 0 || point.y >= dotHeight) return
      const key = Math.floor(point.y / 4) * plotWidth + Math.floor(point.x / 2)
      cellBits.set(key, (cellBits.get(key) ?? 0) | BRAILLE_BITS[`${point.x % 2},${point.y % 4}`])
      cellColor.set(key, color)
    }
    for (const item of visible) {
      if(hidden.includes(seriesId(item)))continue
      const {min, range} = scales.get(axisId(item))!
      // Keep extrema and endpoints in each pixel column; do not erase narrow spikes.
      let previous: {x:number;y:number} | undefined
      let bucket: Array<{x:number;value:number}> = []
      let column = -1
      const flush = () => {
        if (!bucket.length) return
        let minimum = 0, maximum = 0
        bucket.forEach((point,index) => { if (point.value < bucket[minimum].value) minimum=index; if (point.value > bucket[maximum].value) maximum=index })
        for (const index of [...new Set([0,minimum,maximum,bucket.length-1])].sort((a,b)=>a-b)) {
          const point = bucket[index]
          const plotted = { x: Math.round(point.x * (dotWidth - 1)),
            y: Math.round(Math.max(-dotHeight, Math.min(dotHeight * 2, (1 - (point.value - min) / range) * (dotHeight - 1)))) }
          if (previous) for (const pixel of pointLine(previous, plotted)) paint(pixel,item.color)
          else paint(plotted,item.color)
          previous = plotted
        }
        bucket = []
      }
      for (const point of item.points) {
        if (!Number.isFinite(point.value)) { flush(); previous=undefined; column=-1; continue }
        const nextColumn = Math.round(point.x * (dotWidth - 1))
        if (nextColumn !== column) { flush(); column=nextColumn }
        bucket.push(point)
      }
      flush()
    }
    const rows: Segment[][] = []
    for (let row=0; row<plotHeight; row++) {
      const cells: Array<{char:string;color:string}> = []
      for (let col=0; col<plotWidth; col++) {
        const key=row*plotWidth+col, bits=cellBits.get(key)??0
        cells.push({char:String.fromCodePoint(0x2800+bits),color:cellColor.get(key)??colors.border})
      }
      rows.push(groupSegments(cells))
    }
    const lastValues = visible.map(item => {
      const last = [...item.points].reverse().find(point=>Number.isFinite(point.value))
      return last ? formatTick(last.value) : '-'
    })
    const xLabels = Array<string>(plotWidth).fill(' ')
    let occupied = -2
    const xMin = timed ? -duration / 1000 : 0
    const xMax = timed ? 0 : Math.max(1, ...data.map(item => item.data.length - 1))
    for (const value of ticks(xMin, xMax, Math.max(2, Math.floor(plotWidth / 10)))) {
      const label = `${value}${timed ? 's' : ''}`
      const col = Math.round((value - xMin) / (xMax - xMin) * (plotWidth - 1))
      const start = Math.max(0, Math.min(plotWidth - label.length, col - Math.floor(label.length / 2)))
      if (start <= occupied + 1 || label.length > plotWidth) continue
      for (let i = 0; i < label.length; i++) xLabels[start + i] = label[i]
      occupied = start + label.length - 1
    }
    return {rows,gutter,plotWidth,plotHeight,hasSamples,lastValues,axisRows,headerRows,left,right,axisWidth,scales,cellWidth,legendColumns,legendRows,hiddenLegend,timeline:xLabels.join('')}
  }, [data, hidden, measuredWidth, measuredHeight, duration, endTime, timed, yAxes, legendItemWidth, yMin, yMax, showAxis, showLegend, title])
  return <Box ref={root} width={width} height={height} flexGrow={height === undefined ? 1 : 0}
    flexBasis={height === undefined ? 0 : undefined} flexShrink={height === undefined ? 1 : 0}
    minWidth={0} minHeight={0} flexDirection="column" overflow="hidden" backgroundColor={colors.background}>
    <Box position="absolute" top={0} left={0} width={measuredWidth} height={measuredHeight} flexDirection="column" overflow="hidden">
      {title !== undefined ? <Text bold color={colors.text} wrap="truncate">{title}</Text> : null}
      {chart.headerRows ? <Box height={1} flexShrink={0}>
        {chart.left.map(axis => <Text key={axis.id} color={axis.color ?? colors.muted}>{fit(axis.label ?? axis.id, chart.axisWidth)}</Text>)}
        <Text>{' '.repeat(chart.plotWidth)}</Text>
        {chart.right.map(axis => <Text key={axis.id} color={axis.color ?? colors.muted}>{fit(axis.label ?? axis.id, chart.axisWidth)}</Text>)}
      </Box> : null}
      {chart.rows.map((segments,row) => {
        const axisText = (axis: ChartYAxis, right: boolean) => {
          if (!chart.axisWidth) return null
          const label = chart.scales.get(axis.id)!.labels.get(row) ?? ''
          const text = fit(label, Math.max(0, chart.axisWidth - 2))
          return <Text key={axis.id} color={axis.color ?? colors.muted}>{chart.axisWidth < 2 ? '│'
            : right ? `${label ? '├' : '│'} ${text}` : `${text.trim().padStart(chart.axisWidth - 2)} ${label ? '┤' : '│'}`}</Text>
        }
        return <Box key={row} height={1} flexShrink={0}>
          {chart.left.map(axis => axisText(axis, false))}
          <Box width={chart.plotWidth} height={1} flexShrink={0}>
            {!chart.hasSamples && row === 0 ? <Text color={colors.muted} wrap="truncate">{data.length&&data.every(item=>hidden.includes(seriesId(item)))?'No visible series':'No samples'}</Text> : <Text wrap="truncate">{segments.map((segment,index)=><Text key={index} color={segment.color}>{segment.text}</Text>)}</Text>}
          </Box>
          {chart.right.map(axis => axisText(axis, true))}
        </Box>
      })}
      {chart.axisRows ? <Text color={colors.muted} wrap="truncate">{' '.repeat(chart.gutter)}{chart.timeline}</Text> : null}
      {Array.from({length: chart.legendRows}, (_, row) => <Box key={row} height={1} flexShrink={0}>
        {chart.hiddenLegend && row === chart.legendRows - 1 ? <Text color={colors.muted} wrap="truncate">{data.length - row * chart.legendColumns} more series · Enlarge chart to show all</Text> : data.slice(row * chart.legendColumns, (row + 1) * chart.legendColumns).map((item, column) => {
          const index = row * chart.legendColumns + column
          const valueWidth = Math.min(10, Math.max(1, chart.cellWidth - 6))
          const labelWidth = Math.max(0, chart.cellWidth - valueWidth - 4)
          return <LegendItem key={seriesId(item)} color={item.color} hidden={hidden.includes(seriesId(item))} onToggle={()=>toggle(seriesId(item))}>{fit(item.label, labelWidth)} <Text color={colors.muted}>{fit(chart.lastValues[index], valueWidth)}</Text> </LegendItem>
        })}
      </Box>)}
    </Box>
  </Box>
}
