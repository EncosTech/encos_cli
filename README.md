Encos Motor Debugger
=====================

简介

Encos Motor Debugger 是一个基于终端的调试与监控工具，用于与 Encos 电机驱动交互（使用 FTXUI 提供界面）。本项目为闭源专有软件。

依赖

- encos_driver（在 Debian/Ubuntu 系统上的包名：libencosdriver）
- CMake >= 3.14
- C++ 编译器，支持 C++17 或更高

快速构建与运行

在项目根目录下执行：

```bash
# 从源构建
cmake -S . -B build
cmake --build build -j

# 运行（可在 build 目录下直接运行二进制）
./build/emcli

# 可选：为运行授予网络权限（如果需要与硬件通信）
sudo setcap cap_net_raw,cap_net_admin+ep ./build/emcli
```

运行模式

`emcli` 支持两种运行方式：

- 纯 CLI 模式：使用 `scan`、`config`、`control`、`imu`、`battery`、`pms`、`glove`、`bench`、`stress` 子命令直接完成扫描、配置读写、连续控制、传感器状态查看、性能基准测试和压力测试，适合脚本、自动化检查和非交互式操作。
- 原 TUI 模式：使用 FTXUI 终端界面进行交互式调试和监控。

启动原 TUI

不带子命令时会进入原 TUI：

```bash
./build/emcli
```

也可以显式使用 `tui` 子命令，并可预加载适配器：

```bash
./build/emcli tui
./build/emcli tui Ethercat:eth0
./build/emcli tui Ethercat:eth0 Ethercat:ALL
```

纯 CLI 模式

通用命令格式：

```bash
./build/emcli <command> [args]
./build/emcli <command> -h
./build/emcli config <target> <item> -h
./build/emcli control <mode> -h
```

目标格式：

```text
AdapterType:AdapterId:ALL
AdapterType:AdapterId:BusId:ALL
AdapterType:AdapterId:BusId:MotorId
AdapterType:AdapterId:SlaveId:BusId:ALL
AdapterType:AdapterId:SlaveId:BusId:MotorId
```

扫描适配器和电机：

```bash
# 列出某类适配器的可用接口
./build/emcli scan Ethercat

# 扫描适配器上的所有总线
./build/emcli scan Ethercat:eth0

# 扫描指定总线
./build/emcli scan Ethercat:eth0:0

# 扫描指定从站和总线
./build/emcli scan Ethercat:eth0:3:0
```

扫描电机时输出制表符分隔表格：

```text
slave\tbus\tid\teff\tcanfd
```

配置读写：

```bash
# 读取配置
./build/emcli config Ethercat:eth0:3:0:1 kt
./build/emcli config Ethercat:eth0:3:0:1 position
./build/emcli config --canfd Ethercat:eth0:3:0:1 position
./build/emcli config Ethercat:eth0:ALL kt
./build/emcli config Ethercat:eth0:0:ALL position

# 写入配置
./build/emcli config Ethercat:eth0:0:1 id set 2
./build/emcli config Ethercat:eth0:3:0:1 kt set 0.120000
./build/emcli config Ethercat:eth0:3:0:1 pvt-kp-range set 1 500
./build/emcli config Ethercat:eth0:3:0:1 position set 0
./build/emcli config Ethercat:eth0:3:0:1 position set 45
./build/emcli config Ethercat:eth0:3:0:1 position reset
./build/emcli config Ethercat:eth0:3:0:1 comm set canfd
./build/emcli config Ethercat:eth0:3:0:1 calibrate set -90 90 1 2
./build/emcli config Ethercat:eth0:3:0:ALL kt set 0.120000
```

`config` 对 `ALL` 目标会按匹配到的每台电机逐行输出结果；`id set` 不支持 `ALL` 目标。

可读取配置项：

```text
position, kt, pvt-kp-range, pvt-kd-range, pvt-pos-range,
pvt-spd-range, pvt-tor-range, pvt-cur-range, cur-pi, spd-pi,
pos-pd, can-timeout
```

连续控制：

```bash
./build/emcli control pvt Ethercat:eth0:3:0:1 20 1 45 10 0.5
./build/emcli control --canfd pvt Ethercat:eth0:3:0:1 20 1 45 10 0.5
./build/emcli control position Ethercat:eth0:3:0:1 90 20 3
./build/emcli control speed Ethercat:eth0:3:0:1 15 2
./build/emcli control current Ethercat:eth0:3:0:1 1.5
./build/emcli control current Ethercat:eth0:0:ALL 1.5
./build/emcli control torque Ethercat:eth0:3:0:1 0.8
./build/emcli control brake Ethercat:eth0:3:0:1 full
./build/emcli control brake Ethercat:eth0:3:0:1 dynamic 2
./build/emcli control brake Ethercat:eth0:3:0:1 regenerative 2
```

