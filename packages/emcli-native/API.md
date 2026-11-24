# `@encos/emcli-native` API（草案）

> 对应 M0 设计；实现从 M1 开始。类型定义见 `src/types.ts`，C ABI 见
> `native/include/emcli_perf_abi.h`。

## 加载

```ts
import { loadEmcliNative, resolveNativePaths } from '@encos/emcli-native'

// 先解析，便于把同一个 driverPackageRoot 传给驱动运行时与性能模块。
const paths = resolveNativePaths()
const native = loadEmcliNative({ driverPackageRoot: paths.driver.packageRoot })

console.log(native.info)
// {
//   packageVersion, engineVersion, abi, napi, driverVersion,
//   driverLibPath, loaderPath, enginePath, platform, arch, build
// }
```

`resolveNativePaths` 不加载原生模块；`loadEmcliNative` 是同步的（SEA 资产释放由 `sea` 辅助在启动时
先 `await`）。

## Bench

```ts
const session = native.bench.create({
  motors: [
    { adapterType: 'Can', interfaceName: 'can0', busId: 0, motorId: 1 },
  ],
  periodsMs: [10, 5, 3, 2, 1],
  attempts: 500,
  sampleGapMs: 5,
  sampleJitterUs: 1000,
})

session.start()

for (;;) {
  const update = session.poll()
  render(update)                       // update.periods / update.motors / update.events
  if (update.phase === 'finished' || update.phase === 'error') break
  await new Promise(resolve => setTimeout(resolve, 100))
}

const result = session.stop()
session.dispose()
```

`BenchUpdate.periods[i]` 字段：`periodMs`、`state`、`stopReason`、`attempts`、`valid`、`lost`、
`meanUs`、`p1Us`、`p5Us`、`p50Us`、`p95Us`、`p99Us`、`opsPerSecond`、`errorPercent`。

## Stress

```ts
const session = native.stress.create({
  motors: discoveredMotors,
  loopPeriodMs: 1,
  warmupDelayMs: 100,
  drainDelayMs: 200,
})

session.start()
setInterval(() => {
  const update = session.poll()
  renderStress(update)                 // sent / received / lost / loopOverruns / motors
}, 100)

process.once('SIGINT', () => {
  const result = session.stop()
  session.dispose()
  console.log(result)
})
```

## Play

```ts
const session = native.play.create({
  motors: trajectoryMotors,            // 顺序与 CSV 表头一致
  trajectory: {
    timesSec,                          // Float64Array
    positionsDeg,                      // Float32Array, row-major [sample][motor]
    sampleCount,
    motorCount: trajectoryMotors.length,
  },
  holdingMotors: extraMotorsOnSameBuses,
  holdingPositionsRad: [null],         // null = 启动时读取当前位置
  mode: 'pvt',
  kp: 0,
  kd: 1,
  velocity: 0,
  torque: 0,
  endless: false,
  returnToInitial: true,
  log: { enabled: false },
})

session.start()
// 运行中：
session.pause()
session.resume()
session.setLogging(true)
const update = session.poll()
// update.phase: idle | startup | running | paused | returning | finished | error
```

## 错误

```ts
import { EmcliNativeError } from '@encos/emcli-native'

try {
  loadEmcliNative()
} catch (error) {
  if (error instanceof EmcliNativeError) {
    console.error(error.code, error.message, error.detail)
  }
}
```

常见错误码：

| 码 | 处置 |
| --- | --- |
| `EMCLI_PLATFORM_PACKAGE_MISSING` | 重装并允许 optional 依赖 |
| `EMCLI_DRIVER_PACKAGE_MISSING` | 安装 peer `@encos/encos-driver-native` |
| `EMCLI_DRIVER_VERSION_MISMATCH` | 安装与构建版本一致的驱动 |
| `EMCLI_DRIVER_INSTANCE_CONFLICT` | 移除 `LD_PRELOAD` / 统一依赖版本 |
| `EMCLI_WRONG_ENV` | 回到主线程 / 主环境，禁止 Worker |
| `EMCLI_INVALID_STATE` | 检查会话是否已 start / stop / dispose |

## 生命周期

```text
create → start → poll* → stop → dispose
                ↘ error
```

- `start()` 只能调用一次。
- `stop()` 可重复调用；返回最终结果。
- `dispose()` 会停止并释放会话；之后再调用任何方法抛 `EMCLI_INVALID_STATE`。
- `native.dispose()` 释放全部会话；不会 `dlclose` 驱动/引擎（避免回调悬空）。
- 退出顺序：`session.stop()` → `session.dispose()` → 驱动 wrapper `dispose()` → `native.dispose()`。
