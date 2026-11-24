# emcli

Encos Motor Debugger 的 Node.js 重写版。

> 状态：CLI + Ink TUI 首期功能版。旧 C++ 实现已从本分支移除，历史保留在 git 中。
> `scan`、`bench`、`stress`、`play` 已强制使用 `@encos/emcli-native` 的 C++ 引擎，
> 不再提供 JS 回退实现。

## 依赖

- Node.js >= 22
- `@encos/encos-driver-native` 4.3.1（含当前平台包）
- Linux glibc >= 2.28（x64 / arm64）或 Windows x64
- 构建原生模块时需要本地 `encos_driver` SDK（当前基线 4.3.1）

## 结构

```text
apps/
  emcli/                 CLI 与 Motor Studio TUI
packages/
  emcli-native/          @encos/emcli-native 原生性能模块
docs/node-rewrite/       设计与里程碑、TUI 组件画廊
```

## 安装与构建

```bash
pnpm install
pnpm -r build

node apps/emcli/dist/main.js --help
```

也可以把 `apps/emcli` 的 `dist/main.js` 作为 `emcli` 入口（`package.json` 已声明 `bin`）。

## Motor Studio（正式 TUI）

```bash
pnpm --filter @encos/emcli build
node apps/emcli/dist/main.js tui
node apps/emcli/dist/main.js tui Ethercat:eth0
# 原生 Fake 适配器，8 台模拟电机，不连接真实硬件
node apps/emcli/dist/main.js tui --demo
# 开发模式
pnpm --filter @encos/emcli tui --demo
```

交互式终端中不带命令也会进入 TUI；管道环境保留帮助输出。
界面沿用旧版左侧设备树、右侧 Control / Settings / Graph 的结构，新增 Logs 页。
支持添加/断开适配器、全局/适配器/总线重扫、六种连续控制、机械抱闸、原有全部设置项、
位置/速度/电流/功率实时图表。界面为英文，方向键和 Tab 导航，Enter 激活控件。
`Disable` 只停止连续发送，`Stop` 发送选定制动模式，两者含义不同。

驱动在独立子进程中运行，stdout/stderr 捕获到日志卡片；IPC 单独传输状态和操作结果。
正常退出、Ctrl+C 确认退出和 SIGTERM 会清理会话并恢复原终端页面。
详见 [TUI 首期功能对照与使用说明](docs/node-rewrite/motor-studio.md)。

### DexHand

使用带 DexHand 接口的 Encos driver 4.3.1 和与其匹配的原生性能模块。
在设备树选中总线，从该总线的菜单选择 **Add DexHand**，输入十进制或十六进制基址。
界面会展开为一个 DexHand 和 20 个关节电机，按基址起的三个 CAN ID 分成 7、7、6 槽。
创建关节时直接加载 `EC_DEXTEROUS_HAND` 型号的预置参数。

选中 DexHand 可运行 **Stress**，并在 **Settings** 查询和配置基址、仲裁域和数据域采样点。
采样点以百分比显示。改址获确认后，界面更新三个 CAN ID 及其关节地址。
设备树和性能列表按手指分组，每根手指的关节按编号排列。关节的控制、图表和支持的电机设置可单独操作，
CAN ID 由 DexHand 基址统一决定，关节设置页省略 CAN 超时和通信模式。
总线、从站和适配器上的 Stress 会纳入关节。Bench 也向关节发送控制压力，
延迟采样仅通过普通电机的 Position 查询取得。

Ethercat_8CAN 固件的 SIM 在每个 CAN 通道提供独立的 DexHand。CAN0 默认基址为 `9`，CAN1–7 默认为 `1`。
使用支持 64 字节 CAN FD + BRS 的物理链路，默认仲裁和数据速率为 1 Mbps / 5 Mbps。

## 命令

| 命令 | 说明 |
| --- | --- |
| `tui [Type:Interface ...]` | 交互式 Motor Studio，可预加载多个适配器 |
| `scan [Type[:Id[:BusId]]]` | 列出适配器/接口，或扫描指定链路的电机 |
| `config <target> <item> [set ...]` | 读取/写入电机配置、抱闸、通信模式 |
| `control <mode> <target> ...` | 连续 pvt/position/speed/current/torque/stop，或单次 brake |
| `imu show\|start\|stop <target>` | IMU 状态与启停 |
| `battery show\|clear <target>` | 电池状态与清错 |
| `pms show\|enable\|disable <target> [V48_x...]` | PMS 状态与 V48 通道 |
| `glove show\|calibrate <target> ...` | 手套编码器状态与校准 |
| `play <trajectory.csv>` | 轨迹播放 |
| `bench <Type:Id...>` | Position 查询延迟基准 |
| `stress <Type:Id...>` | PVT 压力测试 |
| `doctor` | 检查 Node、驱动与原生路径 |

目标格式：

```text
Type:Id:ALL
Type:Id:BusId:ALL
Type:Id:BusId:MotorId
Type:Id:SlaveId:BusId:ALL
Type:Id:SlaveId:BusId:MotorId
```

CAN 位时序选项（可选，作用于本次命令创建的适配器）：

