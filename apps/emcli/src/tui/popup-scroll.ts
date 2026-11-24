// SPDX-License-Identifier: MIT
import { useEffect, useRef, useState } from 'react'
import { useWindowSize } from 'ink'
import type { MouseEvent } from './mouse.js'
import type { OverlayPosition } from './overlay.js'

/** Maximum height includes the two border rows. Popup mouse handling bypasses modal regions. */
export function usePopupScroll(count: number, active: number, openKey: string | undefined, maxHeight = 12) {
  const screen = useWindowSize()
  const limit = Number.isFinite(maxHeight) ? Math.max(3, Math.floor(maxHeight)) : 12
  const capacity = Math.max(1, Math.min(Math.max(1, count), limit - 2, screen.rows - 3))
  const maximum = Math.max(0, count - capacity)
  const [stored, setStored] = useState(0)
  const offset = Math.min(stored, maximum)
  const drag = useRef<number | undefined>(undefined)
  const scroll = (next: number) => setStored(Math.max(0, Math.min(maximum, next)))
  useEffect(() => {
    drag.current = undefined
    if (!openKey) { setStored(0); return }
    setStored(previous => Math.max(0, Math.min(maximum, active < previous ? active : active >= previous + capacity ? active - capacity + 1 : previous)))
  }, [openKey, active, capacity, count])
  const inside = (event: MouseEvent, position: OverlayPosition, width: number) =>
    event.x >= position.left && event.x < position.left + width && event.y >= position.top && event.y < position.top + capacity + 2
  const indexAt = (event: MouseEvent, position: OverlayPosition, width: number) => {
    const row = event.y - position.top - 1
    if (row < 0 || row >= capacity || event.x <= position.left || event.x >= position.left + width - (maximum ? 2 : 1)) return undefined
    const index = offset + row
    return index < count ? index : undefined
  }
  const handleScroll = (event: MouseEvent, position: OverlayPosition, width: number) => {
    const thumb = Math.max(1, Math.floor(capacity * capacity / Math.max(1, count)))
    const travel = capacity - thumb
    const start = maximum ? Math.round(offset / maximum * travel) : 0
    if (drag.current !== undefined) {
      if (event.action === 'release') { drag.current = undefined; return true }
      if (event.action === 'move') {
        scroll(Math.round(Math.max(0, Math.min(travel, event.y - position.top - 1 - drag.current)) / Math.max(1, travel) * maximum))
        return true
      }
    }
    if (!inside(event, position, width)) return false
    if (event.action === 'wheel') { scroll(offset + (event.button === 'wheel-up' ? -3 : 3)); return true }
    const row = event.y - position.top - 1
    if (maximum && event.x === position.left + width - 2 && row >= 0 && row < capacity) {
      if (event.action === 'press' && event.button === 'left') {
        if (row >= start && row < start + thumb) drag.current = row - start
        else scroll(offset + (row < start ? -capacity : capacity))
      }
      return true
    }
    return false
  }
  return { screen, capacity, height: capacity + 2, offset, scroll, inside, indexAt, handleScroll }
}
