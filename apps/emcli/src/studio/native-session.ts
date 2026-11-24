// SPDX-FileCopyrightText: 2026 Encos
// SPDX-License-Identifier: MIT

import { readAdapterStatistics, type AdapterStatistics } from './adapter-statistics.js'
import { AdapterConfigurator, serialPorts, validateConfigPort } from './adapter-config.js'
import { ensureSshAdapterPermissions } from './permissions.js'
import { Playback, validatePlayConfig } from './playback.js'
import { listFiles } from './files.js'
import { parseTrajectoryCsv } from '../trajectory.js'
import { resolve } from 'node:path'
import { BatchControl } from './batch-control.js'
import { MotorControlLoop } from './motor-control.js'
import {
  MotorCommunicationMode,
  LogLevel,
  type Runtime,
  type AdapterWrapper,
  type BusWrapper,
  type MotorWrapper,
} from '@encos/encos-driver-native'
import { loadEmcliNative } from '@encos/emcli-native'
import { createAdapter, openRuntime, type AdapterTiming } from '../runtime.js'
import { decodeAdapterBusId } from '../target.js'
import { readValue } from '../commands/config.js'
import { degreesToRadians } from '../format.js'
import { scanAdapter } from './scan.js'
import { discoverGloves } from './glove-discovery.js'
import { Performance } from './performance.js'
import { Peripherals } from './peripherals.js'
import { availableGloveSlaves, availableDeviceBuses, busKey, hexId, isEthercat, parseDeviceId } from './devices.js'
import {
  createDexHand,
  dexHandJoints,
  dexHandValue,
  formatDexHandPoints,
  parseDexHandSetting,
} from './dex-hand.js'
import { validateTiming, timingEnvelope } from './bus-timing.js'
import { SerialQueue } from '../async.js'
import { supportsDexHandJointSetting, validateControl, validateSetting, SETTINGS } from './catalog.js'
import type {
  AdapterInfo,
  DeviceAddress,
  Event,
  GraphMetric,
  MotorAddress,
  Request,
  SessionState,
} from './protocol.js'

type ActiveAdapter = { info: AdapterInfo; adapter: AdapterWrapper }
type DexHandConnection = ReturnType<typeof createDexHand>
type HandBus = { slaveId: number | null; busId: number }
type PreparedDexHand = {
  address: DeviceAddress & HandBus
  bus: BusWrapper
  connection: DexHandConnection
}

export class NativeSession {
  private configurator = new AdapterConfigurator(loadEmcliNative, (message) =>
    this.emit({ type: 'log', level: 'info', message }),
  )

  private runtime?: Runtime
  private adapters = new Map<string, ActiveAdapter>()
  private motors = new Map<string, MotorWrapper>()
  private dexHands = new Map<string, DexHandConnection>()
  private selected?: string
  private watching?: string
  private view: import('./protocol.js').StudioView = 'single'
  private batch = new BatchControl(
    (key) => this.motors.get(key),
    (sample) => this.emit({ type: 'telemetry', sample }),
    (key, error) => {
      this.publish()
      this.logError(`Batch control stopped for ${this.motorLabel(key)}: ${message(error)}`)
    },
    (task) => this.queue.run(task),
  )

  private playback = new Playback((event) => this.emit(event))
  private peripherals = new Peripherals()
  private performance = new Performance(loadEmcliNative, (event) => this.emit(event))
  private controlLoop = new MotorControlLoop(
    (sample) => this.emit({ type: 'telemetry', sample }),
    (error) => {
      this.publish()
      this.logError(`Control stopped: ${message(error)}`)
    },
    (task) => this.queue.run(task),
  )

  private get command() {
    return this.controlLoop.command
  }

  private set command(value: import('./protocol.js').ControlCommand | undefined) {
    if (value) this.controlLoop.apply(value)
    else this.controlLoop.stop()
  }

  private graph: GraphMetric[] = ['position', 'speed', 'current', 'power']
  private closed = false
  private timer?: ReturnType<typeof setTimeout>
  private queue = new SerialQueue()
  private lastSample = 0
  private lastError = 0

  constructor(
    private emit: (event: Event) => void,
    private options: { pluginPath?: string; timing?: AdapterTiming; demo?: boolean } = {},
  ) {}

  async initialize() {
    this.runtime = await openRuntime({ pluginPath: this.options.pluginPath })
    this.schedule()
  }

  state(): SessionState {
    return {
      adapterConfig: this.configurator.state ? structuredClone(this.configurator.state) : undefined,
      play: this.playback.state ? structuredClone(this.playback.state) : undefined,
      view: this.view,
      batchKeys: [...this.batch.keys],
      batchCommand: this.batch.command ? structuredClone(this.batch.command) : undefined,
      adapters: [...this.adapters.values()].map((entry) => structuredClone(entry.info)),
      selected: this.selected,
      selectedDevice: this.watching,
      control: this.command?.mode,
      controlCommand: this.command ? structuredClone(this.command) : undefined,
      graph: [...this.graph],
    }
  }

  private publish() {
    this.batch.keys = this.batch.keys.filter((key) => this.motors.has(key))
    this.emit({ type: 'state', state: this.state() })
  }

  private motor() {
    const motor = this.selected ? this.motors.get(this.selected) : undefined

    if (!motor) throw new Error('Select a motor first')

    return motor
  }

  private schedule() {
    if (!this.closed)
      this.timer = setTimeout(() => {
        void this.queue.run(() => this.tick()).finally(() => this.schedule())
      }, 100)
  }

  private async tick() {
    if (this.closed) return

    if (this.view === 'play') {
      this.playback.poll()

      return
    }

    if (this.performance.running) {
      this.performance.poll()

      return
    }

    if (this.watching && this.peripherals.has(this.watching)) {
      if (Date.now() - this.lastSample < 200) return

      this.lastSample = Date.now()

      try {
        this.emit({ type: 'device-status', sample: this.peripherals.sample(this.watching) })
      } catch (error) {
        this.logError(`Could not read device: ${message(error)}`)
      }

      return
    }
  }

