# Motor Studio 首期

基准是删除旧源码前 `35e1212^` 的 FTXUI 界面：`components/left_panel.cc`、`control_panel.cc`、`settings_panel.cc`、`graph_panel.cc` 和 `main.cc`。采用已经完成的 Ink 组件替换界面，用户可见文案为英文。

## 功能对照

| 旧版功能 | 新版入口 / 行为 |
| --- | --- |
| 无参数进入 TUI / `tui Type:Interface ...` | 交互终端默认进入；支持显式 tui、多个预加载适配器和 Type:ALL |
| 添加适配器、接口下拉、手动接口名 | Add → Add Adapter；发现接口时仅下拉选择，无接口时仅手动输入名称/endpoint |
| 适配器 / 总线 / 电机树 | 左侧 Devices；Slave / Bus 分组，电机 ID 显示十进制与十六进制 |
| 全局与总线重扫 | Add → ReScan Motors；删除扫描创建的电机实例后重扫全部适配器，保留手工设备 |
| 选择电机并停掉之前的连续发送 | 选择变更在驱动串行队列中执行，控制模式归 Disabled |
| Disable | 停止周期发送，不等于给电机发送制动命令 |
| PVT / Position / Speed / Current / Torque | Control 中滑动条+数字输入；Apply 开始连续发送 |
| Stop：Full / Dynamic / Regenerative | Control → Stop |
| 机械抱闸 Engage / Release | Control 底部，等待设备 ACK |
| 读取并使用电机控制范围 | 直接使用电机添加时缓存的 properties，不再显示 Read ranges |
| CAN ID | Settings → CAN ID，检查总线内 ID 冲突，成功后更新选择键 |
| Position Get / Set / Reset | Settings → Position；输入和显示为角度，驱动调用转换为弧度 |
| Kt | Settings → Torque constant，只读 |
| PVT Kp / Kd / Pos / Spd / Tor / Cur 范围 | 六组独立设置，范围值使用驱动原生单位，Pos range 为 rad |
| Current PI / Speed PI / Position PD | Settings 中分别 Read / Apply |
| CAN timeout | Settings → CAN timeout，毫秒整数 |
| Position / Speed / Current / Mechanical power 曲线 | Graph → 点击图例显隐；10 秒滚动窗口、独立 Y 轴、稳定换行图例 |
| 退出 | 底部 ^c Quit 或 Ctrl+C 打开退出对话框；SIGTERM 清理退出 |

新增能力：断开适配器、CAN FD 切换、通信模式设置、底部可折叠 Logs 面板、原生 stdout/stderr 捕获、通知、复制、滑动条数字输入、多轴图表。保留现有 scan/config/control/imu/battery/pms/glove/play/bench/stress/doctor CLI 入口，没有将这些命令替换成演示操作。

本期“旧版功能对齐”指上述旧版 **TUI** 页面。旧 CLI 的 slave 配置、固件下载及 `scan --slave` 等此前未迁移的功能不在此次 TUI 迁移中补齐；这些已有 CLI 差距仍见根 README。

## 启动

```bash
pnpm --filter @encos/emcli build
node apps/emcli/dist/main.js tui
node apps/emcli/dist/main.js tui Ethercat:eth0 Can:can0
node apps/emcli/dist/main.js tui --demo
pnpm --filter @encos/emcli tui --demo
```

`--demo` 使用真实驱动包中的 Fake 适配器和原生扫描引擎，创建 8 台 Fake 电机。没有连接真实硬件，不用静态数组伪装驱动结果。非 demo 模式不会自动创建 Fake 电机。

TUI 支持现有 `--plugin-path`、CAN `--bitrate` / `--dbitrate` / `--sample-point` / `--dsample-point`。建议终端至少 100 列 × 30 行，较长的 Control / Settings 页面自动滚动；焦点进入隐藏控件时自动滚动至可见位置。

## 进程与生命周期