```bash
--bitrate BPS
--dbitrate BPS
--sample-point RATIO
--dsample-point RATIO
```

示例：

```bash
node apps/emcli/dist/main.js scan
node apps/emcli/dist/main.js scan Can:can0
node apps/emcli/dist/main.js config Can:can0:0:1 position
node apps/emcli/dist/main.js config Can:can0:0:1 pvt-kp-range set 1 500
node apps/emcli/dist/main.js control pvt Can:can0:0:1 20 1 45 0 0
node apps/emcli/dist/main.js imu show Ethercat:eth0:0:0
node apps/emcli/dist/main.js pms enable Ethercat:eth0:0 V48_1 V48_2
node apps/emcli/dist/main.js bench Can:can0
node apps/emcli/dist/main.js stress Can:can0 --loop-period-ms 1
node apps/emcli/dist/main.js play trajectory.csv --kp 20 --kd 1 --vel 0 --tor 0
```

## 实机验证（EtherCAT 模拟电机）

在 `Ethercat:enx6c1ff7bd2e87`、slave 0 / bus 1 上验证了 8 台模拟电机（ID 1–8）：

```bash
node apps/emcli/dist/main.js scan Ethercat:enx6c1ff7bd2e87:0:1
node apps/emcli/dist/main.js config Ethercat:enx6c1ff7bd2e87:0:1:1 position
node apps/emcli/dist/main.js control pvt Ethercat:enx6c1ff7bd2e87:0:1:1 20 1 10 0 0
node apps/emcli/dist/main.js bench --attempts 20 --periods 10,5 Ethercat:enx6c1ff7bd2e87:0:1:1
node apps/emcli/dist/main.js stress --loop-period-ms 10 Ethercat:enx6c1ff7bd2e87:0:1:1
node apps/emcli/dist/main.js play trajectory.csv --control-frequency 100 --kp 20 --kd 1 --vel 0 --tor 0
```

`scan` 在 bus 1 找到 ID 1–8；`scan Ethercat:<iface>` 会并发扫描全部 bus，64 台电机约 4.5 s。
`config` 可读 position/kt/PVT 范围。C++ 性能模块启用后：

- `bench`：P50 约 2.6–2.9 ms，P1 约 2.26 ms，P99 约 3.36 ms，符合 2.3–4 ms 区间。
- `stress`：64 台电机 / 1 ms 周期达到 **约 64,000 PVT/s**，实测 5.5 s 发送 35 万+ 次。
- `play`：8 台电机 PVT 约 503 次发送 / 503 次接收。

模拟电机不返回普通状态帧，因此 `control` 默认用 `getParameter(Position)` 轮询显示位置；
需要等待控制反馈时加 `--wait-feedback`。

## 已知限制

- TUI 已通过原生 Fake 集成测试与终端启动/退出检查，Windows 单文件的 Fake CLI 与 TUI 启动/退出也已验证；尚未验证实机操作。
- `scan` / `bench` / `stress` / `play` 强制使用 C++ 性能模块，缺少原生引擎时会报告错误。
- 驱动在 EtherCAT 初始化时会调用 `mlockall`，Node/V8 正常退出可能在
  `BoundedPageAllocator` 处触发 CHECK；CLI 在命令结束后显式 `process.exit` 规避。
  这是驱动/Node 兼容性 workaround，长期应由驱动修复。
- `config` 支持从站 IP/slave/mode/version/reboot/raw/download，`scan --slave` 支持从站发现。固件下载保留旧版 OTA 确认流程，迁移后尚未实机验证。
- CLI 输出普通文本，交互功能使用 `tui`。已移除 `--no-inplace-refresh` 和 Bench 的 `--canfd`。
- Play 支持 `--dry-run`；Motor log 调用驱动原生日志（默认 `./logs`），不再记录界面快照。
- Fake 适配器会自动建电机以便离线测试；`scan`/`stress` 扫描时已关闭自动建电机。
- `scan Ethercat:<iface>` 不带 bus 时会对适配器报告的全部 bus 做发现，可能较慢；
  建议使用 `scan Ethercat:<iface>:<slave>:<bus>`。

## TUI 组件画廊

```bash
pnpm --filter @encos/emcli gallery
```

当前提供 Card、Button、Tabs、Dropdown、TreeList、Table、LineChart、MenuBar 等基础组件，
支持鼠标点击、焦点环、单选/多选下拉和菜单栏下拉；四个标签页画廊可直接交互。
详见 [TUI 组件文档](docs/node-rewrite/tui-components.md)。

## 关键约束

驱动 `encosdriver.node` 与原生性能模块必须在**同一进程、同一主线程环境**中加载，
并且进程内只能存在一份 `libencosdriver`；否则会破坏 `EncosDriverManager` 单例和 adapter 共享。
TUI 中二者均在同一个驱动子进程中加载，前台进程只处理界面。
详见 [设计文档](docs/node-rewrite/emcli-native-package-design.md) 第 10 节。

CLI integration: add `--json` for structured JSON/JSONL output; see [JSON API v1](docs/node-rewrite/json-api.md).

Single executable: `pnpm build:single`, then `pnpm test:single`. See [build and FakeAdapter verification](docs/node-rewrite/single-executable.md).