`control` 会每 0.5 秒输出一次反馈表格；`ALL` 目标会逐电机输出带 `slave/bus/id` 列的多行反馈。按 `q` 或 `Ctrl-C` 退出。

IMU 状态查看：

```bash
./build/emcli imu show Ethercat:eth0:0:0
./build/emcli imu show Ethercat:eth0:3:0:1
```

IMU 目标格式：

```text
AdapterType:AdapterId:BusId:ImuIdx
AdapterType:AdapterId:SlaveId:BusId:ImuIdx
```

`imu show` 会以 50 Hz 刷新输出，使用擦除后回写方式显示固定表格，包含 `accel`、`gyro`、`euler` 三行。按 `q` 或 `Ctrl-C` 退出。

电池状态查看和清错：

```bash
./build/emcli battery show Ethercat:eth0:0:0
./build/emcli battery clear Ethercat:eth0:3:0:1
```

电池目标格式：

```text
AdapterType:AdapterId:BusId:BatteryIdx
AdapterType:AdapterId:SlaveId:BusId:BatteryIdx
```

`battery show` 会以 50 Hz 原位刷新固定表格，显示 `soc`、电芯温度、MOS 温度、电池电压和当前放电电流；若有错误，每个错误单独占一行。按 `q` 或 `Ctrl-C` 退出。

PMS 状态查看和 V48 通道控制：

```bash
./build/emcli pms show Ethercat:eth0:0
./build/emcli pms enable Ethercat:eth0:0 V48_1 V48_2 V48_3
./build/emcli pms disable Ethercat:eth0:0 V48_2
```

PMS 目标格式：

```text
AdapterType:AdapterId:BusId
AdapterType:AdapterId:SlaveId:BusId
```

`pms show` 原位刷新 `V48_1`～`V48_6`、`V19`、`V5` 以及电池电量、电压和电流。`V19` 行包含底层两路 V19 电流。`pms enable/disable` 支持一次控制多个 V48 通道；V19 和 V5 仅提供状态查看。按 `q` 或 `Ctrl-C` 退出状态查看。

手套编码器状态查看和校准：

```bash
./build/emcli glove show Ethercat:eth0:3
./build/emcli glove calibrate Ethercat:eth0:3 all
./build/emcli glove calibrate Ethercat:eth0:3 1 5
./build/emcli glove calibrate Ethercat:eth0:3 2 mask 0x03F
```

手套目标格式：

```text
AdapterType:AdapterId:SlaveId
```

`glove show` 会以 50 Hz 原位刷新 5 指 × 10 编码器的角度表格：行为编码器 `E0`～`E9`，列为手指 `F0`～`F4`，首行显示在线编码器数量；离线编码器显示为 `OFF`，收到完整状态前所有单元格显示为 `N/A`。按 `q` 或 `Ctrl-C` 退出。

`glove calibrate` 支持三种校准方式：`all` 校准全部 50 个编码器；`<finger_idx> <encoder_idx>` 校准单个编码器（手指 0-4，编码器 0-9）；`<finger_idx> mask <encoder_mask>` 按 10 位掩码校准同一手指上的多个编码器（掩码支持十进制、`0x` 十六进制和 `0b` 二进制写法）。校准会等待最多 10 秒并输出结果；成功返回退出码 0，失败、限流或超时返回退出码 1。

性能基准测试和压力测试：

```bash
# 对单个适配器进行性能基准测试（自动选择第一个总线的第一个电机，其余作为混淆电机）
./build/emcli bench Ethercat:eth0

# 对单个总线进行性能基准测试
./build/emcli bench Ethercat:eth0:0

# 指定被测电机，使用合成混淆电机（默认 2 个）
./build/emcli bench Ethercat:eth0:0:1

# 对单个或多个适配器进行压力测试
./build/emcli stress Ethercat:eth0
./build/emcli stress Ethercat:eth0 Can:vcan0

# 自定义压力测试参数
./build/emcli stress --loop-period-ms 5 --warmup-delay-ms 200 Ethercat:eth0
```

`bench` 会输出各延迟下的丢包率统计。`stress` 会实时显示发送和接收统计，按 `Ctrl-C` 退出。

开发检查

```bash
clang-format --dry-run --Werror main.cc components/*.cc components/*.h
clang-tidy main.cc components/*.cc -- -I. -std=c++17
```

安装与打包

```bash
# 安装到系统（需合适权限）
cmake --build build --target install

# 生成安装包（在 build 目录下）
cd build
cpack            # 生成默认配置的包（DEB/TGZ）
# 或指定生成 deb 包
cpack -G DEB
```