- 前台只加载 React/Ink 和数据模型，不加载 native 驱动。`runtime-options.ts` 将 CLI 参数解析与驱动导入分离。
- `driver-worker` 进程同时加载驱动包和 emcli-native，复用同一驱动单例。适配器保持连接，操作不会每次重新打开链路。
- 原生扫描在子进程内执行；前台继续处理输入与渲染。扫描期间暂停控制发送。
- 原生异步调用、同步状态读取、控制、配置和清理共享串行队列。Control 和 Graph 主动采集以 50ms（20Hz）为调度间隔，不承诺硬实时；发送使用 feedbackType=0、feedback=1，请求完整 Type 1 回报但不等待回报。只等待驱动发送操作完成，以遵守 native 异步互斥约束，不调用 commit。只有 Bench / Stress 使用 commit，并在完成、停止或异常清理时关闭所有相关 Adapter 的软同步模式。状态通过 setOnStatus 回调进入 Status / Graph，不再循环 getParameter。高频基准/压力测试继续使用原生 CLI 引擎。
- stdout/stderr 被 pipe 捕获，按行写入有界 LogStore；机器协议使用独立 IPC，日志不会被当作响应解析。
- 请求带关联 ID；电机操作附带预期选择键，目标变更后拒绝旧目标请求。超时提示结果未知，避免把超时当成设备明确拒绝。
- 控制命令失败取消连续发送；设置写入检查 ACK；切换电机、重扫、配置写入或断开时停止旧控制。
- 退出首先关闭会话，再卸载 Ink，退出备用屏幕。父进程断开 IPC 或收到 SIGTERM 时，子进程清理驱动；无响应进程有关闭超时。退出停止发送并断开设备，不自动选择用户未指定的制动模式。

## 验证与边界

自动测试覆盖 UI 页面切换、类型化控制/配置请求、图表数据注入、英文日志、100×30/120×40 布局、输入校验，以及原生 Fake 的发现、参数回读、六种控制、抱闸、目标变更保护、移除与关闭。构建产物另经 Linux PTY 启动/选择电机/退出检查。

Windows 单文件已验证 Fake TUI 启动、驱动子进程及双 Ctrl+C 退出；尚未验证真实电机，不将 Fake 测试结果等同于实机验证。驱动原始日志属于外部内容，保留其原文；应用自身界面及通知使用英文。

驱动 4.1.2 的 Fake 模型在 SetId 后会返回 ACK、迁移驱动句柄索引，但模拟设备快照仍保留在旧 ID。因此 Fake 测试只验证 ID 写入及 UI/会话地址更新，不能验证改 ID 后继续通信；应用不会为演示伪造设备迁移。此链路需在真实硬件上复核。PI/PD 等参数存在协议量化或限幅，设置页写入后展示回读值，不将输入值直接视为设备实际值。

## Devices 与右键菜单

- 顶部只保留 Add：Add Adapter、Add Motor、Add IMU、Add Battery、Add PMS、Add Glove，分隔线后为 ReScan Motors。
- Motor / IMU / Battery / PMS 添加表单依次选择 Adapter、Slave / Bus，再输入十进制或 `0x` 十六进制 ID。
- 电机用驱动 `getMotor` 建立实例；把已扫描电机手工添加一次会将其转为手工设备。重复添加手工设备会报错。
- IMU / Battery / PMS / Glove 已接入原生句柄、操作及状态采样；各自用一张卡片展示顶部单行操作按钮与实时参数。PMS 原生 API 是每总线单实例，输入 ID 仅作为会话登记地址，同一总线不可重复创建 PMS。
- 每个总线中 IMU / PMS / Battery 位于电机前。空总线仍显示在树中，可直接选择并配置参数。Adapter 显示 Bench / Stress；Bus 显示仲裁段/数据段波特率和采样点配置；电机显示 Control / Settings / Graph。切换到非电机节点会停止之前的周期控制。
- Adapter 与设备右键均提供 Delete，电机另有 CAN FD。Delete 移除会话对象，不修改物理设备的 ID；下次重扫可重新发现在线电机。
- 聚焦树节点后 `Ctrl+Space` 打开右键菜单，方向键选择、Enter 执行、Esc 关闭。
- Logs 始终位于右侧底部，点击标题三角折叠；折叠为铺满面板宽度的一行，整行可点击展开。标题获得焦点后 Enter / Space 或左右键切换，`^L` 也可折叠/展开。

