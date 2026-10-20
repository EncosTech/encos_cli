Encos Motor Debugger
=====================

简介

Encos Motor Debugger 是一个基于终端的调试与监控工具，用于与 Encos 电机驱动交互（使用 FTXUI 提供界面）。本项目采用 [MIT 许可证](LICENSE)。第三方依赖遵循各自的许可证，详见相应依赖的许可证文件。

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

CAN 位时序选项（可选，附加在各命令的目标/链路参数上）：

```bash
# 仲裁段波特率与采样点
./build/emcli scan Can:can0 --bitrate 500000 --sample-point 0.875
./build/emcli config --bitrate 500000 Can:can0:0:1 kt

# CAN FD 数据段波特率与采样点
./build/emcli bench Can:can0 --bitrate 1000000 --dbitrate 2000000 --dsample-point 0.8
```

- 4 个选项：`--bitrate`（仲裁段波特率，bit/s）、`--sample-point`（仲裁段采样点，0–1 小数）、
  `--dbitrate`（CAN FD 数据段波特率）、`--dsample-point`（数据段采样点）。目标/链路参数仍需照常给出，
  选项不能替代它们。
- 选项写在目标之前或之后等价；`--bitrate=500000` 与 `--bitrate 500000` 也等价。
- 对本次命令打开的**每个**适配器生效（适配器侧把它们作为总线公共参数）。
- **不给任何选项时各适配器使用自己的插件默认值**，行为与旧版本一致：本 CLI 不替你填默认值，
  因为各适配器默认值不同（`Can` 的采样点默认 0.765/0.882，`Ethernet` 是 0.75/0.875），
  填统一默认值会静默覆盖后者。
- 只有 `Can`、`Slcan`、`Ethernet`、`GsUsb` 适配器会读取这组配置；`Ethercat`、`RelayWs`、
  `UsbSerial`、`Fake` 会记录一条 warning 后忽略。
- `Slcan` 是 classic CAN：只支持 S0–S8 对应的位率（10k/20k/50k/100k/125k/250k/500k/800k/1M）；
  数据段字段（`--dbitrate`、`--dsample-point`）仅在等于标准默认值 5000000/0.882 时被容忍，
  取其它值会在构造适配器时报错。
- 同一接口在一个进程内只按**首次**创建时的配置初始化：此前已创建过该接口时，后传入的时序会被忽略
  并告警。
- 不创建适配器的子模式（`scan <AdapterType>` 纯枚举接口、`scan --slave` 纯 UDP 发现、
  `config` 的从站配置子模式）会静默忽略这组选项。

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
./build/emcli config Ethercat:eth0:3:0:1 pvt-kp-range set 1 500
./build/emcli config Ethercat:eth0:3:0:1 position set 0
./build/emcli config Ethercat:eth0:3:0:1 position set 45
./build/emcli config Ethercat:eth0:3:0:1 position reset
./build/emcli config Ethercat:eth0:3:0:1 comm set canfd
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
./build/emcli control stop Ethercat:eth0:3:0:1 full
./build/emcli control stop Ethercat:eth0:3:0:1 dynamic 2
./build/emcli control stop Ethercat:eth0:3:0:1 regenerative 2
```

除机械抱闸外，`control` 会每 0.5 秒输出一次反馈表格；`ALL` 目标会逐电机输出带 `slave/bus/id` 列的多行反馈。按 `q` 或 `Ctrl-C` 退出。

机械抱闸（单次执行，等待驱动确认后退出，支持 `--canfd` 和 `ALL` 目标）：

```bash
./build/emcli control brake Ethercat:eth0:3:0:1 engage  # 抱紧
./build/emcli control brake Ethercat:eth0:3:0:1 release # 释放
```

也可通过 `config` 查询和控制机械抱闸（`barke` 是 `brake` 的兼容别名，支持 `--canfd` 和 `ALL`）：

```bash
./build/emcli config Ethernet:enx6c1ff7bd2e87:0:4:1 barke         # 查询，输出 brake engage（抱紧）或 brake release（释放）
./build/emcli config Ethernet:enx6c1ff7bd2e87:0:4:1 brake engage # 抱紧，等待 ACK
./build/emcli config Ethernet:enx6c1ff7bd2e87:0:4:1 brake release # 释放，等待 ACK
```

控制成功输出 `success`；查询使用独立的抱闸状态读取指令。

电子刹车 `stop` 调用驱动 `Stop`；机械抱闸 `brake` 调用驱动 `Brake`。原有 `control brake ... full/dynamic/regenerative` 已改为 `control stop ...`，旧写法会报错。
TUI 分别提供 `Stop (electronic)` 和 `Brake (mechanical)`；后者的 `Engage` / `Release` 按钮单次执行并显示确认或失败结果，不改变当前连续控制模式。

IMU 状态查看和启停：

```bash
./build/emcli imu show Ethercat:eth0:0:0
./build/emcli imu show Ethercat:eth0:3:0:1
./build/emcli imu Ethercat:eth0:7 start
./build/emcli imu Ethercat:eth0:7:0 stop
./build/emcli imu Ethercat:eth0:3:7:0 start
```

IMU 目标格式：

```text
AdapterType:AdapterId:BusId                 # 仅 start/stop
AdapterType:AdapterId:BusId:ImuIdx
AdapterType:AdapterId:SlaveId:BusId:ImuIdx
```

`imu show` 会以 50 Hz 刷新输出，使用擦除后回写方式显示固定表格，包含 `accel`、`gyro`、`euler` 三行。按 `q` 或 `Ctrl-C` 退出。

`imu <target> start/stop` 提交整条总线的 IMU 数据转发启停指令后退出，4/5 段连接串中的 `ImuIdx` 不影响启停范围。总线需预先配置为 1 Mbps 经典 CAN；成功输出仅表示命令已提交，设备没有应用层应答。

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

轨迹播放：

```bash
# 普通播放
./build/emcli play trajectory.csv

