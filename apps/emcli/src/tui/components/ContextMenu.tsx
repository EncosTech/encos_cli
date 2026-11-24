// SPDX-License-Identifier: MIT
import React, {useCallback, useEffect, useId, useRef, useState, type ReactNode} from 'react'
import {Box, Text, useFocusManager, useInput, type DOMElement} from 'ink'
import {useSpatialFocus, useNavigationRegion, useFocusWithin} from '../navigation.js'
import {useInteractionBlocked, InteractionBlocked} from '../interaction.js'
import {useMouseEvents} from '../mouse.js'
import {visibleBox} from '../geometry.js'
import {clampOverlay, useOverlay, type OverlayPosition} from '../overlay.js'
import {usePopupScroll} from '../popup-scroll.js'
import {Scrollbar} from './Scrollbar.js'
import {colors} from '../theme.js'
import type {MenuBarItem} from './MenuBar.js'

export interface ContextMenuProps {
 children: ReactNode
 items: MenuBarItem[]
 keyboardActive?: boolean
 restoreFocusId?: string
 onOpen?(): void
 maxHeight?: number
 stretch?: boolean
}
/** Right-click the wrapped content, or use Ctrl+Space while focused. */
export function ContextMenu({children,items,keyboardActive,restoreFocusId,onOpen,maxHeight=12,stretch=true}:ContextMenuProps) {
 const blocked=useInteractionBlocked(),ref=useRef<DOMElement|null>(null),id=useId()
 const {isFocused,focus}=useSpatialFocus({id,isActive:keyboardActive===undefined&&!blocked})
 useNavigationRegion(keyboardActive===undefined?id:undefined,ref,blocked)
 const within=useFocusWithin(ref),manager=useFocusManager(),restoreTo=useRef<string|undefined>(undefined)
 const {show,hide}=useOverlay()
 const [anchor,setAnchor]=useState<{x:number;y:number;height:number}>()
 const latest=useRef(items);latest.current=items
 const close=useCallback(()=>{setAnchor(undefined);hide()},[hide])
 const open=()=>{
  if(blocked||!items.length||!ref.current)return
  const box=visibleBox(ref.current);if(!box.width||!box.height)return
  restoreTo.current=restoreFocusId??manager.activeId;onOpen?.();setAnchor({x:box.x,y:box.y,height:box.height+1})
 }
 const active=()=>keyboardActive??(isFocused||within())
 useInput((input,key)=>{if(active()&&!anchor&&key.eventType!=='release'&&key.ctrl&&input===' ')open()},{isActive:!blocked&&keyboardActive!==false})
 useMouseEvents(event=>{
  if(blocked||anchor||!ref.current||event.action!=='press')return
  const box=visibleBox(ref.current)
  if(event.x>=box.x&&event.x<box.x+box.width&&event.y>=box.y&&event.y<box.y+box.height){if(event.button==='right')open();else if(event.button==='left'&&keyboardActive===undefined)focus(id)}
 })
 const signature=items.map(item=>`${item.id}:${item.label}:${item.disabled}:${item.checked}`).join('|')
 useEffect(()=>{
  if(!anchor)return
  show(<ContextPopup restoreTo={restoreTo.current} anchor={anchor} items={latest.current} onClose={close} maxHeight={maxHeight}/>,{top:0,left:0})
 },[anchor,signature,show,close,maxHeight])
 useEffect(()=>()=>hide(),[hide])
 useEffect(()=>{if(blocked)close()},[blocked,close])
 return <Box flexShrink={0} ref={ref} width={stretch?'100%':undefined} minWidth={0}><InteractionBlocked.Provider value={blocked||Boolean(anchor)}>{children}</InteractionBlocked.Provider></Box>
}
function ContextPopup({anchor,items,onClose,maxHeight,restoreTo}:{restoreTo?:string;anchor:{x:number;y:number;height:number};items:MenuBarItem[];onClose():void;maxHeight:number}) {
 const id=useId(),manager=useFocusManager(),previous=useRef(restoreTo??manager.activeId)
 const {isFocused,focus}=useSpatialFocus({id,autoFocus:true},['up','down','left','right'])
 const [active,setActive]=useState(()=>Math.max(0,items.findIndex(item=>!item.disabled&&!item.separator)))
 const popup=usePopupScroll(items.length,active,id,maxHeight)
 const width=Math.max(12,Math.min(30,popup.screen.columns))
 const position:OverlayPosition=clampOverlay(anchor,{width,height:popup.height},popup.screen)
 const indices=items.flatMap((item,i)=>!item.disabled&&!item.separator?[i]:[])
 useEffect(()=>{focus(id);return()=>{if(previous.current)queueMicrotask(()=>manager.focus(previous.current!))}},[])
 const activate=(index:number)=>{const item=items[index];if(!item||item.disabled||item.separator)return;onClose();item.onSelect?.()}
 useInput((input,key)=>{
  if(key.eventType==='release')return
  if(key.escape||key.tab){onClose();return}
  if(key.upArrow||key.downArrow){if(indices.length)setActive(indices[(Math.max(0,indices.indexOf(active))+(key.downArrow?1:-1)+indices.length)%indices.length]);return}
  if(key.pageUp||key.pageDown){if(indices.length)setActive(indices[Math.max(0,Math.min(indices.length-1,indices.indexOf(active)+(key.pageUp?-popup.capacity:popup.capacity)))]);return}
  if(key.return||input===' ')activate(active)
 },{isActive:isFocused})
 useMouseEvents(event=>{
  if(popup.handleScroll(event,position,width))return
  if(event.action==='press'&&!popup.inside(event,position,width)){onClose();return}
  const index=popup.indexAt(event,position,width)
  if(index===undefined)return
  if(event.action==='move'&&!items[index].disabled)setActive(index)
  if(event.action==='press'&&event.button==='left')activate(index)
 })
 return <Box position="absolute" left={position.left} top={position.top} width={width} borderStyle="single" borderColor={colors.active} backgroundColor={colors.surface} borderBackgroundColor={colors.surface}>
  <Box flexDirection="column" flexGrow={1} minWidth={0} height={popup.capacity}>{items.slice(popup.offset,popup.offset+popup.capacity).map((item,i)=><Text key={item.id} wrap="truncate" backgroundColor={active===i+popup.offset?colors.active:colors.surface} color={item.disabled?colors.muted:colors.text}>{item.separator?'─'.repeat(width-2):` ${item.checked?'✓ ':''}${item.label}`}</Text>)}</Box>
  <Scrollbar contentSize={items.length} viewportSize={popup.capacity} offset={popup.offset} onChange={popup.scroll}/>
 </Box>
}
