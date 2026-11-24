// SPDX-License-Identifier: MIT

import { visibleBox } from './geometry.js'

import { useNavigationRegion } from './navigation.js'
import { useInteractionBlocked } from './interaction.js'

import React, { createContext, useContext, useEffect, useRef, type ReactNode } from 'react'
import { Box, measureElement, useStdout, type DOMElement } from 'ink'
import { PassThrough } from 'node:stream'

type TerminalOutput = NodeJS.WritableStream & { destroyed?: boolean; writableEnded?: boolean }

export type MouseButton = 'left' | 'middle' | 'right' | 'wheel-up' | 'wheel-down' | 'other'

export interface MouseEvent {
  x: number
  y: number
  button: MouseButton
  action: 'press' | 'release' | 'wheel' | 'move'
}

export interface MouseInput {
  readonly stdin: PassThrough
  onMouse(listener: (event: MouseEvent) => void): () => void
  dispose(): void | Promise<void>
  enableReporting?(stdout: TerminalOutput): void
  disableReporting?(): void
}

class FilteredStdin extends PassThrough {
  isTTY = true
  holdRawMode = false
  rawModeEnabled = false
  constructor(private readonly source: NodeJS.ReadableStream) {
    super()
    this.source = source
  }
  setRawMode(enabled: boolean): void {
    if (!enabled && this.holdRawMode) return
    this.rawModeEnabled = enabled
    const target = this.source as NodeJS.ReadableStream & { setRawMode?: (value: boolean) => void }
    target.setRawMode?.(enabled)
  }
  ref(): void {
    const target = this.source as NodeJS.ReadableStream & { ref?: () => void }
    target.ref?.()
  }
  unref(): void {
    const target = this.source as NodeJS.ReadableStream & { unref?: () => void }
    target.unref?.()
  }
}

function decodeButton(code: number): { button: MouseButton; action: 'press' | 'release' | 'wheel' | 'move' } {
  if ((code & 64) !== 0) {
    return { button: (code & 1) === 0 ? 'wheel-up' : 'wheel-down', action: 'wheel' }
  }
  const button = (code & 3) === 0 ? 'left' : (code & 3) === 1 ? 'middle' : (code & 3) === 2 ? 'right' : 'other'
  return { button, action: (code & 32) !== 0 ? 'move' : 'press' }
}

/**
 * Wraps the real stdin with a SGR mouse parser. Mouse sequences are consumed
 * here so Ink never treats the leading ESC as an Escape key press.
 */
export function createMouseInput(source: NodeJS.ReadableStream): MouseInput {
  const filtered = new FilteredStdin(source)
  const listeners = new Set<(event: MouseEvent) => void>()
  let buffer = ''
  let output: TerminalOutput | undefined
  let reporting = false
  let closing = false
  let disposed: Promise<void> | undefined
  let wakeDrain: (() => void) | undefined
  const disableReporting = (): void => {
    if (!reporting) return
    reporting = false
    output?.write('\x1b[?1000l\x1b[?1003l\x1b[?1006l')
  }

  const emit = (event: MouseEvent): void => {
    for (const listener of listeners) listener(event)
  }

  const onData = (chunk: Buffer | string): void => {
    if (closing) { wakeDrain?.(); return }
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    const pattern = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g
    let cursor = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(buffer)) !== null) {
      const before = buffer.slice(cursor, match.index)
      if (before !== '') filtered.write(before)
      const code = Number(match[1])
      const x = Number(match[2]) - 1
      const y = Number(match[3]) - 1
      const { button, action } = decodeButton(code)
      emit({ x, y, button, action: match[4] === 'm' ? 'release' : action })
      cursor = match.index + match[0].length
    }
    const rest = buffer.slice(cursor)
    // Keep a partial SGR mouse prefix until the next chunk arrives.
    if (/\x1b\[<[\d;]*$/.test(rest)) {
      buffer = rest
      return
    }
    if (rest !== '') filtered.write(rest)
    buffer = ''
  }

  source.on('data', onData)
  return {
    stdin: filtered,
    onMouse(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    enableReporting(stdout) {
      if (closing) return
      output = stdout
      filtered.holdRawMode = true
      reporting = true
      stdout.write('\x1b[?1000h\x1b[?1003h\x1b[?1006h')
    },
    disableReporting,
    dispose() {
      if (disposed) return disposed
      closing = true
      disposed = (async () => {
        try {
          disableReporting()
          if (output && !output.destroyed && !output.writableEnded) {
            await new Promise<void>(resolve => { output!.write('', () => resolve()) })
          }
          // Ink releases raw mode before child effects are cleaned up. Keep echo
          // off until reporting is disabled and in-flight input has drained.
          // No terminal query: a late query reply could itself leak to the shell.
          if (filtered.holdRawMode && filtered.rawModeEnabled) {
            await new Promise<void>(resolve => {
              let quiet: ReturnType<typeof setTimeout>
              const finish = (): void => { clearTimeout(quiet); clearTimeout(limit); wakeDrain = undefined; resolve() }
              const limit = setTimeout(finish, 250)
              wakeDrain = () => { clearTimeout(quiet); quiet = setTimeout(finish, 50) }
              wakeDrain()
            })
          }
        } finally {
          source.off('data', onData)
          filtered.holdRawMode = false
          if (filtered.rawModeEnabled) filtered.setRawMode(false)
          buffer = ''
          listeners.clear()
          filtered.end()
        }
      })()
      return disposed
    },
  }
}