  private logError(message: string) {
    if (Date.now() - this.lastError > 3000) {
      this.lastError = Date.now()
      this.emit({ type: 'log', level: 'error', message })
    }
  }

  request(request: Request): Promise<unknown> {
    return this.queue.run(async () => {
      if (this.closed) throw new Error('Session is closed')

      const runtime = this.runtime

      if (!runtime) throw new Error('Driver is not ready')

      if (request.expectedView !== undefined && request.expectedView !== this.view)
        throw new Error('The active view changed; retry the operation')

      if (
        this.view !== 'single' &&
        ['select', 'control', 'disable', 'brake', 'write', 'read', 'ranges', 'dex-hand-setting'].includes(request.type)
      )
        throw new Error('This operation requires Single view')

      if (
        ['scan', 'remove', 'remove-device', 'bus-timing', 'bench', 'stress-start', 'add'].includes(
          request.type,
        )
      )
        this.batch.stop()

      if (request.expectedMotor !== undefined && request.expectedMotor !== this.selected)
        throw new Error('The selected motor changed; retry the operation')

      if (
        this.view === 'play' &&
        [
          'add',
          'add-device',
          'add-glove',
          'scan',
          'bench',
          'stress-start',
          'remove',
          'remove-device',
          'bus-timing',
          'canfd',
        ].includes(request.type)
      )
        throw new Error('This operation is unavailable in Play view')

      if (request.type.startsWith('play-') && this.view !== 'play')
        throw new Error('This operation requires Play view')

      if (
        this.view === 'adapter-config' &&
        ![
          'view',
          'serial-ports',
          'adapter-config-open',
          'adapter-config-close',
          'adapter-config-command',
          'files',
          'interfaces',
          'shutdown',
        ].includes(request.type)
      )
        throw new Error('This operation is unavailable in Adapter Config view')

      if (
        request.type.startsWith('adapter-config-') &&
        (this.view !== 'adapter-config' || this.adapters.size)
      )
        throw new Error(
          'Adapter configuration requires Adapter Config view and no connected adapters',
        )

      if (request.type === 'view' && request.view === 'adapter-config' && this.adapters.size)
        throw new Error('Disconnect all adapters before opening Adapter Config')

      if (
        this.performance.running &&
        ![
          'interfaces',
          'adapter-statistics',
          'stress-start',
          'stress-stop',
          'graph',
          'graph-active',
        ].includes(request.type)
      )
        this.performance.stop()

      switch (request.type) {
        case 'adapter-statistics': {
          const entry = this.adapters.get(request.adapterKey)

          if (!entry) throw new Error('Adapter no longer exists')

          return readAdapterStatistics(
            entry.adapter as unknown as { getStatistics?: () => AdapterStatistics | null },
          )
        }

        case 'serial-ports':
          return serialPorts()

        case 'adapter-config-open': {
          validateConfigPort(request.port, await serialPorts())

          try {
            return this.configurator.open(request.port)
          } finally {
            this.publish()
          }
        }

        case 'adapter-config-close':
          this.configurator.close()
          this.publish()
          return null

        case 'adapter-config-command': {
          try {
            return await this.configurator.commandAndReconnect(request.item, request.value)
          } finally {
            this.publish()
          }
        }

        case 'files':
          return listFiles(request.path, request.extensions)

        case 'play-load':
          return this.loadPlay(request.config)

        case 'play-start':
          this.playback.start()
          return this.playback.state

        case 'play-pause':
          this.playback.pause()
          return this.playback.state

        case 'play-stop':
          this.playback.requestReturn()
          return this.playback.state

        case 'play-log':
          this.playback.logging()
          return this.playback.state

        case 'view': {
          if (!['single', 'batch', 'play', 'adapter-config'].includes(request.view))
            throw new Error('Unknown view')

          if (request.view === 'adapter-config' && this.adapters.size)
            throw new Error('Disconnect all adapters before opening Adapter Config')

          this.configurator.close()
          this.playback.stop()
          this.performance.stop()
          this.batch.stop()
          this.controlLoop.select()
          this.watching = undefined
          this.view = request.view

          if (this.view === 'single')
            this.controlLoop.select(
              this.selected,
              this.selected ? this.motors.get(this.selected) : undefined,
            )

          this.publish()

          return this.state()
        }

        case 'batch-selection':
          this.requireBatch()
          this.batch.setSelection(request.motorKeys)
          this.publish()
          return this.state()

        case 'batch-control':
          this.requireBatch()
          validateControl(request.command.mode, request.command.values, request.command.stopMode)
          this.batch.apply(request.command)
          this.publish()
          return this.state()

        case 'batch-disable':
          this.requireBatch()
          this.batch.disable()
          this.publish()
          return this.state()

        case 'batch-brake': {
          this.requireBatch()

          const keys = this.batchTargets()

          await this.batchEach(keys, 'brake', async (motor) => {
            await ack(motor.brake(request.engaged, true))
          })

          return request.engaged ? 'Brakes engaged' : 'Brakes released'
        }

        case 'batch-write': {
          this.requireBatch()

          if (['id', 'comm', 'kt'].includes(request.item))
            throw new Error('This setting is unavailable in Batch')

          validateSetting(request.item, request.values)

          const keys = this.batchTargets()
          this.requireMotorSetting(request.item, keys)

          this.batch.stop()
          this.publish()

          await this.batchEach(
            keys,
            `write ${request.item} = ${request.item === 'position' && !request.values.length ? 'reset zero' : request.values.join(' ')}`,
            async (motor, key) => {
              await this.writeSetting(
                { type: 'write', item: request.item, values: request.values },
                motor,
                key,
              )
            },
          )

          return 'Settings applied'
        }

        case 'bench':

        case 'stress-start': {
          const entry = this.adapters.get(request.scope.adapterKey)

          if (!entry) throw new Error('Adapter no longer exists')

          this.controlLoop.select()
          this.publish()

          return request.type === 'bench'
            ? this.performance.bench(entry.info, request.scope, request.motorKeys)
            : this.performance.start(
                entry.info,
                request.scope,
                request.motorKeys,
                request.frequencyHz,
              )
        }

        case 'stress-stop':
          return this.performance.stop()

        case 'interfaces':
          return {
            version: runtime.getVersion(),
            types: [...new Set([...runtime.getAvailableAdapterTypes(), 'Fake'])]
              .sort()
              .map((type) => ({
                type,
                interfaces: type === 'Fake' ? ['demo'] : runtime.getAvailableInterface(type),
              })),
          }

        case 'add': {
          await ensureSshAdapterPermissions(request.adapterType)

          if (!request.adapterType.trim() || !request.interfaceName.trim())
            throw new Error('Choose an adapter type and interface')

          const key = JSON.stringify([request.adapterType, request.interfaceName])

          if (this.adapters.has(key)) throw new Error('This adapter is already connected')

          const timing = validateTiming({ ...this.options.timing, ...request.timing })

          const adapter = await createAdapter(
            runtime,
            { type: request.adapterType, id: request.interfaceName },
            timing,
            LogLevel.Warn,
            { fakeAutoCreate: false },
          ).catch((error) => {
            throw new Error(
              `Could not connect ${request.adapterType}:${request.interfaceName}: ${message(error instanceof Error && error.cause ? error.cause : error)}`,
            )
          })

          if (request.adapterType === 'Fake' && this.options.demo) {
            const fake = adapter.getFakeAdapterControl()!
            const model = runtime.stringToMotorModel(runtime.getAllMotorModelStrings()[0])

            for (let id = 1; id <= 8; id++) fake.seedMotor(0, id, model)
          }

          const info: AdapterInfo = {
            key,
            type: request.adapterType,
            interfaceName: request.interfaceName,
            buses: [],
            motors: [],
            devices: [],
            timing,
            busTiming: {},
          }

          this.adapters.set(key, { info, adapter })
          this.publish()
          await this.scan(key)

          return this.state()
        }

        case 'add-device': {
          const entry = this.adapters.get(request.adapterKey)

          if (!entry) throw new Error('Adapter no longer exists')

          if (
            !availableDeviceBuses(entry.info).some(
              (bus) => bus.busId === request.busId && bus.slaveId === request.slaveId,
            )
          )
            throw new Error('Bus no longer exists')

          if (!['motor', 'imu', 'battery', 'pms', 'dexhand'].includes(request.kind))
            throw new Error('Unknown device type')

          if (request.kind === 'dexhand') {
            const baseId = parseDeviceId(String(request.deviceId), 'dexhand')
            const prepared = this.prepareDexHand(entry, request, baseId)
            try {
              await this.attachDexHandMotors(entry, prepared)
            } catch (error) {
              prepared.connection.remove(prepared.connection.handle)
              throw error
            }
            entry.info.devices.push(prepared.address)
            this.dexHands.set(prepared.address.key, prepared.connection)
            this.publish()
            return this.state()
          }

          if (
            !Number.isInteger(request.deviceId) ||
            request.deviceId < (request.kind === 'motor' ? 1 : 0) ||
            request.deviceId > 2046
          )
            throw new Error(
              'Device ID must be an integer between ' +
                (request.kind === 'motor' ? 1 : 0) +
                ' and 2046',
            )

          const { adapterKey, slaveId, busId, deviceId, kind } = request

          if (kind === 'motor') {
            if (entry.info.devices.some((device) =>
              device.kind === 'dexhand' && device.slaveId === slaveId && device.busId === busId &&
              deviceId >= device.deviceId && deviceId <= device.deviceId + 2))
              throw new Error('CAN ID belongs to a DexHand on this bus')

            const key = motorKey(adapterKey, slaveId, busId, deviceId),
              existing = entry.info.motors.find((item) => item.key === key)

            if (existing?.origin === 'manual') throw new Error('This device already exists')

            if (existing) {
              existing.origin = 'manual'
            } else {
              const bus =
                slaveId === null
                  ? entry.adapter.getBus(busId)
                  : entry.adapter.getBus(slaveId, busId)

              const motor = await bus.getMotor(deviceId)

              entry.info.motors.push({
                key,
                adapterKey,
                slaveId,
                busId,
                motorId: deviceId,
                canfd: false,
                eff: false,
                origin: 'manual',
              })

              this.motors.set(key, motor)
              entry.info.motors.find((item) => item.key === key)!.properties = motor.getProperties()
            }
          } else {
            const key = JSON.stringify([adapterKey, slaveId, busId, kind, deviceId])

            if (entry.info.devices.some((item) => item.key === key))
              throw new Error('This device already exists')

            if (
              kind === 'pms' &&
              entry.info.devices.some(
                (item) => item.kind === 'pms' && item.busId === busId && item.slaveId === slaveId,
              )
            )
              throw new Error('Only one PMS is supported per bus')

            const address = {
              key,
              adapterKey,
              slaveId,
              busId,
              deviceId,
              kind,
              origin: 'manual' as const,
            }

            this.peripherals.add(address, entry.adapter)
            entry.info.devices.push(address)
          }

          this.publish()

          return this.state()
        }

        case 'add-glove': {
          const entry = this.adapters.get(request.adapterKey)

          if (!entry) throw new Error('Adapter no longer exists')

          if (!isEthercat(entry.info.type)) throw new Error('Glove requires an EtherCAT adapter')

          if (
            !Number.isInteger(request.slaveId) ||
            !availableGloveSlaves(entry.info).includes(request.slaveId)
          )
            throw new Error('Choose an available EtherCAT slave without existing devices')

          const key = JSON.stringify([request.adapterKey, 'glove', request.slaveId])

          if (entry.info.devices.some((item) => item.key === key))
            throw new Error('This glove already exists')

          const address = {
            key,
            adapterKey: request.adapterKey,
            slaveId: request.slaveId,
            busId: null,
            deviceId: request.slaveId,
            kind: 'glove' as const,
            origin: 'manual' as const,
          }

          this.peripherals.add(address, entry.adapter)
          entry.info.devices.push(address)
          this.publish()

          return this.state()
        }

        case 'device-action': {
          if (this.watching !== request.deviceKey)
            throw new Error('The selected device changed; retry the operation')

          const result = await this.peripherals.action(request.deviceKey, request.action)

          this.lastSample = 0

          return result
        }

        case 'dex-hand-setting': {
          if (this.watching !== request.deviceKey)
            throw new Error('The selected device changed; retry the operation')
          return this.dexHandSetting(request)
        }

        case 'bus-timing': {
          const entry = this.adapters.get(request.adapterKey)

          if (!entry) throw new Error('Adapter no longer exists')

          const address = { slaveId: request.slaveId, busId: request.busId }

          if (!entry.info.buses.some((bus) => busKey(bus) === busKey(address)))
            throw new Error('Bus no longer exists')

          const timing = validateTiming(request.timing, true)

          this.command = undefined
          this.publish()

          if (
            !entry.adapter.updateBusExtend(timingEnvelope(request.slaveId, request.busId, timing))
          )
            throw new Error('Adapter does not support this bus timing update')

          entry.info.busTiming ??= {}

          entry.info.busTiming[busKey(address)] = {
            ...entry.info.busTiming[busKey(address)],
            ...timing,
          }

          this.publish()

          return this.state()
        }

        case 'remove-device': {
          const entry = [...this.adapters.values()].find(
            (entry) =>
              entry.info.motors.some((item) => item.key === request.deviceKey) ||
              entry.info.devices.some((item) => item.key === request.deviceKey),
          )

          if (!entry) throw new Error('Device no longer exists')

          if (entry.info.motors.some((item) => item.key === request.deviceKey && item.dexHandKey))
            throw new Error('Remove the DexHand to delete its joints')

          const motor = this.motors.get(request.deviceKey)
          const hand = this.dexHands.get(request.deviceKey)

          if (this.watching === request.deviceKey) this.watching = undefined

          if (hand) {
            if (!hand.remove(hand.handle)) throw new Error('Could not delete DexHand')
            this.dexHands.delete(request.deviceKey)
            this.removeDexHandMotors(entry, request.deviceKey)
          } else {
            this.peripherals.remove(request.deviceKey, runtime)
          }

          if (this.selected === request.deviceKey) {
            this.controlLoop.select()
            this.selected = undefined
          }

          if (motor) {
            if (!runtime.deleteMotor(motor)) throw new Error('Could not delete motor')

            this.motors.delete(request.deviceKey)
          }

          entry.info.motors = entry.info.motors.filter((item) => item.key !== request.deviceKey)
          entry.info.devices = entry.info.devices.filter((item) => item.key !== request.deviceKey)
          this.publish()

          return this.state()
        }

        case 'scan':
          this.command = undefined
          this.publish()
          for (const key of request.adapterKey ? [request.adapterKey] : this.adapters.keys())
            await this.scan(key, request.busId, request.slaveId)
          return this.state()

        case 'remove': {
          this.command = undefined

          const entry = this.adapters.get(request.adapterKey)

          if (!entry) throw new Error('Adapter no longer exists')

          if (entry.info.motors.some((m) => m.key === this.selected)) this.controlLoop.select()

          for (const motor of entry.info.motors) {
            this.motors.delete(motor.key)

            if (this.selected === motor.key) this.selected = undefined
          }

          if (entry.info.devices.some((d) => d.key === this.watching)) this.watching = undefined

          this.peripherals.forget(entry.info.devices.map((d) => d.key))
          for (const device of entry.info.devices) this.dexHands.delete(device.key)
          entry.adapter.dispose()
          this.adapters.delete(request.adapterKey)
          this.publish()

          return this.state()
        }

        case 'select': {
          if (request.motorKey && !this.motors.has(request.motorKey))
            throw new Error('Motor no longer exists; rescan the adapter')

          if (request.motorKey && request.deviceKey) throw new Error('Select only one device')

          if (request.deviceKey && !this.peripherals.has(request.deviceKey) && !this.dexHands.has(request.deviceKey))
            throw new Error('Device no longer exists')

          this.watching = request.deviceKey

          this.controlLoop.select(
            request.motorKey,
            request.motorKey ? this.motors.get(request.motorKey) : undefined,
          )

          this.selected = request.motorKey
          this.lastSample = 0
          this.publish()

          return this.state()
        }

        case 'control':
          validateControl(request.mode, request.values, request.stopMode)
          this.controlLoop.select(this.selected, this.motor())
          this.command = structuredClone(request)
          this.publish()
          return this.state()

        case 'disable':
          this.controlLoop.disable()
          this.publish()
          return this.state()

        case 'brake':
          await ack(this.motor().brake(request.engaged, true))
          return request.engaged ? 'Brake engaged' : 'Brake released'

        case 'graph-active':
          if (this.view === 'batch') this.batch.setGraphActive(request.active)
          else if (this.view === 'single') {
            this.controlLoop.select(
              this.selected,
              this.selected ? this.motors.get(this.selected) : undefined,
            )

            this.controlLoop.setGraphActive(request.active)
          }
          return null

        case 'graph':
          if (
            request.metrics.some(
              (metric) => !['position', 'speed', 'current', 'power'].includes(metric),
            )
          )
            throw new Error('Unknown graph metric')
          this.graph = [...new Set(request.metrics)]
          this.publish()
          return this.state()

        case 'canfd': {
          const key = request.motorKey ?? this.selected
          const motor = key ? this.motors.get(key) : undefined

          if (!motor) throw new Error('Motor no longer exists')

          if (!request.enabled && [...this.adapters.values()].some(({ info }) =>
            info.motors.some((item) => item.key === key && item.dexHandKey)))
            throw new Error('DexHand joints require CAN FD')

          if (request.enabled) motor.enableCanFd()
          else motor.disableCanFd()

          for (const entry of this.adapters.values())
            for (const item of entry.info.motors) if (item.key === key) item.canfd = item.dexHandKey ? true : request.enabled

          this.publish()

          return this.state()
        }

        case 'ranges': {
          const p = this.motor().getProperties()

          return Object.fromEntries(
            Object.entries({
              kp: p.kp,
              kd: p.kd,
              pos: p.position,
              spd: p.speed,
              tor: p.torque,
              cur: p.current,
            }).map(([name, r]) => [`pvt-${name}-range`, [r.min, r.max]]),
          )
        }

        case 'read': {
          if (
            !SETTINGS.some((setting) => setting.id === request.item && setting.readable !== false)
          )
            throw new Error('This setting is not readable')

          const motor = this.motor()
          this.requireMotorSetting(request.item, [this.selected!])
          return readValue(motor, request.item as Parameters<typeof readValue>[1])
        }

        case 'write': {
          validateSetting(request.item, request.values)
          const motor = this.motor()
          const key = this.selected!
          this.requireMotorSetting(request.item, [key])
          this.command = undefined
          this.publish()

          return this.writeSetting(request, motor, key)
        }

        case 'shutdown':
          await this.dispose()
          return null
      }
    })
  }