# 交互终端默认使用 20 Hz 刷新的 top 风格表格
./build/emcli play trajectory.csv

# 强制使用适合管道、重定向和脚本解析的非原位文本输出
./build/emcli play trajectory.csv --no-inplace-refresh

# 为所有已扫描电机启用日志（默认写入 ./logs）
./build/emcli play trajectory.csv --log

# 指定日志目录
./build/emcli play trajectory.csv --log=./motor-logs

# 日志与状态统计彼此独立
./build/emcli play trajectory.csv --log
```

`play` 在交互终端中默认使用 FTXUI 表格并以 20 Hz 刷新，默认按电机 ID 升序排列。空格键暂停或继续播放（暂停时计时也会停止），`l` 动态启用或停止电机日志；方向键或鼠标滚轮滚动表格，PageUp/PageDown 纵向翻页，Tab/Shift+Tab 选择排序列，Enter 切换升降序，`q` 或 `Ctrl-C` 停止播放。退出全屏界面后会静态打印包含全部电机和全部列的最终表格。状态表依次展示适配器、从站、总线、电机 ID、位置、速度、电流、估算扭矩、电机/MOS 温度、收发计数、累计丢包数及百分比（`LOSS`）、最近 3 秒的丢包数及百分比（`LOSS(3s)`），错误码位于最右侧。`LOSS(3s)` 按真实时间滑动，以 TUI 的 50ms 刷新周期采样收发计数，窗口边界精度为一个采样周期；启动不足 3 秒时使用已有数据，窗口内无发送时显示 `0 (0.00%)`。

当标准输入或标准输出不是交互终端、`TERM=dumb`，或者指定 `--no-inplace-refresh` 时，`play` 会自动使用兼容旧版 stress 报告的非原位文本输出。收发计数和丢包率始终启用；旧的 `--stress` 参数仅为兼容已有脚本而保留，不改变任何行为且不出现在帮助中。所有日志均由 `--log[=<目录>]` 独立管理。

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

### USB 一键固件下载

```sh
# Linux：端口请使用实际的网关 CDC 端口，也支持 /dev/serial/by-id/... 路径
emcli config Ethernet:/dev/ttyACM1 download demo.bin
emcli config Ethercat:/dev/ttyACM1 download demo.elf
emcli config EthercatIGH:/dev/ttyACM1 download "firmware folder/demo.elf"

# Windows：COM10 及以上端口同样支持
emcli config EthercatIGH:COM5 download "C:\firmware\demo.elf"
```

`download` 通过 USB 完成网关应用升级，无需 Python、objcopy、手工拖拽文件或调试器。
`Ethernet`、`Ethercat`、`EthercatIGH` 前缀均使用指定 CDC 串口，不需要对应网络插件，
也不会切换网关的业务模式。网络接口目标（如 `Ethernet:eth0:0`）不支持此命令。

板卡需预先烧入配套的 A/B OTA bootloader 和支持 `OTA STATUS` / `OTA ENTER` 的应用，
且应用和 bootloader 必须使用相同的 32 位十六进制 USB UUID。
当前格式针对 Ethercat_8CAN 网关：设备标识 `0x3843414e`，应用入口 `0x80041000`，
最大应用大小 `0xbf000` 字节。输入应为 `gateway-ota/output/demo.elf` 或同一 OTA 构建的
原始 `demo.bin`；普通独立启动固件、bootloader、工厂合并镜像、`app-slot.bin` 和 `.upd`
不是该命令的输入。ELF 会校验架构、入口和加载段；原始 BIN 不携带链接地址，必须由调用者
确保它是 OTA 应用产物。SHA-256 用于传输完整性校验，不是固件签名认证。

命令先校验文件并读取当前状态，以当前版本加一打包，再请求重启到虚拟 U 盘，按 USB UUID
定位同一块板，写入并刷新升级文件，最后重新定位 CDC 端口。
只有新版本在另一槽位确认启动且 `READY=1` 才返回成功（退出码 0）；回退、拒绝升级或超时
均返回非零。最多等待 U 盘挂载 40 秒、应用确认 100 秒。传输未完成时旧固件仍由 bootloader
保留，修复连接后重新执行即可；不要把“文件已写入”当作升级成功。

执行前停止正在使用该板的业务连接，EtherCAT 退出 OP/SAFEOP；繁忙时固件会拒绝进入升级。
Linux 需要 CDC 读写权限以及 U 盘挂载目录写权限：优先使用桌面自动挂载，未挂载时尝试
`udisksctl mount --no-user-interaction`（需要 udisks2 和相应用户权限）。Windows 需要系统为
虚拟 U 盘分配盘符。升级期间端口号可以改变，CLI 会重新发现同一 USB UUID 的串口。

### 从站配置与扫描

```sh
emcli scan --slave Ethernet:enx6c1ff7bd2e87
emcli scan --slave Ethercat:eth0
emcli scan --slave EthercatIGH:eth0
# 输出两列 SlaveIdx UUID；EtherCAT的UUID为空。

