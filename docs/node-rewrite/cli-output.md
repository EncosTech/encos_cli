# emcli CLI 输出样式

本文记录当前 Node.js 版 CLI 的实际输出；表格、字段和单位沿用旧 C++ CLI。
默认采用普通文本追加输出，不再原地刷新或提供交互 UI。
所有非交互命令支持 `--json`，协议见 [JSON API v1](json-api.md)。

> 说明：
>
> - 驱动自身会向 stdout 打印 `[时间] [logger] ...` 日志，下面的样例已去掉这些行。
> - `imu show`、`battery show`、`pms show`、`glove show`、`control`、`stress`、`play`
>   是周期刷新命令，下面只展示一个/一组快照。
> - 模拟 EtherCAT 板只实现初始化/PVT/位置读取，因此电池、PMS、手套等未实现设备的字段
>   为空；格式与旧 CLI 相同。

## 全局

```console
$ emcli --version
2.0.0-alpha.0
```

`emcli --help` 保持旧版 `Usage / Options / Commands` 结构，并追加 `doctor` 与原生模块说明。

## scan

列出某类适配器的接口：

```console
$ emcli scan Ethercat
enp131s0
enx6c1ff7bd2e87
```

扫描指定 slave/bus：

```console
$ emcli scan Ethercat:enx6c1ff7bd2e87:0:1
slave	bus	id	eff	canfd
0	1	1	0	1
0	1	2	0	1
0	1	3	0	1
0	1	4	0	1
0	1	5	0	1
0	1	6	0	1
0	1	7	0	1
0	1	8	0	1
```

不带 bus 时多 bus 并发扫描，输出字段与排序规则不变。

## config

单电机读取：

```console
$ emcli config Ethercat:enx6c1ff7bd2e87:0:1:1 position
position 0.000000

$ emcli config Ethercat:enx6c1ff7bd2e87:0:1:1 kt
kt 2.000000

$ emcli config Ethercat:enx6c1ff7bd2e87:0:1:1 pvt-kp-range
pvt-kp-range 50 1000
```

`ALL` 目标：

```console
$ emcli config Ethercat:enx6c1ff7bd2e87:0:1:ALL kt
Ethercat:enx6c1ff7bd2e87:0:1:1 kt 2.000000
Ethercat:enx6c1ff7bd2e87:0:1:2 kt 2.100000
Ethercat:enx6c1ff7bd2e87:0:1:3 kt 2.200000
...
```

设置后回读可读项（`position`、范围、PI/PD、`can-timeout`）：

```console
$ emcli config Can:can0:0:1 pvt-kp-range set 1 500
pvt-kp-range 1 500
```

不可回读项（`id`、`comm`、`brake`）在单目标下输出：

```console
success
```

`ALL` 下不可回读项输出：

```console
Can:can0:0:1 success
```

## control

单电机：

```console
$ emcli control pvt Ethercat:enx6c1ff7bd2e87:0:1:1 20 1 10 0 0
   pos_deg        spd        tor        cur        tmp    mos_tmp  err
  0.000000          -          -          -          -          -  NoResponse
  0.000000          -          -          -          -          -  NoResponse
```

`ALL`/总线目标：

```console
$ emcli control pvt Ethercat:enx6c1ff7bd2e87:0:1:ALL 20 1 0 0 0
slave    bus     id     pos_deg        spd        tor        cur        tmp    mos_tmp  err
    0      1      1    0.000000          -          -          -          -          -  NoResponse
    0      1      2  -27.845739  -0.486935  -41.999998  -20.000000  25.500000  25.500000  NoError
    0      1      3  -41.768615  -0.730403  -59.553115  -27.069597  26.000000  26.000000  NoError
```

- 每 10 行重复表头。
- 位置单位为度，速度/电流/力矩/温度为固定 6 位小数。
- `tmp`/`mos_tmp` 分别对应电机与 MOS 温度。

机械抱闸（单次执行）：

```console
$ emcli control brake Ethercat:enx6c1ff7bd2e87:0:1:1 release
Ethercat:enx6c1ff7bd2e87:0:1:1 brake released
```

该模拟板未实现抱闸时会输出：

```console
Error: 机械抱闸未收到确认
```

## imu

```console
$ emcli imu show Ethercat:enx6c1ff7bd2e87:0:1:0
group                x             y             z
accel                                             
gyro                                              
euler                                             
```

`start`/`stop`：

```console
$ emcli imu start Ethercat:enx6c1ff7bd2e87:0:1
IMU start command submitted
```

## battery

```console
$ emcli battery show Ethercat:enx6c1ff7bd2e87:0:1:0
item                  value
soc                   
battery_temp_c        
mos_temp_c            
voltage_v             
discharge_current_a   
error                 communication timeout
```

`clear`：

```console
$ emcli battery clear Ethercat:enx6c1ff7bd2e87:0:1:0
success
```

## pms