interface Region {
  ref: React.RefObject<DOMElement | null>
  onPress?: (event: MouseEvent) => void
  onWheel?: (event: MouseEvent) => void
  onHover?: (event: MouseEvent) => void
  onLeave?: () => void
}

interface MouseContextValue {
  addRegion(region: Region): () => void
  subscribe(listener: (event: MouseEvent) => void): () => void
  setModal(value: boolean): void
}

const MouseContext = createContext<MouseContextValue | null>(null)

export function MouseProvider({ input, children }: { input?: MouseInput; children: ReactNode }): React.ReactElement {
  const { stdout } = useStdout()
  const regions = useRef<Region[]>([])
  const pressed = useRef<Region | undefined>(undefined)
  const hovered = useRef<Region | undefined>(undefined)
  const modal = useRef(false)
  const listeners = useRef(new Set<(event: MouseEvent) => void>())

  useEffect(() => {
    if (input?.enableReporting) input.enableReporting(stdout)
    else stdout.write('\x1b[?1000h\x1b[?1003h\x1b[?1006h')
    return () => {
      if (input?.disableReporting) input.disableReporting()
      else stdout.write('\x1b[?1000l\x1b[?1003l\x1b[?1006l')
    }
  }, [stdout, input])

  useEffect(() => {
    if (input === undefined) return
    const findRegion = (event: MouseEvent): Region | undefined => {
      const candidates: Array<{ region: Region; area: number }> = []
      for (const region of regions.current) {
        if (event.action === 'wheel' && !region.onWheel) continue
        const element = region.ref.current
        if (element === null) continue
        const box = visibleBox(element)
        if (
          event.x >= box.x &&
          event.x < box.x + box.width &&
          event.y >= box.y &&
          event.y < box.y + box.height
        ) {
          candidates.push({ region, area: box.width * box.height })
        }
      }
      candidates.sort((left, right) => left.area - right.area)
      return candidates[0]?.region
    }

    return input.onMouse(event => {
      for (const listener of listeners.current) listener(event)
      if (modal.current) return
      const region = findRegion(event)
      if (event.action === 'move') {
        if (region !== hovered.current) {
          hovered.current?.onLeave?.()
          hovered.current = region
          if (region !== undefined) region.onHover?.(event)
        }
        return
      }
      if (region === undefined) return
      if (event.action === 'wheel') {
        region.onWheel?.(event)
        return
      }
      if (event.action === 'press') {
        pressed.current = region
        region.onPress?.(event)
      } else {
        pressed.current = undefined
      }
    })
  }, [input])

  const value = useRef<MouseContextValue>({
    addRegion(region) {
      regions.current.push(region)
      return () => {
        regions.current = regions.current.filter(item => item !== region)
      }
    },
    subscribe(listener) {
      listeners.current.add(listener)
      return () => {
        listeners.current.delete(listener)
      }
    },
    setModal(value) {
      modal.current = value
    },
  }).current

  return <MouseContext.Provider value={value}>{children}</MouseContext.Provider>
}

export function MouseRegion({
  children,
  onPress,
  onWheel,
  onHover,
  onLeave,
  stretch = false,
  fill = false,
  focusId,
  disabled = false,
}: {
  children: ReactNode
  onPress?: (event: MouseEvent) => void
  onWheel?: (event: MouseEvent) => void
  onHover?: (event: MouseEvent) => void
  onLeave?: () => void
  focusId?: string
  disabled?: boolean
  fill?: boolean
  stretch?: boolean
}): React.ReactElement {
  const context = useContext(MouseContext)
  const blocked = useInteractionBlocked()
  const ref = useRef<DOMElement | null>(null)
  useNavigationRegion(focusId, ref, blocked || disabled)

  useEffect(() => {
    if (context === null || blocked) return
    return context.addRegion({ ref, onPress, onWheel, onHover, onLeave })
  }, [context, blocked, onPress, onWheel, onHover, onLeave])

  return (
    <Box ref={ref} flexShrink={fill ? 1 : 0} flexGrow={fill ? 1 : 0} minHeight={fill ? 0 : undefined} minWidth={0} flexDirection="row" width={stretch ? '100%' : undefined} alignSelf={stretch ? 'stretch' : undefined}>
      {children}
    </Box>
  )
}

export function AlternateScreen({ children }: { children: ReactNode }): React.ReactElement {
  const { stdout } = useStdout()
  useEffect(() => {
    stdout.write('\x1b[?1049h\x1b[?25l')
    return () => {
      stdout.write('\x1b[?25h\x1b[?1049l')
    }
  }, [stdout])
  return <>{children}</>
}

export function parseMouseSequence(sequence: string): MouseEvent | undefined {
  const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(sequence)
  if (match === null) return undefined
  const code = Number(match[1])
  const { button, action } = decodeButton(code)
  return {
    x: Number(match[2]) - 1,
    y: Number(match[3]) - 1,
    button,
    action: match[4] === 'm' ? 'release' : action,
  }
}


export function useMouseEvents(handler: (event: MouseEvent) => void): void {
  const context = useContext(MouseContext)
  const ref = useRef(handler)
  ref.current = handler
  useEffect(() => {
    if (context === null) return
    return context.subscribe(event => ref.current(event))
  }, [context])
}

export function useSetMouseModal(): (value: boolean) => void {
  const context = useContext(MouseContext)
  return context?.setModal ?? (() => undefined)
}
