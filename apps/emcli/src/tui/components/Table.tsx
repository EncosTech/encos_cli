// SPDX-License-Identifier: MIT

import { useSpatialFocus } from '../navigation.js'

import { useInteractionBlocked } from '../interaction.js'

import React, { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Box, Text,  useInput } from 'ink'

import stringWidth from 'string-width'
import { Scrollbar } from './Scrollbar.js'
import { colors } from '../theme.js'
import { MouseRegion } from '../mouse.js'

export interface TableColumn<T> {
  key: string
  header: string
  width: number
  align?: 'left' | 'right'
  value: (row: T) => string | number
}

export interface TableProps<T> {
  columns: TableColumn<T>[]
  rows: T[]
  rowKey: (row: T, index: number) => string
  viewportWidth?:number
  height?: number
  autoFocus?: boolean
  onSelect?: (row: T, index: number) => void
  selectionKey?:string
  onRowClick?: (row:T,index:number)=>void
  onActivate?: (row:T,index:number)=>void
  sortColumn?:number
  onSort?: (column:number)=>void
  sortAscending?:boolean
  autoColumns?:boolean
  emptyText?: string
}

function fit(value: string, width: number, align: 'left' | 'right' = 'left'): string {
  const truncated=stringWidth(value)>width
  const limit=Math.max(0,width-(truncated?1:0))
  let text=''
  for(const {segment} of new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(value)){
    if(stringWidth(text+segment)>limit)break
    text+=segment
  }
  if(truncated&&width>0)text+='…'
  const padding=' '.repeat(Math.max(0,width-stringWidth(text)))
  return align==='right'?padding+text:text+padding
}