```console
$ emcli pms show Ethercat:enx6c1ff7bd2e87:0:1
item        enabled   value
V48_1                 
V48_2                 
V48_3                 
V48_4                 
V48_5                 
V48_6                 
V19                   
V5                    
battery_soc           
battery_voltage       
battery_current       
```

`enable`/`disable`：

```console
$ emcli pms enable Ethercat:enx6c1ff7bd2e87:0:1 V48_1 V48_2
success
```

## glove

```console
$ emcli glove show Ethercat:enx6c1ff7bd2e87:0
online: 0/50
enc        F0       F1       F2       F3       F4
E0        OFF      OFF      OFF      OFF      OFF
E1        OFF      OFF      OFF      OFF      OFF
...
E9        OFF      OFF      OFF      OFF      OFF
```

校准：

```console
$ emcli glove calibrate Ethercat:eth0:3 all
Calibration succeeded

$ emcli glove calibrate Ethercat:eth0:3 1 5
F1: Calibration succeeded

$ emcli glove calibrate Ethercat:eth0:3 2 mask 0x03F
F2: Calibration failed: current limited
```

## play（无 TUI）

非 TUI 状态输出与旧实现一致：

```console
$ emcli play trajectory.csv --kp 20 --kd 1 --vel 0 --tor 0
===== PLAY STATUS (Ctrl+C: return and stop; again: exit) =====
Measurement seconds: 1.005
Motor Ethercat:enx6c1ff7bd2e87:0:1:1: sent=101 received=102 lost=0 loss=0.00%
Motor Ethercat:enx6c1ff7bd2e87:0:1:2: sent=101 received=101 lost=0 loss=0.00%
Motor Ethercat:enx6c1ff7bd2e87:0:1:3: sent=101 received=101 lost=0 loss=0.00%
...

===== PLAY STATUS (Ctrl+C: return and stop; again: exit) =====
Measurement seconds: 5.013
Motor Ethercat:enx6c1ff7bd2e87:0:1:1: sent=502 received=502 lost=0 loss=0.00%
Motor Ethercat:enx6c1ff7bd2e87:0:1:2: sent=502 received=502 lost=0 loss=0.00%
...
```

交互表格使用 `emcli tui` 的 Play 页面。CLI 支持 `--dry-run` 离线预览，
`--log[=DIR]` / `--log-directory DIR` 使用驱动原生电机日志；dry-run 不记录电机日志。

## bench

```console
$ emcli bench --attempts 20 --periods 10 Ethercat:enx6c1ff7bd2e87:0:1:1

| Hz | period ms | mean us | P1 us | P5 us | P50 us | P95 us | P99 us | op/s | err% (MdAPE) | valid | lost/sent (rate) | status |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|:---|
| 100.00 | 10 | 2788.74 | 2360.50 | 2388.89 | 2720.42 | 3179.23 | 3274.00 | 367.59 | 9.87 | 20 | 0/20 (0.00%) | ok |
```

- 状态为 `ok` / `loss limit` / `stopped` / `error`。
- 默认档位 `10,5,3,2,1 ms`，输出逐档追加。

## stress

```console
$ emcli stress --loop-period-ms 1 Ethercat:enx6c1ff7bd2e87:0:1:1
===== LIVE STATUS (Press Ctrl+C to stop) =====
Measurement seconds: 0.502
Overview: drop_rate=0.00% drop=0/502 actual_fps=1000.00
  Adapter Ethercat:enx6c1ff7bd2e87: drop_rate=0.00% drop=0/502 actual_fps=1000.00
    Slave 0 Bus 1: drop_rate=0.00% drop=0/502 actual_fps=1000.00
      Motor 1: drop_rate=0.00% drop=0/502 actual_fps=1000.00

Drain wait: 100 ms; additional replies: 2; outstanding before/after: 2/0
================ FINAL RESULT ================
Measurement seconds: 1.004
Overview: drop_rate=0.00% drop=0/1004 actual_fps=999.82
  Adapter Ethercat:enx6c1ff7bd2e87: drop_rate=0.00% drop=0/1004 actual_fps=999.82
    Slave 0 Bus 1: drop_rate=0.00% drop=0/1004 actual_fps=999.82
      Motor 1: drop_rate=0.00% drop=0/1004 actual_fps=999.82
```

- `drop_rate` 为百分比，`drop` 为 `lost/sent`，`actual_fps` 为 received / measurement seconds。
- 缩进层级：Overview → Adapter → Bus → Motor。

## doctor

```console
$ emcli doctor
emcli      2.0.0-alpha.0
node       v24.22.1
platform   linux/x64
driver pkg @encos/encos-driver-native-linux-x64-gnu
helpers    authorized
driver ver 4.1.2
perf addon /home/bismarck/motor_cli/packages/emcli-native/build/emcli_perf.node
perf abi   1
```

## 错误

统一输出到 stderr，前缀 `Error: `：

```console
$ emcli config bad position
Error: 无效目标 'bad'，期望 Type:Id:ALL、... 
```

```console
$ emcli bench
Error: 用法: emcli bench <Type:Id[:slave:bus:ALL|motor]...>
```
