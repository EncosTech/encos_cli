// SPDX-License-Identifier: MIT

import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { loadEmcliNative } from '@encos/emcli-native'

export const adapterModes = ['ecat', 'enet', 'usb3can', 'usb8can', 'sim', 'simsensors'] as const

export type AdapterMode = (typeof adapterModes)[number]

export type AdapterConfigItem = 'version' | 'mode' | 'ip' | 'reboot' | 'download'

export interface CdcPort {
  port: string
  name: string
}

export interface AdapterNetwork {
  slaveId: number
  ip: string
}

export interface AdapterConfigState {
  port: string
  mode: AdapterMode
  network?: AdapterNetwork
}

const text = async (path: string) =>
  readFile(path, 'utf8')
    .then((v) => v.trim())
    .catch(() => '')

export async function linuxCdcPorts(root = '/sys/class/tty'): Promise<CdcPort[]> {
  const ports = await Promise.all(
    (await readdir(root)).map(async (name) => {
      let path = await realpath(join(root, name, 'device')).catch(() => '')

      let cdc = false,
        product = ''

      while (path && path !== '/') {
        const [usbClass, subclass, label] = await Promise.all([
          text(join(path, 'bInterfaceClass')),
          text(join(path, 'bInterfaceSubClass')),
          text(join(path, 'product')),
        ])

        if (usbClass === '02' && subclass === '02') cdc = true

        if (label && !product) product = label

        path = dirname(path)
      }

      return cdc ? { port: `/dev/${name}`, name: product || 'USB CDC device' } : undefined
    }),
  )

  return ports
    .filter((p): p is CdcPort => Boolean(p))
    .sort((a, b) => a.port.localeCompare(b.port, undefined, { numeric: true }))
}

export function parseWindowsCdcPorts(json: string): CdcPort[] {
  if (!json.trim()) return []

  const value: unknown = JSON.parse(json),
    items = Array.isArray(value) ? value : [value]

  return items
    .flatMap((item) => {
      if (!item || typeof item !== 'object' || String(item.Service).toLowerCase() !== 'usbser')
        return []

      const name = String(item.Name ?? ''),
        port = name.match(/\((COM\d+)\)/i)?.[1]?.toUpperCase()

      return port
        ? [{ port, name: name.replace(/\s*\(COM\d+\)/i, '').trim() || 'USB CDC device' }]
        : []
    })
    .sort((a, b) => a.port.localeCompare(b.port, undefined, { numeric: true }))
}

export async function serialPorts(timeoutMs = 10000): Promise<CdcPort[]> {
  if (process.platform === 'win32') {
    const { stdout } = await promisify(execFile)(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); @(Get-CimInstance Win32_PnPEntity -Filter "Service=\'usbser\'" | Select-Object Name,Service) | ConvertTo-Json -Compress',
      ],
      { windowsHide: true, timeout: timeoutMs },
    )

    return parseWindowsCdcPorts(stdout)
  }

  if (process.platform === 'linux') return linuxCdcPorts()

  throw new Error('USB CDC discovery is supported on Linux and Windows')
}

/** Detect a returned CDC device without sending commands to firmware during reset. */
export async function cdcPortGeneration(port: string, timeoutMs: number): Promise<string | null> {
  if (process.platform === 'win32') {
    const ports = await serialPorts(timeoutMs)

    return ports.some((item) => item.port.toUpperCase() === port.toUpperCase()) ? port : null
  }

  try {
    const info = await stat(port, { bigint: true })

    return info.isCharacterDevice() ? `${info.dev}:${info.ino}:${info.birthtimeNs}` : null
  } catch (error) {
    if (['ENOENT', 'ENODEV', 'ENXIO'].includes((error as NodeJS.ErrnoException).code ?? ''))
      return null

    throw error
  }
}

