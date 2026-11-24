// SPDX-License-Identifier: MIT

import { useInteractionBlocked } from './interaction.js'
import { screenBox, visibleBox } from './geometry.js'
import React, { createContext, useContext, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import { useFocus, useFocusManager, useInput, type DOMElement } from 'ink'
type Direction = 'left' | 'right' | 'up' | 'down'
type Entry = { id: string; ref: React.RefObject<DOMElement | null> }
const RestoreIntent = createContext<React.RefObject<string|undefined>|null>(null)
const Registry = createContext<Set<Entry> | null>(null)
type Control = { active: boolean; reserved: Direction[] }
const FocusScopeControls = createContext<Map<string, React.RefObject<Control>> | null>(null)
const Controls = createContext<Map<string, React.RefObject<Control>> | null>(null)
function contains(parent: DOMElement, child: DOMElement) {
  for (let node: DOMElement | undefined = child; node; node = node.parentNode) if (node === parent) return true
  return false
}
function scrollParent(node: DOMElement) {
  for (let parent = node.parentNode; parent; parent = parent.parentNode)
    if (parent.style.contentOffsetY !== undefined || parent.style.contentOffsetX !== undefined) return parent
  return undefined
}
export function NavigationProvider({ children }: { children: ReactNode }) {
  const restoring=useRef<string|undefined>(undefined)
  const entries = useRef(new Set<Entry>())
  const controls = useRef(new Map<string, React.RefObject<Control>>())
  const { activeId, focus } = useFocusManager()
  const current = useRef(activeId)
  useLayoutEffect(() => { current.current = activeId;if(activeId===restoring.current)restoring.current=undefined }, [activeId])
  useInput((_input, key) => {
    if (key.eventType === 'release') return
    const direction: Direction | undefined = key.leftArrow ? 'left' : key.rightArrow ? 'right' : key.upArrow ? 'up' : key.downArrow ? 'down' : undefined
    const sourceId = current.current
    if (!direction || !sourceId) return
    const control = controls.current.get(sourceId)?.current
    if (!control?.active || control.reserved.includes(direction)) return
    const registered = [...entries.current].filter(entry => entry.ref.current && controls.current.get(entry.id)?.current.active)
    let best: { id: string; score: number } | undefined
    for (const source of registered.filter(entry => entry.id === sourceId)) {
      const node = source.ref.current!, sourceBox = screenBox(node), scope = scrollParent(node)
      for (const target of registered) {
        const targetNode = target.ref.current!
        if (target.id === sourceId || contains(targetNode, node)) continue
        const local = scope !== undefined && contains(scope, targetNode) && visibleBox(scope).height > 0 && visibleBox(scope).width > 0
        const box = local ? screenBox(targetNode) : visibleBox(targetNode)
        if (!box.width || !box.height) continue
        const dx = box.x + box.width / 2 - sourceBox.x - sourceBox.width / 2
        const dy = box.y + box.height / 2 - sourceBox.y - sourceBox.height / 2
        const along = direction === 'right' ? dx : direction === 'left' ? -dx : direction === 'down' ? dy : -dy
        if (along <= 0) continue
        const horizontal = direction === 'left' || direction === 'right'
        const overlap = horizontal ? box.y < sourceBox.y + sourceBox.height && sourceBox.y < box.y + box.height : box.x < sourceBox.x + sourceBox.width && sourceBox.x < box.x + box.width
        const score = (scope && !local ? 100000 : 0) + (overlap ? 0 : 10000) + along + Math.abs(horizontal ? dy : dx) * 3
        if (!best || score < best.score) best = { id: target.id, score }
      }
    }
    if (best) {
      // One dispatcher and a synchronous cursor preserve every event in a repeat burst.
      current.current = best.id
      focus(best.id)
    }
  })
  return <RestoreIntent.Provider value={restoring}><Registry.Provider value={entries.current}><Controls.Provider value={controls.current}>{children}</Controls.Provider></Registry.Provider></RestoreIntent.Provider>
}
export function useNavigationRegion(id: string | undefined, ref: React.RefObject<DOMElement | null>, disabled: boolean) {
  const entries = useContext(Registry)
  useEffect(() => {
    if (!entries || !id || disabled) return
    const entry = { id, ref }; entries.add(entry)
    return () => { entries.delete(entry) }
  }, [entries, id, ref, disabled])
}
export function useSpatialFocus(options: { id: string; autoFocus?: boolean; isActive?: boolean }, reserved: Direction[] = []) {
  const result = useFocus(options)
  const manager = useFocusManager()
  const restoring=useContext(RestoreIntent)
  const scope = useContext(FocusScopeControls)
  const latest = useRef({active: options.isActive !== false, activeId: manager.activeId})
  latest.current = {active: options.isActive !== false, activeId: manager.activeId}
  useEffect(() => {
    if (!options.autoFocus || options.isActive === false || manager.activeId) return
    // Ink autoFocus only runs at registration. Recover after a loading overlay
    // deactivated an existing control without re-registering it or changing Tab order.
    // Restore-on-close runs first; only fill a genuinely empty focus afterward.
    const timer=setTimeout(() => {
      if(latest.current.active && !latest.current.activeId){
        const target=restoring?.current
        result.focus(target&&controls?.get(target)?.current.active?target:options.id)
      }
    },0)
    return ()=>clearTimeout(timer)
  }, [options.autoFocus, options.isActive, options.id, manager.activeId, result.focus])
  const controls = useContext(Controls)
  const state = useRef<Control>({ active: options.isActive !== false, reserved })
  state.current = { active: options.isActive !== false, reserved }
  useEffect(() => {
    controls?.set(options.id, state)
    scope?.set(options.id, state)
    return () => { controls?.delete(options.id); scope?.delete(options.id) }
  }, [controls, scope, options.id])
  return result
}

export function useFocusedElements() {
  const entries = useContext(Registry)
  const { activeId } = useFocusManager()
  return { activeId, elements: () => [...(entries ?? [])].filter(entry => entry.id === activeId).map(entry => entry.ref.current).filter((node): node is DOMElement => node !== null) }
}

/** Check the current focus at event time, after descendant regions have mounted. */
export function useFocusWithin(ref: React.RefObject<DOMElement | null>) {
  const entries = useContext(Registry)
  const {activeId} = useFocusManager()
  return () => Boolean(ref.current && activeId && [...(entries ?? [])].some(entry => entry.id === activeId && entry.ref.current && contains(ref.current!, entry.ref.current)))
}

/** A modal starts at its first enabled control and resumes its prior control after nesting. */
export function InitialFocusScope({children}:{children:ReactNode}){
 const controls=useRef(new Map<string,React.RefObject<Control>>())
 const {activeId,focus}=useFocusManager(),blocked=useInteractionBlocked()
 const last=useRef<string|undefined>(undefined),initialized=useRef(false)
 useLayoutEffect(()=>{if(activeId&&controls.current.has(activeId))last.current=activeId},[activeId])
 useEffect(()=>{
  if(blocked)return
  if(initialized.current&&activeId&&controls.current.get(activeId)?.current.active)return
  const target=last.current&&controls.current.get(last.current)?.current.active?last.current:[...controls.current].find(([,control])=>control.current.active)?.[0]
  if(target){initialized.current=true;focus(target)}
 },[blocked,activeId,focus])
 return <FocusScopeControls.Provider value={controls.current}>{children}</FocusScopeControls.Provider>
}
export function useRestoreFocus(){
 const {activeId,focus}=useFocusManager()
 const previous=useRef(activeId),restoring=useContext(RestoreIntent)
 useEffect(()=>()=>{
  const target=previous.current
  if(!target)return
  // Keep the intent until Ink commits the restored focus. Auto-focus recovery
  // must not replace it with the first control during the same React batch.
  if(restoring)restoring.current=target
  setTimeout(()=>focus(target),0)
 },[focus,restoring])
}