export function Table<T>({
  columns: inputColumns,
  rows,
  rowKey,
  height = 8, viewportWidth,
  autoFocus = false,
  onSelect, onActivate, onRowClick, selectionKey, onSort, sortColumn, sortAscending=true, autoColumns=false,
  emptyText = 'No data',
}: TableProps<T>) {
  height = Math.max(1, Math.min(rows.length||1, Math.floor(height)))
  const peaks=useRef(new Map<string,number>())
  const columns=useMemo(()=>{
    if(!autoColumns)return inputColumns
    const minimum=inputColumns.map(c=>stringWidth(c.header)+(onSort?2:0))
    const widths=inputColumns.map((c,i)=>{
      const content=Math.max(minimum[i],...rows.map(row=>stringWidth(String(c.value(row)))))
      const peak=Math.max(content,peaks.current.get(c.key)??0);peaks.current.set(c.key,peak)
      return Math.min(Math.max(minimum[i],48),peak)
    })
    let excess=widths.reduce((sum,w)=>sum+w+2,0)+3-(viewportWidth??Infinity)
    while(excess>0){let candidate=-1;for(let i=0;i<widths.length;i++)if(widths[i]>minimum[i]&&(candidate<0||widths[i]-minimum[i]>widths[candidate]-minimum[candidate]))candidate=i;if(candidate<0)break;widths[candidate]--;excess--}
    return inputColumns.map((c,i)=>({...c,width:widths[i]}))
  },[inputColumns,rows,autoColumns,viewportWidth,Boolean(onSort)])
  const blocked = useInteractionBlocked()
  const id = useId()
  const [horizontal,setHorizontal]=useState(0)
  const [selected, setSelected] = useState(0)
  const { isFocused, focus } = useSpatialFocus({ id, autoFocus, isActive: !blocked }, [...((viewportWidth!==undefined)?['left' as const,'right' as const]:[]), ...(selected > 0 ? ['up' as const] : []), ...(selected < rows.length - 1 ? ['down' as const] : [])])
  const [offset, setOffset] = useState(0)
  const [hovered, setHovered] = useState<number | undefined>(undefined)
  useEffect(()=>{setSelected(0);setOffset(0);setHorizontal(0)},[selectionKey])
  const totalWidth = useMemo(() => columns.reduce((sum, column) => sum + column.width + 2, 0), [columns])

  const maxHorizontal=Math.max(0,totalWidth+3-(viewportWidth??totalWidth+3))
  useEffect(()=>setHorizontal(old=>Math.min(old,maxHorizontal)),[maxHorizontal])
  useEffect(()=>{
    if(sortColumn===undefined||viewportWidth===undefined)return
    const left=columns.slice(0,sortColumn).reduce((sum,c)=>sum+c.width+2,0),right=left+(columns[sortColumn]?.width??0)+2
    setHorizontal(old=>Math.max(0,Math.min(maxHorizontal,left<old?left:right>old+viewportWidth-2?right-viewportWidth+2:old)))
  },[sortColumn,viewportWidth,maxHorizontal])
  useEffect(() => {
    setSelected(value => Math.min(value, Math.max(0, rows.length - 1)))
    setOffset(current => Math.max(0, Math.min(Math.max(0, rows.length - height), selected < current ? selected : selected >= current + height ? selected - height + 1 : current)))
  }, [selected, height, rows.length])

  useEffect(() => {
    const row = rows[selected]
    if (row !== undefined) onSelect?.(row, selected)
  }, [selected, rows, onSelect])

  useInput(
    (_input, key) => {
      if(key.eventType==='release')return
      if(viewportWidth!==undefined&&key.leftArrow)setHorizontal(old=>Math.max(0,old-4))
      if(viewportWidth!==undefined&&key.rightArrow)setHorizontal(old=>Math.min(maxHorizontal,old+4))
      if(key.return&&rows[selected]){onActivate?.(rows[selected],selected);return}
      if (rows.length === 0) return
      if (key.upArrow) setSelected(current => Math.max(0, current - 1))
      else if (key.downArrow) setSelected(current => Math.min(rows.length - 1, current + 1))
      else if (key.pageUp) setSelected(current => Math.max(0, current - height))
      else if (key.pageDown) setSelected(current => Math.min(rows.length - 1, current + height))
      else if (key.home) setSelected(0)
      else if (key.end) setSelected(rows.length - 1)
    },
    { isActive: !blocked && isFocused },
  )

  if (rows.length === 0) {
    return <Text color={colors.muted}>{emptyText}</Text>
  }

  const scroll = (next: number) => setOffset(Math.max(0, Math.min(Math.max(0, rows.length - height), next)))
  const visible = rows.slice(offset, offset + height)
  const separator = '─'.repeat(totalWidth)
  return (
    <Box width={viewportWidth} flexDirection="column" overflow="hidden" flexShrink={0}><Box marginLeft={-horizontal} flexShrink={0}>
    <MouseRegion onWheel={rows.length > height ? event => scroll(offset + (event.button === 'wheel-up' ? -3 : 3)) : undefined}><Box
      flexShrink={0}
      flexDirection="column"
      width={totalWidth + 2 + (rows.length > height ? 1 : 0)}
      borderBackgroundColor={colors.surface} borderStyle={isFocused ? 'bold' : 'single'}
      borderColor={isFocused ? colors.borderFocus : colors.border}
      paddingX={0}
    >
      <Box backgroundColor={colors.panel}>
        {columns.map((column,index) => onSort?<ColumnHeader key={column.key} label={fit(column.header+(sortColumn===index?(sortAscending?' ▲':' ▼'):'  '),column.width,column.align)} width={column.width+2} onSort={()=>onSort(index)} onFocus={()=>{
          if(viewportWidth===undefined)return
          const left=columns.slice(0,index).reduce((sum,c)=>sum+c.width+2,0),right=left+column.width+2
          setHorizontal(old=>Math.max(0,Math.min(maxHorizontal,left<old?left:right>old+viewportWidth-2?right-viewportWidth+2:old)))
        }}/>:<Box key={column.key} width={column.width+2} paddingX={1}><Text color={colors.text} bold wrap="truncate">{fit(column.header,column.width,column.align)}</Text></Box>)}
      </Box>
      <Text color={colors.border}>{separator}</Text>
      <Box height={height} overflow="hidden"><Box flexDirection="column" width={totalWidth}>{visible.map((row, index) => {
        const absolute = offset + index
        const active = absolute === selected
        return (
          <MouseRegion focusId={id}
            key={rowKey(row, absolute)}
            stretch
            onHover={() => setHovered(absolute)}
            onLeave={() => setHovered(value => (value === absolute ? undefined : value))}
            onPress={event => {
              if(event.button!=='left')return
              focus(id)
              setSelected(absolute)
              onRowClick?.(row,absolute)
            }}
          >
            <Box height={1} flexShrink={0} backgroundColor={active ? (isFocused ? colors.active : colors.selected) : absolute === hovered ? colors.hover : colors.surface}>
              {columns.map(column => (
                <Box key={column.key} width={column.width + 2} paddingX={1}>
                  <Text wrap="truncate" color={active ? colors.onPrimary : absolute === hovered ? colors.text : colors.subtle}>
                    {fit(String(column.value(row)), column.width, column.align)}
                  </Text>
                </Box>
              ))}
            </Box>
          </MouseRegion>
        )
      })}</Box><Scrollbar contentSize={rows.length} viewportSize={height} offset={offset} onChange={scroll} /></Box>
    </Box></MouseRegion></Box>{maxHorizontal>0?<Scrollbar orientation="horizontal" contentSize={totalWidth+3} viewportSize={viewportWidth!} offset={horizontal} onChange={setHorizontal}/>:null}</Box>
  )
}

function ColumnHeader({label,width,onSort,onFocus}:{label:string;width:number;onSort:()=>void;onFocus:()=>void}){
 const id=useId(),blocked=useInteractionBlocked(),{isFocused,focus}=useSpatialFocus({id,isActive:!blocked})
 const current=useRef(onFocus);current.current=onFocus
 useEffect(()=>{if(isFocused)current.current()},[isFocused])
 useInput((_input,key)=>{if(key.return&&!key.ctrl&&!key.meta&&key.eventType!=='release')onSort()},{isActive:isFocused&&!blocked})
 return <MouseRegion focusId={id} onPress={event=>{if(event.button==='left'){focus(id);onSort()}}}><Box width={width} height={1} paddingX={1}><Text bold inverse={isFocused} color={colors.text} wrap="truncate">{label}</Text></Box></MouseRegion>
}