- 底部使用 `^` 表示 Ctrl，显示 `^Space Item Menu`。首次 `^C` 打开退出确认框，确认框中再次 `^C` 执行正常关闭与清理。
- 添加适配器（包含启动时预加载）及 ReScan Motors 显示居中 spinner 浮层，完成或失败时自动关闭；失败后保留添加表单供重试。
- No devices / No device selected 在各自卡片内水平、垂直居中。未编码从站号的总线与从站 0 均显示 Slave 0，底层寻址保持原始值。

- Glove 仅允许选择 EtherCAT / EthercatIGH 适配器及其可用从站；从站下任一总线已有设备、或已登记 Glove 时不再可选。Glove 独占从站，不能再向其总线添加其他设备。提交时驱动会话再次校验。
- 除 Adapter / Glove 外，设备 ID 使用三行输入框。Adapter 表单的四个 CAN 时序下拉按两行排列，可保留驱动默认值；Bus 页面更新精确到所选 Slave / Bus。底层不支持更新时显示失败，不保存为已成功的配置；当前驱动没有统一时序回读接口。
- 驱动 4.1.2 会跳过存在 IMU / Battery / PMS 的总线的电机发现；ReScan Motors 删除自动创建电机后，这些总线上不会重新发现电机，手工设备仍保留。
- Logs 页脚使用灰色，与日志正文之间不留空行；折叠行的横线保持普通边框色，焦点仅影响标题。

## Bus / Slave 测试页面

- EtherCAT Devices 树按 Adapter → Slave → Bus → Device 分组；空 Bus 仍可见，设为 Glove 的从站仅显示 Glove，隐藏全部 Bus。
- Bus 默认进入 Timing，仲裁段与数据段均可选择 88.2% 采样点。Apply timing 位于参数下面，使用单行按钮。
- Bus 提供 Timing / Bench / Stress；Adapter 与普通 Slave 提供 Bench / Stress。测试仅使用当前范围内已登记电机，不隐式重新扫描，Glove 从站不可运行电机测试。
- Bench 的 Start test 调用原生测试引擎，按 10/5/3/2/1 ms、每档 500 次运行；表格逐档更新均值、P1/P5/P50/P95/P99、吞吐、误差与丢包。沿用 CLI 丢包阈值，达到阈值或错误时提前结束。
- Stress 的 Start test / Stop test 使用原生 1 ms 会话，实时树展示总量、各总线和电机的发送/接收/未返回统计，停止时 drain 200 ms。切换设备、修改配置、删除或重新扫描会先停止测试；关闭时清理原生会话。
- IMU / Battery / PMS 使用参数和值表格，Glove 使用手指 × 编码器角度表格。顶部操作留一行空白；启动/启用为绿色、停止/关闭为红色、校准/清故障为黄色，其余按操作语义使用蓝色或普通样式。

- Stress 顶部运行信息用表格展示；统计树为 Adapter → Slave → Bus → Motor，每行名称后显示 `lost/sent (loss%)`，父节点汇总子节点数据，Motor 不再有子节点。Slave / Bus 测试隐藏上层节点，保留测试范围自身为根。运行中的丢包统计包含尚未返回的请求，停止 drain 后为最终结果。
- Adapter 级测试覆盖该适配器所有普通从站的已登记电机，跳过 Glove 从站，结果缓存与 Slave 0 独立。
- IMU / Battery / PMS 参数分为并排两栏，Glove 用一张表显示 F0–F4 行、Enc 0–9 列；两栏内容在窄终端自动纵向排列，大表保留水平滚动。PMS 操作区同一行按 Channels、单行 Enable、单行 Disable 排列。

- EtherCAT / EthercatIGH 建立拓扑及 ReScan Motors 时，在电机探测之前识别恰有 5 条不同 Bus 的从站，自动建立原生 Glove 句柄并隐藏其 Bus；重复扫描不会重复添加。手工 Add Glove 保留，已有手工设备的从站不会被自动覆盖。删除自动 Glove 后，再次重扫会重新识别。
- Glove 操作第一行只有单行 Calibrate all；第二行左侧是 Finger、Encoder 和单行 Calibrate encoder，右侧是 Encoder mask 与单行 Calibrate mask。空间不足时右侧转到下一行，输入和选择保持不变。
- 共用 TwoColumns 组件按父容器实际宽度决定双栏或单栏，设备参数、Glove 操作区及 Timing 选择器均采用该组件。

