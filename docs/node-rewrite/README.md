# emcli Node.js 重写

本目录记录 Node.js 完全重写工作的设计与实施文档。旧界面已替换为 Ink；从站管理与 OTA 协议代码保留在原生模块中。

## 代码位置

- CLI 应用：[`apps/emcli/`](../../apps/emcli/)
- 原生性能模块：[`packages/emcli-native/`](../../packages/emcli-native/)
- 工作区根：[`package.json`](../../package.json)

## 文档

| 文档 | 内容 | 状态 |
| --- | --- | --- |
| [emcli-native 包设计](emcli-native-package-design.md) | 性能模块的 npm 包结构、双原生产物、动态链接、C ABI、SEA、单进程单例约束 | 设计稿（M0） |
| [CI 与包发布](ci-release.md) | Linux amd64/arm64、Windows artifact 与 Debian/RPM 发布流程 | 已实现，待远端全矩阵验证 |
| [CLI 输出样式](cli-output.md) | scan/config/control/imu/battery/pms/glove/play/bench/stress/doctor 的实际输出样例 | 当前实现 |
| [TUI 基础组件与画廊](tui-components.md) | Card/Button/Tabs/Dropdown/Tree/Table/LineChart 与画廊截图 | 当前实现 |

## 当前分支

`feat/node-emcli-rewrite`

## 里程碑

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| M0 | 包设计、ABI 草案、本地 SDK 解析器 | 完成 |
| M1 | CLI 功能版（scan/config/control/IMU/电池/PMS/手套/bench/stress/play，无 TUI） | 完成 |
| M1.5 | 加载器 + 引擎骨架、Fake 自检 | 进行中 |
| M2 | bench 迁移 | 待开始 |
| M3 | stress 迁移 | 待开始 |
| M4 | play 迁移 | 待开始 |
| M5 | TUI + SEA 打包 | Ink TUI 已实现；Linux/Windows x64 SEA 单文件打包及 FakeAdapter 验证已实现 |
| M6 | 三平台发布 | CI、artifact、DEB/RPM/tar 与条件发布已实现；待远端全矩阵验证 |

## 已完成

- 删除旧 C++ 源码、组件、测试、CMake、子模块、旧打包/CI/发布脚本。
- 工作区迁移到仓库根目录（`apps/` + `packages/`）。
- CLI 功能版：`scan`、`config`、`control`、`imu`、`battery`、`pms`、`glove`、`play`、
  `bench`、`stress`、`doctor`（无 TUI）。
- `@encos/emcli-native` 的选择器包、C ABI、路径解析、本地 SDK 解析器与测试。
- 驱动侧 SEA 加载支持（`packageRoot` / `loadAddon`）已在 `../motor_driver` 修改，未提交；
  4.1.2 已发布包也包含等价接口。

## CLI v1 说明

- scan/bench/stress/play 已迁移到原生性能引擎；TUI 会话操作使用串行队列。
- `config` 已接入从站 IP/slave/mode/version/reboot/raw/download；`scan --slave` 支持 Ethernet UUID 与 Ethercat 从站索引。
- CLI 统一输出普通文本；不支持 `--no-inplace-refresh` 或交互键盘 UI。Bench 不接受 `--canfd`。
- Play 支持离线 `--dry-run`；首次 Ctrl+C 平滑返回，第二次立即退出。
- CLI `--log[=DIR]` / `--log-directory DIR` 与 TUI Motor log 使用驱动原生日志；默认目录为 `./logs`，dry-run 不记录电机日志。
- Ink TUI 首期已实现，见 [Motor Studio](motor-studio.md)。