emcli config Ethernet:enx6c1ff7bd2e87:10 ip
emcli config Ethernet:enx6c1ff7bd2e87:9 ip set 192.168.100.11
emcli config Ethernet:enx6c1ff7bd2e87:4925c78e2e1d44ecca22ddb104730b57 mode set ecat
emcli config EthercatIGH:/dev/ttyACM1 mode set enet
emcli config Ethernet:/dev/ttyACM1 mode set usb3can
emcli config Ethernet:/dev/ttyACM1 mode set usb8can
emcli config Ethernet:/dev/ttyACM1 mode set sim
emcli config Ethernet:/dev/ttyACM1 mode set simsensors
emcli config Ethernet:/dev/ttyACM1 ip set 192.168.100.10
emcli config Ethernet:/dev/ttyACM1 slave set 252
emcli config Ethernet:enx6c1ff7bd2e87:252 slave set 9
emcli config Ethernet:/dev/ttyACM1 raw MODE GET
```

Ethernet的两段、三段目标进入从站配置模式：两段要求CDC设备路径；三段要求网卡和
SlaveId或完整UUID，分别单播或广播。四段、五段仍用于电机；三段`Ethernet:网卡:ALL`
现在不再代表全部电机，可使用四/五段的总线ALL目标。
名字包含Ethercat（不区分大小写）的插件均支持两段CDC配置，例如Ethercat、EthercatIGH、
EthercatWindows；其普通电机连接串保持原语义。CDC配置不实例化网络插件。

SlaveId为IP最后一段减1，范围0–252（例如`.10`对应9）；从站IP范围192.168.100.1–253，主机保留192.168.100.254/24，网络配置前需确保网卡已有IPv4。
`ip`、`slave`与`mode`默认读取，也可显式加`get`。`slave set <0..252>` 将编号转换为
`192.168.100.<编号+1>`，复用IP配置命令；例如 `slave set 9` 设置为 `.10`。
`slave get` 返回包含IP和SlaveId的网络配置。目标中的SlaveId是修改前的编号。
写入后自动保存Flash并立即发出重启命令；
`enet`（或别名`udp`）对应固件UDP模式，`usb3can`和`usb8can`分别对应固件USB3CAN和USB8CAN模式，
`sim`和`simsensors`分别对应固件的SIM（八路电机模拟器）和SIMSENSORS（CAN0-5电机模拟器 + CAN6电池 + CAN7 IMU）
模式。CLI token与固件`MODE SET`的拼写不同，不要混用。
活动CAN会话下保存/重启会拒绝，关闭适配器后至少等待5秒；
EtherCAT需先退出OP/SAFEOP。写入失败不会继续重启。返回OK REBOOT代表板卡接受命令，
不代表已确认重新上线。切到ecat后请通过CDC进行后续配置。

`raw`转发单条CDC文本命令（最多35字符），支持后续固件新增配置；它不会自动保存或重启。
UDP需支持EMM1文本命令通道的新固件。serialib作为external/serialib子模块用于CDC通信，
克隆时使用`git submodule update --init --recursive`。

`scan --slave`要求`插件:网卡`目标，仅支持Ethernet及Ethercat相关插件；其他插件报不支持。
Ethernet通过广播发现，不创建CAN数据会话；EtherCAT按插件枚举的总线所属从站去重，
不会额外发送电机扫描请求。表按SlaveIdx升序输出。

### 网关固件版本查询

```sh
emcli config Ethernet:eth0:9 version
emcli config Ethernet:eth0:1234567890abcdef1234567890abcdef version get
emcli config Ethernet:/dev/ttyACM0 version
emcli config EthercatIGH:/dev/ttyACM0 version
```

`version` / `version get` 均只发送 `VERSION GET`，返回 `OK VERSION=1.0.0`。
CDC 使用 LF 行结束；Ethernet 使用 EMM1 COMMAND(12) / COMMAND_REPLY(13)，
请求正文不带换行，以 NUL 结束。查询不保存配置、不重启，旧固件返回错误时 CLI 以非零退出。
这里是网关应用固件的版本，与 `emcli --version` 和 OTA 镜像递增编号不同。
Ethernet 仅在网关 UDP 模式可用；CDC 可用于所有运行模式。