- 自动登记 Glove 后保持一次原生并行电机扫描：驱动根据外部设备标记跳过手套编码器总线，其他从站并行扫描，不逐 Bus 串行调用，也不强制将未编码的从站地址转成 0。
- 主界面按钮统一单行；Add adapter 两行 Timing 选择器不额外插入行间空白，对话框确认/取消按钮保持原样。

- 启动加载结束自动聚焦 Add；Add Adapter / Motor / IMU / Battery / PMS / Glove 表单自动聚焦首个启用选择器。确认退出等无输入对话框仍默认 Cancel；加载、嵌套通知关闭后恢复原控件。
- 之前的大按钮改为 medium：Timing Apply、PMS Enable / Disable、Glove 校准、机械抱闸 Engage / Release。medium 的上下半行色块与三行字段对齐，原有单行按钮保持 small。

- 参数表格区块之间统一留一行，TwoColumns 的纵向间距不再与横向间距共享，也不叠加区块顶部 margin。
- Battery 顶部操作分为 Clear fault、Charge on/off、Discharge on/off 三组；Send flags 使用 medium，与 Command flags 选择器同排对齐。
- Stress 停止后不显示额外回复数和等待时长；内部仍等待在途回复完成统计。
- Add Motor / IMU / Battery / PMS 使用 Adapter → Slave → Bus 树形单选，不再单独选择 Adapter；仅 Bus 可确认，Glove 占用的从站不提供 Bus。

- Bench / Stress 的 Motors 树形多选默认包含当前 Adapter、Slave 或 Bus 下的全部电机，显示当前层级本身（Adapter / Slave / Bus），隐藏其上层级；父节点复选框支持全选/全不选，并显示半选状态。两页独立保留选项；Start test / Stop test 使用中按钮，紧跟选择器并对齐输入区域。
- 测试请求通过 `motorKeys` 传递选中集合，驱动层校验每个 key 仍属于当前测试范围；空选择禁用 Start，后端也拒绝空集合，不会退回测试全部电机。


### Motor workspace

- Control 使用无边框 ScrollView。Status 表格显示已 Apply 的命令快照及回报；草稿编辑不会改变正在发送的值，无回报字段显示 `-`。每种控制模式独立卡片，参数按行双栏对齐，窄屏退回单栏。范围取创建电机时缓存的 properties。
- Brake 的 Engage / Release 为小按钮，单次发送并在按钮后显示 ACK 结果，不替换或重复发送当前控制命令。
- Settings 每项为标题行和输入/按钮行，组间留一空行；宽度不足才折行。Communication mode 使用单行选择器。
- Graph 默认勾选全部四项。已有 Control 时复用回调；无 Control 时仅在 Graph 活跃期间发送零增益 PVT（kp=kd=torque=0）。离开 Graph 停止该采集，保留用户已 Apply 的控制；切换电机清除控制及采集，解绑旧回调。
- Type 1 没有独立功率字段，Mechanical power (W) 由回报电流 × 缓存 Kt × 回报速度计算；原始字段缺失时仍显示 `-`，不另发功率查询。
- 请求期间使用请求锁防重复提交，不临时取消普通按钮的焦点；加载窗口仍阻止后台交互。


### View modes