  private requireBatch() {
    if (this.view !== 'batch') throw new Error('Batch view is not active')
  }

  private requireMotorSetting(item: string, keys: readonly string[]) {
    if (supportsDexHandJointSetting(item)) return
    const hasJoint = [...this.adapters.values()].some(({ info }) =>
      info.motors.some((motor) => motor.dexHandKey && keys.includes(motor.key)))
    if (hasJoint)
      throw new Error(item === 'id'
        ? 'DexHand joint CAN IDs are fixed by the gateway'
        : 'This setting is unavailable on DexHand joints')
  }

  private prepareDexHand(
    entry: ActiveAdapter,
    location: HandBus,
    baseId: number,
    previousKey?: string,
  ): PreparedDexHand {
    const { adapter, info } = entry
    const { slaveId, busId } = location
    const usesId = (id: number) => id >= baseId && id <= baseId + 2
    const sameBus = (address: { slaveId: number | null; busId: number | null }) =>
      address.slaveId === slaveId && address.busId === busId
    if (
      info.devices.some((d) => d.kind === 'dexhand' && d.key !== previousKey && sameBus(d) &&
        baseId <= d.deviceId + 2 && d.deviceId <= baseId + 2) ||
      info.motors.some((m) => (!previousKey || m.dexHandKey !== previousKey) && sameBus(m) &&
        usesId(m.motorId & 0x1fffffff))
    ) throw new Error('A motor or DexHand already uses one of these CAN IDs on this bus')

    const bus = slaveId === null ? adapter.getBus(busId) : adapter.getBus(slaveId, busId)
    const addressKey = JSON.stringify([info.key, slaveId, busId, 'dexhand', baseId])
    const address: PreparedDexHand['address'] = {
      key: addressKey, adapterKey: info.key, slaveId, busId, kind: 'dexhand', deviceId: baseId, origin: 'manual',
    }
    return { address, bus, connection: createDexHand(bus, this.runtime!, baseId) }
  }

