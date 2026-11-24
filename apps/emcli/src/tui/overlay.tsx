// SPDX-License-Identifier: MIT

import React, { createContext, useCallback, useContext, useEffect, useState, useId, useMemo, type ReactNode } from 'react'
import { Box } from 'ink'

import { useSetMouseModal } from './mouse.js'

export interface OverlayPosition {
  top: number
  left: number
}

interface OverlayContextValue {
  show(node: ReactNode, position: OverlayPosition, owner: string): void
  hide(owner: string): void
}

const OverlayVisible = createContext(false)
export const useOverlayVisible = ()=>useContext(OverlayVisible)
const OverlayContext = createContext<OverlayContextValue | null>(null)

const noop: OverlayContextValue = {
  show() {},
  hide() {},
}

export function useOverlay() {
  const context = useContext(OverlayContext) ?? noop
  const owner = useId()
  return useMemo(() => ({show: (node: ReactNode, position: OverlayPosition) => context.show(node, position, owner), hide: () => context.hide(owner)}), [context, owner])
}

/**
 * Renders overlay nodes after all normal content so a dropdown is painted on
 * top of the layout instead of stretching its parent.
 */
export function OverlayProvider({ children }: { children: ReactNode }): React.ReactElement {
  const [overlay, setOverlay] = useState<{ node: ReactNode; top: number; left: number; owner: string } | undefined>()
  const setMouseModal = useSetMouseModal()

  const show = useCallback((node: ReactNode, position: OverlayPosition, owner: string) => {
    setOverlay({ node, owner, top: Math.max(0, position.top), left: Math.max(0, position.left) })
  }, [])
  const hide = useCallback((owner: string) => setOverlay(current => current?.owner === owner ? undefined : current), [])

  useEffect(() => {
    setMouseModal(overlay !== undefined)
    return () => setMouseModal(false)
  }, [overlay, setMouseModal])

  return (
    <OverlayContext.Provider value={useMemo(() => ({ show, hide }), [show, hide])}>
      <OverlayVisible.Provider value={overlay!==undefined}>{children}</OverlayVisible.Provider>
      {overlay !== undefined ? (
        <Box position="absolute" top={overlay.top} left={overlay.left}>
          {overlay.node}
        </Box>
      ) : null}
    </OverlayContext.Provider>
  )
}

export function clampOverlay(
  anchor: { x: number; y: number; height: number },
  size: { width: number; height: number },
  screen: { columns: number; rows: number },
): OverlayPosition {
  return {
    left: Math.max(0, Math.min(anchor.x, screen.columns - size.width - 1)),
    top: Math.max(0, Math.min(anchor.y + anchor.height - 1, screen.rows - size.height - 1)),
  }
}