- View 菜单提供 Single / Batch / Play。Single 保留设备工作区；Play 暂为占位符。切换视图先停止单电机控制、批量控制、Graph 主动采集和性能测试；旧视图迟到的请求由 expectedView 拒绝。
- Batch 的 Devices 保留 Adapter / Slave / Bus 树形层级，仅显示电机设备，隐藏辅助设备及空分支；父节点复选框联动所有后代电机并显示半选状态；点击父节点文字/复选框或按 Space 切换全选，点击三角或按 Enter 展开折叠；电机复选框表示选中集合；电机叶子的左键、Space、Enter 切换选中，方向键仅移动游标。右键或 ^Space 保留 CAN FD / Delete 菜单，不改变勾选集合。
- Batch 主区恒定为 Control / Settings / Graph。Status 仅显示命令快照；Apply 以 20Hz 向每个勾选电机发送，取消勾选立即停止该电机；空集合不能启动。Brake 逐台单次发送。
- Batch Settings 隐藏 CAN ID、Communication mode、Torque constant。其余组保留 Apply，没有 Read；Position 额外保留 Reset zero。写入逐台执行，日志包含 Adapter 类型/接口、Slave、Bus、Motor 十进制和十六进制 ID、参数、值及成功/失败结果，部分失败仍报告其他电机结果。
- Batch Graph 的 Grouping 提供 By motor（树形单选电机，显示其四项指标）和 By metric（单选指标，显示所有勾选电机的该指标）。系列标识包含完整电机 key，跨 Adapter / Bus 相同 ID 不混淆。
- 三个视图共用 ^n Add adapter、^l Logs、^c Quit、^Space Item Menu。移除 ^d、^q 和 Shift+F10；Ctrl+Shift+C 仍用于复制，不触发退出。

- 电机图表纵轴标题统一使用 Position / Speed / Current / Power 短名称；单位和完整名称保留在底部图例，Single 与 Batch 共用同一指标定义。

- Chart 图例点击切换对应曲线，隐藏项显示灰色空心方块，位置与数值字段保持稳定。隐藏仅影响绘图和 Y 轴自动范围，仍继续采集历史；图例聚焦后 Enter / Space 也可切换。
- Single 电机 Graph 不再显示 Metrics 选择器；使用四项固定图例控制显示，切换标签页保留选择，不清空数据。
- IMU 提供 Parameters / Graph 标签页。Graph 的 Measurement 单选为 Acceleration、Angular velocity、Euler angles，不提供 Quaternion；各分量通过图例显隐。三组共享最近 10 秒历史采集，切换组别保留数据和显隐状态，切换设备清理旧历史。单位分别为 m/s²、deg/s、deg，与驱动一致。

## Play view

- Play disables Add and removes Devices and the Add / Item Menu footer actions. Load accepts the existing trajectory CSV format (`time,Type:Interface:Bus:Motor` or `time,Type:Interface:Slave:Bus:Motor`); positions are degrees and times are seconds.
- The setup card contains a CSV path and Browse dialog, four arbitration/data bitrate/sample selectors, Endless, control frequency (1–1000 Hz), maximum speed (rad/s), maximum current (A), and Load. Browse supports folder navigation, parent folder, direct paths and CSV selection.
- Load validates CSV and settings, connects adapters and loads motors without starting motion. Start begins a 2-second transition into the trajectory. Non-endless playback returns to initial positions over 2 seconds; Endless plays forwards/backwards. Other discovered motors on the used buses hold their initial positions. Play does not use `commit()`.
- Table uses the shared table component: adapter, slave, bus, ID, feedback position/speed/current/torque, motor/MOS temperatures, sent/received, total loss, last-3-second loss, error and motor role. Missing feedback is `-`. Sorting supports numeric fields and loss rate, with keyboard horizontal scrolling.
- Graph reuses Batch Graph's motor/metric grouping, motor tree selector, multiple Y axes and clickable legends. It consumes playback feedback and never launches a separate motor control loop.
- One shortcut set is shared by Table and Graph: `^s` Start, `^p` Pause/Resume, `^x` Stop, `^g` telemetry log on/off, `^l` Logs panel and `^c` Quit. Space/l/q playback aliases are removed. Sortable column headers participate in normal Tab/Shift+Tab focus navigation; click or Enter selects a column and toggles ascending/descending order. Standard focus/navigation keys are not repeated in the footer.
- Pause freezes trajectory time while continuing to hold the current target. Switching views or exiting stops playback. Table and Graph switching does not interrupt it.
- Telemetry logging writes timestamped JSONL snapshots beside the CSV as `<csv>.<timestamp>.play.jsonl` at the UI polling rate (10 Hz); it is not a full-control-rate packet capture. The native sender handles the configured control rate independently.