export function networkFromSlave(value: string): AdapterNetwork | undefined {
  if (!/^\d{1,3}$/.test(value)) return undefined

  const slaveId = Number(value)

  return slaveId <= 252 ? { slaveId, ip: `192.168.100.${slaveId + 1}` } : undefined
}

export function networkFromIp(value: string): AdapterNetwork | undefined {
  const suffix = value.match(/^192\.168\.100\.([1-9]\d{0,2})$/)?.[1]

  if (!suffix || Number(suffix) > 253) return undefined

  return { slaveId: Number(suffix) - 1, ip: value }
}

export function validateConfigPort(port: string, ports: CdcPort[]): void {
  if (!/^(\/dev\/[^\r\n:]+|COM\d+)$/i.test(port)) {
    throw new Error('Enter a valid serial port')
  }

  if (ports.length && !ports.some((device) => device.port === port)) {
    throw new Error('Select an available USB CDC device')
  }
}

export class AdapterConfigurator {
  state?: AdapterConfigState

  private generation = 0

  constructor(
    private native: typeof loadEmcliNative,
    private log: (message: string) => void = () => {},
    private probePort = cdcPortGeneration,
  ) {}

  open(port: string, deadline = Infinity) {
    if (!/^(\/dev\/[^\r\n:]+|COM\d+)$/i.test(port)) throw new Error('Choose a valid USB CDC port')

    this.close()

    const mode = this.readMode(port, deadline)
    const network = mode === 'enet' ? this.readNetwork(port, deadline) : undefined

    if (performance.now() >= deadline) throw new Error('Reconnect deadline exceeded')

    this.state = { port, mode, ...(network ? { network } : {}) }

    return this.state
  }

  close() {
    this.generation++
    this.state = undefined
  }

  command(item: AdapterConfigItem, value?: string) {
    const state = this.state

    if (!state) throw new Error('Open a USB CDC port first')

    if (item === 'mode' && value === undefined) {
      const mode = this.readMode(state.port)

      this.state = {
        ...state,
        mode,
        network: mode === 'enet' ? this.readNetwork(state.port) : undefined,
      }
    } else if (item === 'ip' && value === undefined) {
      this.state = { ...state, network: this.readNetwork(state.port) }
    } else {
      this.execute(state.port, item, value)

      // CLI writes save and reboot. The old serial endpoint may disappear.
      if (value !== undefined || item === 'reboot') this.close()
    }

    return this.state
  }