  private async attachDexHandMotors(entry: ActiveAdapter, { address, bus }: PreparedDexHand) {
    const runtime = this.runtime!
    const model = runtime.stringToMotorModel('EC_DEXTEROUS_HAND')
    const properties = runtime.getMotorModelRanges(model)
    const { adapterKey, slaveId, busId } = address
    const addresses: MotorAddress[] = []
    const motors = new Map<string, MotorWrapper>()

    try {
      for (const joint of dexHandJoints(address.deviceId)) {
        const key = motorKey(adapterKey, slaveId, busId, joint.motorId)
        const motor = await bus.getMotor(joint.motorId, { model, canfd: true })
        motors.set(key, motor)
        addresses.push({
          ...joint, key, adapterKey, slaveId, busId,
          canfd: true, eff: false, origin: 'manual', dexHandKey: address.key,
          properties,
        })
      }
    } catch (error) {
      for (const motor of motors.values()) runtime.deleteMotor(motor)
      throw error
    }

    entry.info.motors.push(...addresses)
    for (const [key, motor] of motors) this.motors.set(key, motor)
  }

  private removeDexHandMotors(entry: ActiveAdapter, handKey: string) {
    for (const child of entry.info.motors.filter((motor) => motor.dexHandKey === handKey)) {
      const motor = this.motors.get(child.key)
      if (motor && !this.runtime!.deleteMotor(motor))
        this.logError(`Could not release ${child.jointLabel}`)
      this.motors.delete(child.key)
      if (this.selected === child.key) {
        this.controlLoop.select()
        this.selected = undefined
      }
    }
    entry.info.motors = entry.info.motors.filter((motor) => motor.dexHandKey !== handKey)
    this.batch.keys = this.batch.keys.filter((key) => this.motors.has(key))
  }