- Play setup keeps the CSV label adjacent to its input. Frequency, maximum speed and maximum current use three-line inputs; Endless and Dry run each occupy a separate row after them.
- Dry run validates the CSV and builds a virtual motor list without creating adapters or native playback sessions. Table and Graph preview the trajectory, including pause, return and endless reversal; the header explicitly marks Dry run. Sent/received remain zero, and temperatures/errors are absent because no hardware feedback exists.
- The file picker shows Go and Parent beside the path. Clicking a folder enters it, clicking a CSV selects it, and Enter/Select confirms. Only folders and `.csv` files (case-insensitive) are listed. Directory loading preserves the active control/list focus.

- Play tables use measured available height and the actual row count, with no unused rows inside the table. The outer card has no second scroll area. Column widths follow full header and data widths; loss columns no longer reserve fixed 24-character fields. Narrow terminals retain horizontal scrolling, and focusing an off-screen header brings it into view.

## Adapter Config and statistics

`View → Adapter Config` is available only when no adapters are connected (including
adapters loaded by Play). It hides the device tree and disables Add. The port list
contains USB CDC ACM devices only: Linux uses USB interface descriptors; Windows
uses the `usbser` device service. Both show the port and the device name.
Discovery runs independently of the view-change operation and shows a loading
state. If discovery returns no devices, a serial-port input allows manual entry.
When devices are found, the selector only accepts the enumerated CDC ports.

Opening a port reads the current mode. Firmware `UDP` is displayed as `enet`.
Only `enet` shows the shared network editor: Slave ID 0–252 corresponds to
`192.168.100.1`–`192.168.100.253`. Editing either field updates the other when its
value is valid; Read reloads the fields, and Apply saves and reboots through the
existing CLI transport. Apply, Reboot and completed firmware downloads keep the
loading dialog open. Apply and Reboot wait up to 15 seconds for CDC to disappear
and return (or for its device node to be replaced), without sending firmware
commands during reset. Communication then has a separate 6-second reconnect budget.
Completed downloads skip the restart wait because the native updater already
verifies application startup.
Reconnection requires successful opens and matching configuration reads over one
second, so a reply before the delayed USB reset is not mistaken for recovery.
Success reloads the current mode/network; failure returns to port selection and
reports the error. The firmware transfer retains its separate upgrade timeout. Version and operation replies go to Logs. Download
accepts prebuilt `.upd` packages with their original version and validates block
framing, device ID and SHA256 before rebooting. OTA `.bin`/`.elf` applications
retain automatic packaging. Firmware Browse uses the common file dialog with
`.upd`/`.bin`/`.elf` filtering; Play retains `.csv`.

Ethernet, SocketCAN (`Can`), and `GsUsb` adapters have a `Statistic` tab. It reads
cached driver snapshots approximately twice per second while visible. It can
monitor a running Stress test without stopping it; leaving for Bench/Timing or
changing the device/view still stops the test. A failed refresh invalidates the
displayed snapshot instead of leaving old values marked valid.

The common snapshot contains required slave/bus addresses, an enum sample
status, optional sample age, and an optional TX/RX error-counter pair. The counter
kind distinguishes current values (kernel/GET_STATE) from last-error-event values
(gateway). Missing counters display as `-`, not zero. Pending, valid and stale
samples are distinct. Adapter-specific totals, traffic, controller state and raw
registers are not part of this public contract. No statistics request commits motor commands or changes sync mode.

### Driver delivery requirement

CLI and emcli-native require `@encos/encos-driver-native >=4.3.1 <4.4.0`, with
development and CI builds pinned to **4.3.1**. This includes
`BaseAdapter::GetStatistics()` and the typed `AdapterWrapper.getStatistics()`
API. DexHand requires a driver build with the `getDexHand()` API.

When upgrading the driver, publish the matching selector and platform packages,
regenerate the CLI lockfile, pin the new SDK archive checksums in CI provisioning,
and rebuild the offline Linux and Windows toolchain caches. Keep the driver core
and plugins on the same version.