  async commandAndReconnect(
    item: AdapterConfigItem,
    value?: string,
    { restartTimeoutMs = 15000, reconnectTimeoutMs = 6000 } = {},
  ) {
    const port = this.state?.port
    const restarts = item === 'reboot' || item === 'download' || value !== undefined

    if (!restarts || !port) return this.command(item, value)

    const initialGeneration = this.generation

    try {
      // Download already waits for confirmed application startup in the native layer.
      const original = item === 'download' ? null : await this.probePort(port, restartTimeoutMs)

      if (initialGeneration !== this.generation) throw new Error('Adapter reconnection cancelled')

      this.command(item, value)

      if (item !== 'download') {
        const restartDeadline = performance.now() + restartTimeoutMs
        const generation = this.generation
        let disconnected = original === null
        let returned = false

        this.log(`${port}: waiting for adapter to restart`)

        while (performance.now() < restartDeadline) {
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(250, Math.max(0, restartDeadline - performance.now()))),
          )

          if (generation !== this.generation) throw new Error('Adapter reconnection cancelled')

          const remaining = Math.floor(restartDeadline - performance.now())

          if (remaining <= 0) break

          const current = await this.probePort(port, remaining)

          if (generation !== this.generation) throw new Error('Adapter reconnection cancelled')
          if (performance.now() >= restartDeadline) break

          if (current === null) disconnected = true
          else if (disconnected || current !== original) {
            returned = true
            break
          }
        }

        if (!returned)
          throw new Error(`Adapter restart timed out after ${restartTimeoutMs / 1000}s`)
      }
    } catch (error) {
      // A cancellation may belong to a newer connection; do not clear that state.
      if (!(error instanceof Error && error.message === 'Adapter reconnection cancelled'))
        this.close()

      throw error
    }

    const deadline = performance.now() + reconnectTimeoutMs
    let generation = this.generation
    let lastError = 'CDC device did not return'
    let stableSince: number | undefined
    let stableConfig: string | undefined

    this.log(`${port}: reconnecting`)

    while (performance.now() < deadline) {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(250, Math.max(0, deadline - performance.now()))),
      )

      if (generation !== this.generation) throw new Error('Adapter reconnection cancelled')
      if (performance.now() >= deadline) break

      try {
        const result = this.open(port, deadline)

        generation = this.generation

        const now = performance.now()
        const configuration = JSON.stringify(result)

        // Firmware acknowledges REBOOT before its delayed USB reset. Require repeated
        // opens and matching reads over one second, not a single pre-reset reply.
        if (stableSince === undefined || stableConfig !== configuration) {
          stableSince = now
          stableConfig = configuration
        }

        if (now - stableSince >= 1000) {
          this.log(`${port}: reconnected`)

          return result
        }

        this.state = undefined
        lastError = 'CDC connection has not stabilized'
      } catch (error) {
        generation = this.generation
        stableSince = undefined
        stableConfig = undefined
        lastError = error instanceof Error ? error.message : String(error)
      }
    }

    this.close()

    throw new Error(`Reconnect timed out after ${reconnectTimeoutMs / 1000}s: ${lastError}`)
  }

  private readMode(port: string, deadline = Infinity): AdapterMode {
    const firmwareMode = this.execute(port, 'mode', undefined, deadline)
      .join('\n')
      .match(/\bACTIVE=(\w+)/)?.[1]
      ?.toLowerCase()

    const value = firmwareMode === 'udp' ? 'enet' : firmwareMode

    if (!adapterModes.includes(value as AdapterMode)) throw new Error('Could not read adapter mode')

    return value as AdapterMode
  }

  private readNetwork(port: string, deadline = Infinity): AdapterNetwork {
    const reply = this.execute(port, 'ip', undefined, deadline).join('\n')
    const network = networkFromIp(reply.match(/\bIP=([\d.]+)/)?.[1] ?? '')

    if (!network) throw new Error('Could not read adapter network configuration')

    return network
  }

  private execute(port: string, item: AdapterConfigItem, value?: string, deadline = Infinity) {
    if (!['version', 'mode', 'ip', 'reboot', 'download'].includes(item))
      throw new Error('Unknown adapter setting')

    if (value !== undefined) {
      if (item === 'mode' && !adapterModes.includes(value as AdapterMode))
        throw new Error('Invalid device mode')

      if (item === 'ip' && !networkFromIp(value))
        throw new Error('Use 192.168.100.1–253 (Slave ID 0–252)')

      if (item === 'download' && !/\.(upd|bin|elf)$/i.test(value))
        throw new Error('Choose a .upd, .bin or .elf firmware file')

      if (item === 'version' || item === 'reboot') throw new Error('This command has no value')
    } else if (item === 'download') throw new Error('Choose a firmware file')

    const args = [
      'config',
      `Ethernet:${port}`,
      item,
      ...(value === undefined ? [] : item === 'download' ? [value] : ['set', value]),
    ]

    const remaining = Math.floor(deadline - performance.now())

    if (remaining <= 0) throw new Error('Reconnect deadline exceeded')

    const result = this.native().slave(args, true, Math.min(3000, remaining))

    if (!result.handled || result.code !== 0)
      throw new Error(`Adapter configuration failed (${result.code ?? 'unsupported'})`)

    for (const reply of result.replies ?? []) this.log(`${port}: ${reply.trim()}`)

    if (!result.replies?.length) this.log(`${port}: ${item} completed`)

    return result.replies ?? []
  }
}