  private async dexHandSetting(request: Extract<Request, { type: 'dex-hand-setting' }>) {
    const connection = this.dexHands.get(request.deviceKey)
    const entry = [...this.adapters.values()].find(({ info }) =>
      info.devices.some((device) => device.key === request.deviceKey))
    const device = entry?.info.devices.find((device) => device.key === request.deviceKey)
    if (!connection || !entry || !device || device.busId === null)
      throw new Error('DexHand no longer exists')

    if (request.values === undefined) {
      if (request.item === 'base-id') return String(dexHandValue(await connection.handle.getBaseId()))
      if (request.item === 'sample-points')
        return formatDexHandPoints(dexHandValue(await connection.handle.getSamplePoints()))
      throw new Error('Unknown DexHand setting')
    }
    const setting = parseDexHandSetting(request.item, request.values)
    if (setting.item === 'sample-points')
      return formatDexHandPoints(dexHandValue(await connection.handle.setSamplePoints(setting.points)))
    if (setting.baseId === device.deviceId)
      return String(dexHandValue(await connection.handle.setBaseId(setting.baseId)))

    this.batch.stop()
    const prepared = this.prepareDexHand(entry, { slaveId: device.slaveId, busId: device.busId },
      setting.baseId, device.key)
    try {
      dexHandValue(await connection.handle.setBaseId(setting.baseId))
    } catch (error) {
      prepared.connection.remove(prepared.connection.handle)
      throw error
    }
    if (!connection.remove(connection.handle))
      this.logError('Could not release the previous DexHand address')
    this.dexHands.delete(device.key)
    this.dexHands.set(prepared.address.key, prepared.connection)
    this.removeDexHandMotors(entry, device.key)
    entry.info.devices = entry.info.devices.map((item) => item === device ? prepared.address : item)
    this.watching = prepared.address.key
    try {
      await this.attachDexHandMotors(entry, prepared)
    } catch (error) {
      throw new Error(`DexHand changed to base ID ${setting.baseId}. Its joints could not be opened: ${message(error)}. Remove it from the tree and add it at the new base ID to retry.`)
    } finally {
      this.publish()
    }
    return String(setting.baseId)
  }

