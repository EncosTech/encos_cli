// SPDX-License-Identifier: MIT

import { fork, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { AdapterTiming } from '../runtime.js'
import type { Event, Reply, Request, StudioClient } from './protocol.js'
import type { LogStore } from '../tui/log-store.js'

export function createStudioClient(
  logs: LogStore,
  options: { pluginPath?: string; timing?: AdapterTiming; demo?: boolean } = {},
): StudioClient {
  const js = new URL('./driver-worker.js', import.meta.url)
  const bundled = new URL('./studio/driver-worker.js', import.meta.url)

  const worker = existsSync(js)
    ? js
    : existsSync(bundled)
      ? bundled
      : new URL('./driver-worker.ts', import.meta.url)

  const child = fork(fileURLToPath(worker), [], {
    detached: process.platform !== 'win32',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, EMCLI_STUDIO_OPTIONS: JSON.stringify(options) },
  })

  return connectWorker(child, logs, { processGroup: process.platform !== 'win32' })
}

export function connectWorker(
  child: ChildProcess,
  logs: LogStore,
  options: { requestTimeoutMs?: number; processGroup?: boolean } = {},
): StudioClient {
  let sequence = 0,
    closed = false,
    closing: Promise<void> | undefined

  const listeners = new Set<(event: Event) => void>()

  const pending = new Map<
    number,
    {
      resolve(value: unknown): void
      reject(error: Error): void
      timer: ReturnType<typeof setTimeout>
    }
  >()

  const emit = (event: Event) => {
    for (const listener of listeners) listener(event)
  }

  const terminate = (signal: NodeJS.Signals) => {
    if (options.processGroup && child.pid) {
      try {
        process.kill(-child.pid, signal)

        return
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
          logs.append({
            level: 'warn',
            source: 'driver',
            message: `Could not stop driver process group: ${String(error)}`,
          })
      }
    }

    if (child.exitCode === null && child.signalCode === null) child.kill(signal)
  }

  const fail = (message: string) => {
    if (closed) return

    closed = true

    for (const item of pending.values()) {
      clearTimeout(item.timer)
      item.reject(new Error(message))
    }

    pending.clear()

    if (!closing) {
      logs.append({ level: 'error', source: 'driver', message })
      emit({ type: 'log', level: 'error', message })
    }
  }

  for (const stream of ['stdout', 'stderr'] as const) {
    let buffer = ''
    const pipe = child[stream]

    pipe?.setEncoding('utf8')

    const append = (message: string) => {
      if (message)
        logs.append({
          message,
          stream,
          source: 'driver',
          level: stream === 'stderr' ? 'error' : 'info',
        })
    }

    pipe?.on('data', (chunk: string) => {
      buffer += chunk

      const lines = buffer.split(/\r?\n|\r/)

      buffer = lines.pop() ?? ''

      for (const line of lines) append(line)

      while (buffer.length > 8192) {
        append(buffer.slice(0, 8192))
        buffer = buffer.slice(8192)
      }
    })

    pipe?.on('end', () => append(buffer))
  }

  child.on('message', (message: Reply | Event) => {
    if (closed) return

    if ('id' in message) {
      const item = pending.get(message.id)

      if (!item) return

      pending.delete(message.id)
      clearTimeout(item.timer)

      if (message.ok) item.resolve(message.value)
      else item.reject(new Error(message.error))
    } else {
      if (message.type === 'log')
        logs.append({ source: 'session', level: message.level, message: message.message })

      emit(message)
    }
  })

  child.on('error', (error) => fail(`Driver process failed: ${error.message}`))

  child.on('exit', (code, signal) => {
    if (options.processGroup) terminate('SIGKILL')

    fail(`Driver process exited (${signal ?? code ?? 'unknown'})`)
  })

  const request = <T = unknown>(request: Request): Promise<T> =>
    new Promise((resolve, reject) => {
      if (closed || !child.connected) {
        reject(new Error('Driver process is offline'))

        return
      }

      const id = ++sequence

      const timer = setTimeout(
        () => {
          terminate('SIGKILL')

          fail(
            'Driver process request timed out; the session was terminated. Restart emcli to reconnect and check device state before retrying.',
          )
        },
        options.requestTimeoutMs ??
          (request.type === 'adapter-config-command' && request.item === 'download'
            ? 600000
            : 120000),
      )

      pending.set(id, { resolve: (value) => resolve(value as T), reject, timer })

      child.send({ id, request }, (error) => {
        if (error) {
          const item = pending.get(id)

          if (item) {
            clearTimeout(item.timer)
            pending.delete(id)
            reject(error)
          }
        }
      })
    })

  return {
    request,
    subscribe: (listener) => {
      listeners.add(listener)

      return () => {
        listeners.delete(listener)
      }
    },
    close() {
      if (closing) return closing

      closing = (async () => {
        if (closed) return

        const timer = setTimeout(() => terminate('SIGKILL'), 4000)

        try {
          await request({ type: 'shutdown' })
        } catch {
        } finally {
          clearTimeout(timer)

          if (!closed) {
            if (child.connected) child.disconnect()

            terminate('SIGTERM')
          }

          fail('Driver process closed')
        }
      })()

      return closing
    },
  }
}
