// SPDX-License-Identifier: MIT

import {
  LogLevel,
  createEncosRuntime,
  type AdapterWrapper,
  type BusWrapper,
  type MotorWrapper,
  type Runtime,
} from '@encos/encos-driver-native'

import { SerialQueue } from './async.js'
import {
  decodeAdapterBusId,
  parseAdapterSpec,
  type AdapterSpec,
  type MotorTarget,
} from './target.js'

export const DEFAULT_LOG_LEVEL: number = LogLevel.Warn
export const QUIET_LOG_LEVEL: number = LogLevel.Off

const runtimeQueues = new WeakMap<Runtime, SerialQueue>()

/** 同一 Runtime 的所有 native 异步/同步调用必须共享这个队列。 */
export function runtimeQueue(runtime: Runtime): SerialQueue {
  let queue = runtimeQueues.get(runtime)
  if (queue === undefined) {
    queue = new SerialQueue()
    runtimeQueues.set(runtime, queue)
  }
  return queue
}

export { adapterTiming, runtimeOptionsFromArgs, timingExtend, type OpenRuntimeOptions, type AdapterTiming } from './runtime-options.js'
import { timingExtend, type OpenRuntimeOptions, type AdapterTiming } from './runtime-options.js'

export async function openRuntime(options: OpenRuntimeOptions = {}): Promise<Runtime> {
  // V8 must be able to discard GC pages; real-time thread scheduling remains enabled.
  process.env.ENCOS_MEMORY_LOCK ??= 'none'
  process.env.ENCOS_LOG_OUTPUT = 'stderr'
  return createEncosRuntime({
    ...(options.pluginPath === undefined ? {} : { pluginPath: options.pluginPath }),
    ...(options.packageRoot === undefined ? {} : { packageRoot: options.packageRoot }),
  })
}

export interface CreateAdapterExtras {
  /** Fake 适配器仅用于测试：默认开启自动建电机；扫描类命令关闭。 */
  fakeAutoCreate?: boolean
}

export async function createAdapter(
  runtime: Runtime,
  spec: AdapterSpec,
  timing: AdapterTiming = {},
  logLevel: number = DEFAULT_LOG_LEVEL,
  extras: CreateAdapterExtras = {},
): Promise<AdapterWrapper> {
  const extend = timingExtend(timing)
  const options = {
    type: spec.type,
    interfaceName: spec.id,
    loggerName: `emcli-${spec.type}-${spec.id}`,
    logLevel,
    ...(extend === undefined ? {} : { extend }),
  }
  try {
    const adapter = (await runtime.createAdapter(options)) as AdapterWrapper
    if (spec.type === 'Fake' && extras.fakeAutoCreate !== false) {
      adapter.getFakeAdapterControl()?.enableAutoCreateMotor()
    }
    return adapter
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const hint =
      /Failed to Initialize EtherCAT|raw socket|fd broker|permission/i.test(message)
        ? '\n提示: 运行 emcli doctor --request-permissions 授权驱动 helper，并确认接口链路已 up。'
        : ''
    throw new Error(`创建适配器 ${spec.type}:${spec.id} 失败: ${message}${hint}`, { cause: error })
  }
}

export function resolveAdapterSpecs(
  runtime: Runtime,
  rawSpecs: string[],
): AdapterSpec[] {
  const availableTypes = new Set(runtime.getAvailableAdapterTypes())
  const resolved: AdapterSpec[] = []
  const seen = new Set<string>()
  const interfacesByType = new Map<string, string[]>()

  for (const raw of rawSpecs) {
    const spec = parseAdapterSpec(raw)
    if (!availableTypes.has(spec.type) && spec.type !== 'Fake') {
      throw new Error(`未知适配器类型 '${spec.type}'（链路 '${raw}'）`)
    }
    let interfaces = interfacesByType.get(spec.type)
    if (interfaces === undefined) {
      interfaces = spec.type === 'Fake' ? [] : runtime.getAvailableInterface(spec.type)
      interfacesByType.set(spec.type, interfaces)
    }
    // 显式接口交给驱动校验；枚举不到不等于不能创建（USB CDC/远端 endpoint 等）。
    const ids = spec.id === 'ALL' ? interfaces : [spec.id]
    if (ids.length === 0 && spec.id === 'ALL') {
      console.warn(`警告: 适配器类型 '${spec.type}' 没有可用接口，跳过 '${raw}'`)
      continue
    }
    for (const id of ids) {
      const key = `${spec.type}\n${id}`
      if (seen.has(key)) continue
      seen.add(key)
      resolved.push({ type: spec.type, id })
    }
  }
  return resolved
}