  private batchTargets() {
    const keys = [...this.batch.keys]

    if (!keys.length) throw new Error('Select at least one motor')

    if (keys.some((key) => !this.motors.has(key)))
      throw new Error('Selected motor no longer exists')

    return keys
  }

  private motorLabel(key: string) {
    for (const { info } of this.adapters.values()) {
      const motor = info.motors.find((m) => m.key === key)

      if (motor)
        return `${info.type}:${info.interfaceName} / Slave ${motor.slaveId ?? 0} / Bus ${motor.busId} / ${motor.jointLabel ?? `Motor ${motor.motorId} (${hexId(motor.motorId)})`}`
    }

    return key
  }

  private async batchEach(
    keys: string[],
    action: string,
    operation: (motor: MotorWrapper, key: string) => Promise<void>,
  ) {
    const errors: string[] = []

    for (const key of keys) {
      const label = this.motorLabel(key)

      this.emit({ type: 'log', level: 'info', message: `${label}: ${action} started` })

      try {
        const motor = this.motors.get(key)

        if (!motor) throw new Error('Motor no longer exists')

        await operation(motor, key)
        this.emit({ type: 'log', level: 'info', message: `${label}: ${action} OK` })
      } catch (error) {
        const failure = `${label}: ${action} failed: ${message(error)}`

        errors.push(failure)
        this.emit({ type: 'log', level: 'error', message: failure })
      }
    }

    if (errors.length)
      throw new Error(`${errors.length}/${keys.length} operations failed. ${errors.join('; ')}`)
  }

  private async writeSetting(
    request: Extract<Request, { type: 'write' }>,
    motor: MotorWrapper,
    key: string,
  ) {
    const v = request.values.map(Number),
      range = { min: v[0], max: v[1] }

    switch (request.item) {
      case 'id': {
        const old = key

        const address = [...this.adapters.values()]
          .flatMap((entry) => entry.info.motors)
          .find((item) => item.key === old)!

        if (this.adapters.get(address.adapterKey)?.info.devices.some((device) =>
          device.kind === 'dexhand' && device.slaveId === address.slaveId &&
          device.busId === address.busId && v[0] >= device.deviceId && v[0] <= device.deviceId + 2))
          throw new Error('CAN ID belongs to a DexHand on this bus')

        if (
          [...this.adapters.values()]
            .flatMap((entry) => entry.info.motors)
            .some(
              (item) =>
                item.adapterKey === address.adapterKey &&
                item.slaveId === address.slaveId &&
                item.busId === address.busId &&
                item.motorId === v[0] &&
                item.key !== old,
            )
        )
          throw new Error('CAN ID already exists on this bus')

        await ack(motor.setId(v[0], true))
        address.motorId = v[0]
        address.key = motorKey(address.adapterKey, address.slaveId, address.busId, v[0])
        this.motors.delete(old)
        this.motors.set(address.key, motor)
        this.selected = address.key
        this.controlLoop.select(address.key, motor)
        this.publish()
        break
      }

      case 'position':
        await ack(
          v.length ? motor.setPosition(degreesToRadians(v[0])) : motor.resetZeroPosition(true),
        )
        break

      case 'pvt-kp-range':
        await ack(motor.setPvtKpRange(range, true))
        break

      case 'pvt-kd-range':
        await ack(motor.setPvtKdRange(range, true))
        break

      case 'pvt-pos-range':
        await ack(motor.setPvtPosRange(range, true))
        break

      case 'pvt-spd-range':
        await ack(motor.setPvtSpdRange(range, true))
        break

      case 'pvt-tor-range':
        await ack(motor.setPvtTorRange(range, true))
        break

      case 'pvt-cur-range':
        await ack(motor.setPvtCurRange(range, true))
        break

      case 'cur-pi':
        await ack(motor.setCurPi({ kp: v[0], ki: v[1] }, true))
        break

      case 'spd-pi':
        await ack(motor.setSpdPi({ kp: v[0], ki: v[1] }, true))
        break

      case 'pos-pd':
        await ack(motor.setPosPd({ kp: v[0], kd: v[1] }, true))
        break

      case 'can-timeout':
        await ack(motor.setCanTimeout(v[0], true))
        break

      case 'comm':
        await ack(
          motor.setCommunicationMode(
            {
              can: MotorCommunicationMode.ClassicCan,
              canfd: MotorCommunicationMode.CanFd,
              canopen: MotorCommunicationMode.CanOpen,
            }[request.values[0] as 'can'],
            true,
          ),
        )
        break
    }

    const address = [...this.adapters.values()]
      .flatMap((entry) => entry.info.motors)
      .find((item) => item.key === (request.item === 'id' ? this.selected : key))

    if (address) {
      address.properties = motor.getProperties()
      this.publish()
    }

    return 'Setting applied'
  }

