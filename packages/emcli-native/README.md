# `@encos/emcli-native`

`emcli` 的 C++ 性能模块，提供：

- `scan`：多 bus 并发电机发现
- `stress`：原生 PVT 压力循环
- `bench`：原生 Position 查询延迟基准
- `play`：原生轨迹播放控制循环，`requestReturn()` 平滑返回，`stop()` 立即结束
- `motorLog`：驱动原生电机日志开启/关闭
- `scanSlaves` / `slave`：旧版从站发现、UDP/CDC 配置和固件 OTA 升级

真实硬件的 `bench` / `stress` / `scan` / `play` 必须通过本包执行；离线 dry-run 不连接原生引擎。

各测试/播放/扫描选项的 `timing` 传入适配器创建配置，字段为 `bitrate/dbitrate/sample_point/dsample_point`。
从站与 OTA 实现位于 `native/legacy`，来自旧版 ed54398；serialib 保留其 MIT 许可证。
运行 `pnpm test:firmware` 验证 OTA 包校验和、格式、ELF 拒绝及升级确认，不访问设备。

## 构建

本模块需要本地 `encos_driver` SDK（头文件 + `libencosdriver.so`）：

```bash
pnpm build:perf
# 输出 packages/emcli-native/build/emcli_perf.node
```

可用环境变量：

| 变量 | 作用 |
| --- | --- |
| `EMCLI_DRIVER_PREFIX` | 本地 SDK 前缀，默认 `/usr/local` |
| `NODE_INCLUDE_DIR` | `node_api.h` 所在目录 |
| `EMCLI_PERF_OUT` | 输出 `.node` 路径 |
| `EMCLI_PERF_ADDON` | 运行时覆盖 addon 路径 |

## 加载约束

addon 的 `DT_NEEDED` 只有 `libencosdriver.so.4` / `libencosdriver_base.so.4` 的 SONAME，
没有 RPATH。调用方必须先初始化 `@encos/encos-driver-native`，再调用
`loadEmcliNative()`；这样动态加载器会复用进程内唯一的驱动实例。

```ts
import { createEncosRuntime } from '@encos/encos-driver-native'
import { loadEmcliNative } from '@encos/emcli-native'

const runtime = await createEncosRuntime()
const native = loadEmcliNative()

const rows = native.scan({ type: 'Ethercat', interfaceName: 'eth0' })
const bench = native.bench({ motors, periodMs: 10, attempts: 500 })
const session = native.stress({ motors, periodMs: 1 })
session.start()
console.log(session.poll())
session.stop()
```

`play` 的控制循环也在 C++ 中；CLI 只负责解析 CSV、启动/轮询/停止会话。

完整设计文档：[`docs/node-rewrite/emcli-native-package-design.md`](../../docs/node-rewrite/emcli-native-package-design.md)。
