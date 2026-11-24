// SPDX-License-Identifier: MIT
import {fork} from 'node:child_process'

export const jsonMode = process.env.EMCLI_JSON_WORKER === '1'
export interface ApiRecord {
  schemaVersion: 1
  command: string
  type: 'sample' | 'result' | 'error'
  ok: boolean
  timestamp: string
  data?: unknown
  error?: {code: string; message: string}
  exitCode?: number
}
let command = ''
let data: unknown = null
export function initJson(name: string) {
  command = name
  if (jsonMode) {
    // Windows kill('SIGINT') terminates a process; use our existing IPC channel
    // to dispatch the same graceful interrupt as the ordinary CLI.
    if (process.platform === 'win32') process.on('message', (message: any) => {
      if (message?.emcliSignal !== 'SIGINT') return
      if (process.listenerCount('SIGINT')) process.emit('SIGINT')
      else process.exit(130)
    })
    // A dead API client must not leave the detached driver worker running.
    process.once('disconnect', () => {
      if (process.listenerCount('SIGINT')) process.emit('SIGINT')
      else process.exit(1)
      setTimeout(() => process.exit(1), 5000).unref()
    })
  }
}
export function setJsonResult(value: unknown) { data = value }
function send(record: ApiRecord) {
  if (!jsonMode || !process.connected) return
  // IPC's default serializer does not accept BigInt. Normalize before sending.
  const normalized = JSON.parse(JSON.stringify(record, (_key, value) =>
    typeof value === 'bigint' ? String(value) : value === undefined ? null : value))
  process.send?.({emcliApi: normalized})
}
export function jsonSample(value: unknown) {
  send({schemaVersion: 1, command, type: 'sample', ok: true, timestamp: new Date().toISOString(), data: value})
}
export function jsonFinish(exitCode: number) {
  send({schemaVersion: 1, command, type: 'result', ok: exitCode === 0, timestamp: new Date().toISOString(), data, exitCode})
}
export function jsonFailure(error: unknown, exitCode = 1) {
  const value = error as {code?: unknown}
  send({
    schemaVersion: 1, command, type: 'error', ok: false, timestamp: new Date().toISOString(),
    error: {
      code: typeof value?.code === 'string' ? value.code : 'EMCLI_COMMAND_FAILED',
      message: error instanceof Error ? error.message : String(error),
    },
    data, exitCode,
  })
}
export async function flushJson() {
  if (jsonMode && process.connected) {
    await new Promise<void>(resolve => process.send?.({emcliFlush: true}, () => resolve()))
  }
}

/** Native stdout cannot be intercepted by console hooks. Isolate the driver and
 * carry API records over IPC; all child stdout/stderr is diagnostic stderr. */
export async function runJsonProcess(entry: string, argv: string[], name: string): Promise<number> {
  return new Promise(resolve => {
    let final = false, finished = false, signals = 0
    const child = fork(entry, argv, {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: {...process.env, EMCLI_JSON_WORKER: '1'},
    })
    const write = (record: ApiRecord) => {
      if (final) return
      final = record.type !== 'sample'
      process.stdout.write(JSON.stringify(record) + '\n')
    }
    child.stdout?.pipe(process.stderr, {end: false})
    child.stderr?.pipe(process.stderr, {end: false})
    child.on('message', (message: any) => { if (message?.emcliApi) write(message.emcliApi) })
    const forward = (signal: NodeJS.Signals) => {
      try {
        if (process.platform === 'win32') {
          if (signal === 'SIGINT' && child.connected) child.send({emcliSignal: signal})
          else child.kill(signal)
        }
        else process.kill(-child.pid!, signal)
      } catch { /* The worker may already have exited. */ }
    }
    const onInt = () => { forward(++signals > 1 ? 'SIGKILL' : 'SIGINT') }
    const onTerm = () => forward('SIGTERM')
    const onExit = () => { if (!finished) forward('SIGKILL') }
    const input = process.stdin
    const consoleInput = process.platform === 'win32' && input.isTTY
    const wasRaw = input.isRaw, wasPaused = input.isPaused()
    const onData = (chunk: Buffer | string) => {
      for (const byte of Buffer.from(chunk)) if (byte === 3) onInt()
    }
    if (consoleInput) {
      input.setRawMode(true)
      input.on('data', onData)
      input.resume()
    }
    process.on('SIGINT', onInt)
    process.on('SIGTERM', onTerm)
    process.once('exit', onExit)
    const done = (code: number, message?: string) => {
      if (finished) return
      finished = true
      process.off('SIGINT', onInt)
      process.off('SIGTERM', onTerm)
      process.off('exit', onExit)
      if (consoleInput) {
        input.off('data', onData)
        try { input.setRawMode(Boolean(wasRaw)) } catch { /* Console may have closed. */ }
        if (wasPaused) input.pause()
      }
      if (!final) {
        code ||= 1
        write({
          schemaVersion: 1, command: name, type: 'error', ok: false, timestamp: new Date().toISOString(),
          error: {code: 'EMCLI_PROCESS_FAILED', message: message ?? 'Driver process exited without a final result'},
          exitCode: code,
        })
      }
      resolve(code)
    }
    child.on('error', error => done(1, error.message))
    child.on('close', (code, signal) =>
      done(code ?? (signal === 'SIGINT' ? 130 : 1), signal ? `Driver process exited with ${signal}` : undefined))
  })
}