  private async loadPlay(config: import('./protocol.js').PlayConfig) {
    validatePlayConfig(config)

    const timing = validateTiming(config.timing ?? {}, false)
    let trajectory: ReturnType<typeof parseTrajectoryCsv>

    try {
      trajectory = parseTrajectoryCsv(config.path)
    } catch (error) {
      const detail = (error as Error).message

      throw new Error(
        /[\u4e00-\u9fff]/.test(detail)
          ? 'Invalid CSV: expected time and motor-address columns, numeric positions and strictly increasing timestamps'
          : detail,
      )
    }

    const ids = trajectory.motors.map((m) =>
      JSON.stringify([m.adapterType, m.adapterId, m.slaveId ?? null, m.busId, m.motorId]),
    )

    if (new Set(ids).size !== ids.length) throw new Error('CSV contains duplicate motor addresses')

    this.playback.stop()
    this.batch.stop()
    this.controlLoop.select()
    this.watching = undefined

    if (config.dryRun) {
      const adapters: AdapterInfo[] = []

      const motors = trajectory.motors.map((m) => {
        const adapterKey = JSON.stringify([m.adapterType, m.adapterId]),
          slaveId = m.slaveId ?? null

        let adapter = adapters.find((a) => a.key === adapterKey)

        if (!adapter) {
          adapter = {
            key: adapterKey,
            type: m.adapterType,
            interfaceName: m.adapterId,
            buses: [],
            motors: [],
            devices: [],
          }

          adapters.push(adapter)
        }

        if (!adapter.buses.some((b) => b.slaveId === slaveId && b.busId === m.busId))
          adapter.buses.push({ slaveId, busId: m.busId })

        const motor = {
          key: motorKey(adapterKey, slaveId, m.busId, m.motorId),
          adapterKey,
          slaveId,
          busId: m.busId,
          motorId: m.motorId,
          canfd: false,
          eff: false,
        }

        adapter.motors.push(motor)

        return motor
      })

      const addresses = trajectory.motors.map((m, i) => ({
        adapterType: m.adapterType,
        interfaceName: m.adapterId,
        slaveId: m.slaveId,
        busId: m.busId,
        motorId: m.motorId,
        trajectoryIndex: i,
      }))

      this.playback.load(
        { ...config, path: resolve(config.path), timing },
        trajectory,
        motors,
        addresses,
      )

      this.playback.state!.adapters = adapters
      this.publish()

      return this.playback.state
    }

    const created: string[] = []

    try {
      for (const m of trajectory.motors) {
        const key = JSON.stringify([m.adapterType, m.adapterId])

        if (!this.adapters.has(key)) {
          await ensureSshAdapterPermissions(m.adapterType)

          const adapter = await createAdapter(
            this.runtime!,
            { type: m.adapterType, id: m.adapterId },
            timing,
            LogLevel.Warn,
          ).catch((error) => {
            throw new Error(
              `Could not connect ${m.adapterType}:${m.adapterId}: ${error.cause instanceof Error ? error.cause.message : 'driver rejected the connection'}`,
            )
          })

          created.push(key)

          this.adapters.set(key, {
            adapter,
            info: {
              key,
              type: m.adapterType,
              interfaceName: m.adapterId,
              buses: [],
              motors: [],
              devices: [],
              timing,
            },
          })
        }
      }

      const scanned = new Set<string>(),
        native = loadEmcliNative()

      for (const m of trajectory.motors) {
        const key = JSON.stringify([m.adapterType, m.adapterId]),
          entry = this.adapters.get(key)!,
          slave = m.slaveId ?? null

        const busId = JSON.stringify([key, slave, m.busId])

        if (scanned.has(busId)) continue

        scanned.add(busId)

        if (entry.info.devices.some((d) => d.kind === 'glove' && d.slaveId === slave))
          throw new Error('A glove slave cannot play motor trajectories')

        if (
          !created.includes(key) &&
          Object.keys(timing).length &&
          !entry.adapter.updateBusExtend(timingEnvelope(slave, m.busId, timing))
        )
          throw new Error('Adapter rejected playback bus timing')

        const rows = native.scan({
          type: m.adapterType,
          interfaceName: m.adapterId,
          ...(slave === null ? {} : { slaveId: slave }),
          busId: m.busId,
        })

        entry.info.buses = [...entry.adapter.getBuses().keys()].map((raw) =>
          decodeAdapterBusId(raw),
        )

        // Explicit CSV motors are verified by getMotor; other discovered motors hold their initial positions.
        const targets = [
          ...rows,
          ...trajectory.motors
            .filter(
              (x) =>
                x.adapterType === m.adapterType &&
                x.adapterId === m.adapterId &&
                (x.slaveId ?? null) === slave &&
                x.busId === m.busId,
            )
            .map((x) => ({
              slaveId: slave,
              busId: m.busId,
              motorId: x.motorId,
              canfd: false,
              eff: false,
            })),
        ]

        for (const row of targets) {
          const id = motorKey(key, row.slaveId, row.busId, row.motorId)

          if (this.motors.has(id)) continue

          const bus =
            row.slaveId === null
              ? entry.adapter.getBus(row.busId)
              : entry.adapter.getBus(row.slaveId, row.busId)

          const motor = await bus.getMotor(row.motorId),
            address = { ...row, key: id, adapterKey: key, properties: motor.getProperties() }

          this.motors.set(id, motor)
          entry.info.motors.push(address)
        }
      }

      const selected = trajectory.motors.map(
        (m) =>
          this.adapters
            .get(JSON.stringify([m.adapterType, m.adapterId]))!
            .info.motors.find(
              (item) =>
                item.motorId === m.motorId &&
                item.busId === m.busId &&
                item.slaveId === (m.slaveId ?? null),
            )!,
      )

      const holding = [...this.adapters.values()]
        .flatMap((a) => a.info.motors)
        .filter(
          (m) =>
            !selected.includes(m) &&
            scanned.has(JSON.stringify([m.adapterKey, m.slaveId, m.busId])),
        )

      const motors = [...selected, ...holding]

      const addresses = motors.map((m, i) => {
        const a = this.adapters.get(m.adapterKey)!.info

        return {
          adapterType: a.type,
          interfaceName: a.interfaceName,
          ...(m.slaveId === null ? {} : { slaveId: m.slaveId }),
          busId: m.busId,
          motorId: m.motorId,
          trajectoryIndex: i < selected.length ? i : -1,
          holding: i >= selected.length,
        }
      })

      this.playback.load(
        { ...config, path: resolve(config.path), timing },
        trajectory,
        motors,
        addresses,
      )

      this.publish()

      return this.playback.state
    } catch (error) {
      for (const key of created) {
        const entry = this.adapters.get(key)

        for (const m of entry?.info.motors ?? []) this.motors.delete(m.key)

        entry?.adapter.dispose()
        this.adapters.delete(key)
      }

      this.publish()

      throw error
    }
  }

