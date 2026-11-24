// SPDX-License-Identifier: MIT
import React, { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { Box, Text, useWindowSize, type DOMElement } from 'ink'
import stringWidth from 'string-width'
import { MouseRegion, useMouseEvents } from '../mouse.js'
import { screenBox } from '../geometry.js'
import { NotificationInteractionBlocked } from '../interaction.js'
import { useClipboardCopy } from '../clipboard.js'
import { colors } from '../theme.js'
import { Button } from './Button.js'
import { Dialog } from './Dialog.js'
import { SelectableText } from './SelectableText.js'
export interface NotificationOptions { title?: string; severity?: 'information' | 'success' | 'warning' | 'error'; timeout?: number }
interface Notice extends NotificationOptions { id: number; message: string }
interface Notifications { notify(message: string, options?: NotificationOptions): number; dismiss(id: number): void }
const Context = createContext<Notifications | null>(null)
export function useNotifications(): Notifications { const context = useContext(Context); if (!context) throw new Error('useNotifications requires NotificationProvider'); return context }
export function useOptionalNotifications(): Notifications | null { return useContext(Context) }
export const useNotify = useNotifications
function Toast({notice,width,paused,onExpand,dismiss}:{notice:Notice;width:number;paused:boolean;onExpand(notice:Notice):void;dismiss(id:number):void}) {
  const root=useRef<DOMElement|null>(null)
  const [hovered,setHovered]=useState(false)
  const remaining=useRef(notice.timeout??5000)
  useMouseEvents(event=>{
    if(!root.current)return
    const box=screenBox(root.current)
    setHovered(event.x>=box.x&&event.x<box.x+box.width&&event.y>=box.y&&event.y<box.y+box.height)
  })
  useEffect(()=>{
    if(paused||hovered||(notice.timeout??5000)<=0)return
    const started=Date.now(),timer=setTimeout(()=>dismiss(notice.id),Math.max(0,remaining.current))
    return()=>{clearTimeout(timer);remaining.current=Math.max(0,remaining.current-(Date.now()-started))}
  },[paused,hovered,notice.id,notice.timeout,dismiss])
  const tone={ information: colors.primary, success: colors.success, warning: colors.warning, error: colors.danger }[notice.severity??'information']
  const truncated=/[\r\n]/.test(notice.message)||stringWidth(notice.message)>Math.max(0,width-4)
  return <Box ref={root} height={4} flexShrink={0} flexDirection="column" borderBackgroundColor={colors.panel} borderStyle="bold" borderColor={tone} backgroundColor={colors.panel} paddingX={1}>
    <Box height={1} gap={1}><Box flexGrow={1} flexBasis={0} minWidth={0}><Text bold color={tone} wrap="truncate">{notice.title??notice.severity??'Notification'}</Text></Box>
      {truncated?<Button size="small" label="Expand" onPress={()=>onExpand(notice)}/>:null}
      <MouseRegion onPress={()=>dismiss(notice.id)}><Text color={colors.subtle}>×</Text></MouseRegion>
    </Box>
    <Box height={1} overflow="hidden"><Text color={colors.text} wrap="truncate">{notice.message.replace(/[\r\n]+/g,' ')}</Text></Box>
  </Box>
}
function NotificationDetails({notice,onClose}:{notice:Notice;onClose():void}) {
  const {columns,rows}=useWindowSize()
  const copy=useClipboardCopy()
  const [status,setStatus]=useState('')
  const copySelection=async(text:string)=>{
    const result=await copy(text)
    setStatus(result==='failed'?'Could not copy to clipboard':result==='copied'?'Copied to clipboard':'Copy request sent to terminal')
  }
  return <Dialog title={notice.title??'Notification details'} width={Math.max(20,Math.min(100,columns-4))} onClose={onClose} cancelLabel="Close">
    <SelectableText text={notice.message} height={Math.max(1,Math.min(24,rows-13))} onCopy={text=>void copySelection(text)}/>
    {status?<Text color={colors.text} wrap="truncate">{status}</Text>:null}
  </Dialog>
}
export function NotificationProvider({ children }: { children: ReactNode }) {
  const [notices,setNotices]=useState<Notice[]>([])
  const [expanded,setExpanded]=useState<Notice>()
  const next=useRef(0)
  const {columns,rows}=useWindowSize()
  const dismiss=useCallback((id:number)=>{setNotices(items=>items.filter(item=>item.id!==id));setExpanded(item=>item?.id===id?undefined:item)},[])
  const notify=useCallback((message:string,options:NotificationOptions={})=>{
    const id=++next.current
    setNotices(items=>[...items,{...options,id,message}].slice(-3))
    return id
  },[])
  const visible=notices.slice(-Math.max(1,Math.floor((rows-2)/4)))
  const width=Math.max(12,Math.min(44,columns-2))
  return <Context.Provider value={{notify,dismiss}}>
    <NotificationInteractionBlocked.Provider value={Boolean(expanded)}>{children}
      <Box position="absolute" bottom={1} right={1} width={width} flexDirection="column">
        {visible.map(notice=><Toast key={notice.id} notice={notice} width={width} paused={Boolean(expanded)} dismiss={dismiss} onExpand={setExpanded}/>)}
      </Box>
    </NotificationInteractionBlocked.Provider>
    {expanded?<NotificationDetails key={expanded.id} notice={expanded} onClose={()=>setExpanded(undefined)}/>:null}
  </Context.Provider>
}