export interface ResolvedMotor {
  adapter: AdapterWrapper
  bus: BusWrapper
  motor: MotorWrapper
  adapterType: string
  adapterId: string
  slaveId: number | null
  busId: number
  motorId: number
}

export interface ResolvedTargets {
  adapters: AdapterWrapper[]
  motors: ResolvedMotor[]
}

export function disposeTargets(targets: ResolvedTargets): void {
  for (const adapter of [...targets.adapters].reverse()) {
    try {
      adapter.dispose()
    } catch {
      // 清理阶段继续释放其它适配器。
    }
  }
  targets.adapters.length = 0
  targets.motors.length = 0
}

async function scanBus(
  adapter: AdapterWrapper,
  adapterType: string,
  adapterId: string,
  slaveId: number | null,
  busId: number,
  bus: BusWrapper,
): Promise<ResolvedMotor[]> {
  const motors = await bus.scanMotors()
  return [...motors.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([motorId, motor]) => ({
      adapter,
      bus,
      motor,
      adapterType,
      adapterId,
      slaveId,
      busId,
      motorId,
    }))
}

export async function resolveMotorTargets(
  runtime: Runtime,
  target: MotorTarget,
  timing: AdapterTiming = {},
  logLevel: number = DEFAULT_LOG_LEVEL,
): Promise<ResolvedTargets> {
  const interfaces =
    target.adapterId === 'ALL' ? runtime.getAvailableInterface(target.adapterType) : [target.adapterId]
  if (interfaces.length === 0) {
    throw new Error(`适配器类型 '${target.adapterType}' 没有可用接口`)
  }

  const adapters: AdapterWrapper[] = []
  const motors: ResolvedMotor[] = []
  const seenMotors = new Set<number>()

  try {
    for (const interfaceName of interfaces) {
      const adapter = await createAdapter(
        runtime,
        { type: target.adapterType, id: interfaceName },
        timing,
        logLevel,
      )
      adapters.push(adapter)

      const append = (resolved: ResolvedMotor[]): void => {
        for (const entry of resolved) {
          if (seenMotors.has(entry.motor.handle)) continue
          seenMotors.add(entry.motor.handle)
          motors.push(entry)
        }
      }

      if (target.scope === 'motor') {
        if (target.busId === undefined || target.motorId === undefined) {
          throw new Error('目标缺少 BusId 或 MotorId')
        }
        const bus =
          target.slaveId === undefined
            ? adapter.getBus(target.busId)
            : adapter.getBus(target.slaveId, target.busId)
        const motor = await bus.getMotor(target.motorId)
        append([
          {
            adapter,
            bus,
            motor,
            adapterType: target.adapterType,
            adapterId: interfaceName,
            slaveId: target.slaveId ?? null,
            busId: target.busId,
            motorId: target.motorId,
          },
        ])
        continue
      }

      if (target.scope === 'bus') {
        if (target.busId === undefined) {
          throw new Error('目标缺少 BusId')
        }
        const bus =
          target.slaveId === undefined
            ? adapter.getBus(target.busId)
            : adapter.getBus(target.slaveId, target.busId)
        append(
          await scanBus(
            adapter,
            target.adapterType,
            interfaceName,
            target.slaveId ?? null,
            target.busId,
            bus,
          ),
        )
        continue
      }

      let buses = adapter.getBuses()
      if (buses.size === 0) {
        adapter.getBus(0)
        buses = adapter.getBuses()
      }
      for (const [rawIndex, bus] of [...buses.entries()].sort((left, right) => left[0] - right[0])) {
        const decoded = decodeAdapterBusId(rawIndex)
        append(
          await scanBus(
            adapter,
            target.adapterType,
            interfaceName,
            decoded.slaveId,
            decoded.busId,
            bus,
          ),
        )
      }
    }
  } catch (error) {
    disposeTargets({ adapters, motors })
    throw error
  }

  if (motors.length === 0) {
    disposeTargets({ adapters, motors })
    throw new Error('目标没有匹配到任何电机')
  }

  motors.sort((left, right) => {
    if ((left.slaveId ?? -1) !== (right.slaveId ?? -1)) {
      return (left.slaveId ?? -1) - (right.slaveId ?? -1)
    }
    if (left.busId !== right.busId) return left.busId - right.busId
    return left.motorId - right.motorId
  })
  return { adapters, motors }
}