  private async scan(key: string, busId?: number, slaveId?: number) {
    const entry = this.adapters.get(key)

    if (!entry) throw new Error('Adapter no longer exists')

    this.controlLoop.select()

    // The native scanner shares the already loaded driver and adapter singleton in this worker.
    const native = loadEmcliNative()

    const matched = (item: MotorAddress) =>
      (busId === undefined || item.busId === busId) &&
      (slaveId === undefined || (item.slaveId ?? 0) === slaveId)

    const removed = entry.info.motors.filter((item) => matched(item) && item.origin !== 'manual')

    for (const item of removed) {
      const motor = this.motors.get(item.key)

      if (motor && !this.runtime!.deleteMotor(motor))
        throw new Error('Could not remove scanned motor before rescan')

      this.motors.delete(item.key)
      entry.info.motors = entry.info.motors.filter((existing) => existing.key !== item.key)
    }

    entry.info.buses = [...entry.adapter.getBuses().keys()].map((raw) => {
      const decoded = decodeAdapterBusId(raw)

      return { slaveId: decoded.slaveId, busId: decoded.busId }
    })

    const gloves = discoverGloves(entry.info, (address) =>
      this.peripherals.add(address, entry.adapter),
    )

    for (const glove of gloves)
      this.emit({
        type: 'log',
        level: 'info',
        message: `Glove detected: ${entry.info.interfaceName}, Slave ${glove.slaveId}`,
      })

    const previous = this.selected

    if (this.selected && !this.motors.has(this.selected)) this.selected = undefined

    this.publish()

    let found: ReturnType<typeof native.scan>

    try {
      found = scanAdapter(native, entry.info, { busId, slaveId })
    } finally {
      // Discovery can reconcile transport flags on existing motors. Preserve manual configuration.
      for (const item of entry.info.motors.filter(
        (item) => item.origin === 'manual' && matched(item),
      )) {
        const motor = this.motors.get(item.key)

        if (!motor) continue

        if (item.canfd) motor.enableCanFd()
        else motor.disableCanFd()

        if (item.eff) motor.enableCanEff()
        else motor.disableCanEff()
      }
    }

    entry.info.buses = [...entry.adapter.getBuses().keys()].map((raw) => {
      const decoded = decodeAdapterBusId(raw)

      return { slaveId: decoded.slaveId, busId: decoded.busId }
    })

    for (const row of found) {
      if (
        entry.info.motors.some(
          (item) => item.key === motorKey(key, row.slaveId, row.busId, row.motorId),
        )
      )
        continue

      const bus =
        row.slaveId === null
          ? entry.adapter.getBus(row.busId)
          : entry.adapter.getBus(row.slaveId, row.busId)

      const motor = await bus.getMotor(row.motorId)

      const address = {
        ...row,
        properties: motor.getProperties(),
        origin: 'scan' as const,
        adapterKey: key,
        key: motorKey(key, row.slaveId, row.busId, row.motorId),
      }

      this.motors.set(address.key, motor)
      entry.info.motors.push(address)
    }

    if (previous && this.motors.has(previous)) this.selected = previous

    if (this.view === 'single')
      this.controlLoop.select(
        this.selected,
        this.selected ? this.motors.get(this.selected) : undefined,
      )

    this.publish()

    this.emit({
      type: 'log',
      level: 'info',
      message: `Scan complete: ${entry.info.type}:${entry.info.interfaceName}, ${found.length} motors found`,
    })
  }

  async dispose() {
    try {
      this.playback.stop()
    } catch {}

    try {
      this.performance.stop()
    } catch {}

    this.closed = true
    this.batch.stop()
    this.controlLoop.dispose()
    clearTimeout(this.timer)
    this.command = undefined

    for (const { adapter } of this.adapters.values())
      try {
        adapter.dispose()
      } catch {}

    this.adapters.clear()
    this.motors.clear()
    this.dexHands.clear()
    this.runtime?.dispose()
  }
}

function motorKey(adapter: string, slave: number | null, bus: number, id: number) {
  return JSON.stringify([adapter, slave, bus, id])
}

async function ack(result: Promise<boolean>) {
  if (!(await result)) throw new Error('The device did not acknowledge the operation')
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
