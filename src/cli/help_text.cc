#include "src/cli/help_text.h"

#include <iomanip>
#include <sstream>
#include <string>
#include <unordered_set>

#include "cli_command.h"
#include "src/cli/bench.h"
#include "src/cli/play.h"
#include "src/cli/stress.h"

namespace motor_cli {

namespace {

// 平台相关的示例词汇：CDC 串口设备名随操作系统不同。
#if defined(_WIN32)
constexpr const char* kCdcDeviceExample = "COM5";
#else
constexpr const char* kCdcDeviceExample = "/dev/ttyACM0";
#endif

// 位时序选项说明的单一来源
constexpr const char* kBitrateHelp =
    "CAN arbitration-phase bitrate in bit/s, applied to every adapter this command opens";
constexpr const char* kDbitrateHelp = "CAN FD data-phase bitrate in bit/s, applied to every adapter this command opens";
constexpr const char* kSamplePointHelp =
    "CAN arbitration-phase sample point in (0, 1], applied to every adapter this command opens";
constexpr const char* kDsamplePointHelp =
    "CAN FD data-phase sample point in (0, 1], applied to every adapter this command opens";

constexpr const char* kTimingScopeNote =
    "  Only the Can, Slcan, Ethernet and GsUsb adapters read these options; other adapters record\n"
    "  a warning and ignore them. Omitted options keep each adapter's own plugin default.\n"
    "  Slcan supports only the S0-S8 arbitration rates and tolerates data-phase fields solely at\n"
    "  their standard defaults.\n";

/** @brief 是否为从站配置子模式的动作词（与 slave_config.cc 的解析保持一致） */
bool IsSlaveConfigAction(const std::string& value) {
  static const std::unordered_set<std::string> actions = {"ip",     "slave", "mode",    "version",
                                                          "reboot", "raw",   "download"};
  return actions.find(value) != actions.end();
}

}  // namespace

std::string SlaveConfigHelp() {
  return std::string("Slave configuration targets:\n") +
         "  Ethernet:<interface>:<SlaveId|uuid> (SlaveId unicast, UUID broadcast)\n" +
         "  Ethernet:" + kCdcDeviceExample + " | Ethercat:" + kCdcDeviceExample + " (USB CDC)\n" +
         "  emcli config <target> ip [set 192.168.100.<1..253>]\n" +
         "  emcli config <target> slave [set <0..252>] (IP last octet = SlaveId + 1)\n" +
         "  emcli config <target> mode [set ecat|enet|usb3can|usb8can|sim|simsensors]\n" +
         "  emcli config <target> download <firmware.bin|firmware.elf> (USB CDC only)\n" +
         "    Reboot to USB MSC, write OTA firmware, then verify confirmed startup.\n" +
         "    Requires OTA bootloader; raw .bin or RISC-V .elf linked at 0x80041000.\n" +
         "    Version is automatically incremented. EthercatIGH CDC targets are supported.\n" +
         "  emcli config <target> version [get] (read firmware version via VERSION GET)\n" +
         "  emcli config <target> reboot\n" + "  emcli config <target> raw <CDC command...>\n" +
         "IP/slave/mode writes save to Flash and reboot automatically. Raw executes exactly one command.\n";
}

const char* BitrateOptionHelp() { return kBitrateHelp; }
const char* DbitrateOptionHelp() { return kDbitrateHelp; }
const char* SamplePointOptionHelp() { return kSamplePointHelp; }
const char* DsamplePointOptionHelp() { return kDsamplePointHelp; }

std::string BuildAdapterTimingHelpBlock() {
  std::ostringstream output;
  output << "CAN timing options (optional; applied to every adapter this command opens):\n"
         << "  --bitrate BPS           CAN arbitration-phase bitrate in bit/s\n"
         << "  --dbitrate BPS          CAN FD data-phase bitrate in bit/s\n"
         << "  --sample-point RATIO    CAN arbitration-phase sample point in (0, 1]\n"
         << "  --dsample-point RATIO   CAN FD data-phase sample point in (0, 1]\n"
         << kTimingScopeNote;
  return output.str();
}

std::string BuildTopLevelHelp() {
  std::ostringstream output;
  output << "Usage:\n"
         << "  emcli\n"
         << "  emcli <command> [args]\n"
         << "\n"
         << "Encos Motor terminal debugger and command line configuration tool\n"
         << "\n"
         << "Options:\n"
         << "  -h, --help                 Show this help message and exit\n"
         << "  -v, --version              Print version information and exit\n"
         << "\n"
         << "Commands:\n"
         << "  tui                        Open TUI, optionally preloading adapters\n"
         << "  scan                       List adapter interfaces or scan motors\n"
         << "  config                     Read or set motor configuration\n"
         << "  control                    Continuously send motor control commands\n"
         << "  imu                        Show IMU status or start/stop bus IMU forwarding\n"
         << "  battery                    Show or clear battery status from a bus device\n"
         << "  pms                        Show or control the power management system\n"
         << "  glove                      Show or calibrate glove encoders\n"
         << "  play                       Play motors from a trajectory CSV\n"
         << "  bench                      Benchmark a single adapter\n"
         << "  stress                     Stress test one or more adapters\n"
         << "\n"
         << "Run 'emcli <command> -h' for command-specific help.\n";
  return output.str();
}

std::string BuildTuiHelp() {
  std::ostringstream output;
  output << "Usage:\n"
         << "  emcli\n"
         << "  emcli tui [AdapterType:AdapterId...]\n"
         << "\n"
         << "Open the terminal UI. Adapter arguments preload adapters before showing the UI.\n"
         << "\n"
         << "Examples:\n"
         << "  emcli\n"
         << "  emcli tui Ethercat:eth0 Ethercat:ALL\n";
  // CAN 位时序选项（可选）：对该命令打开的每个适配器生效
  output << "\n" << BuildAdapterTimingHelpBlock();
  return output.str();
}

std::string BuildScanHelp() {
  std::ostringstream output;
  output << "Slave scan: emcli scan --slave <Ethernet|Ethercat-related-plugin>:<Interface>\n";
  output << "Usage:\n"
         << "  emcli scan <AdapterType>\n"
         << "  emcli scan <AdapterType:AdapterId[:BusId]>\n"
         << "  emcli scan <AdapterType:AdapterId:SlaveId:BusId>\n"
         << "\n"
         << "Adapter scan output:\n"
         << "  <adapter_id>\n"
         << "\n"
         << "Scan output:\n"
         << "  slave\\tbus\\tid\\teff\\tcanfd\n"
         << "  <slave_id>\\t<bus_id>\\t<motor_id>\\t<0|1>\\t<0|1>\n"
         << "\n"
         << "Examples:\n"
         << "  emcli scan Ethercat\n"
         << "  emcli scan Ethercat:eth0\n"
         << "  emcli scan Ethercat:eth0:0\n"
         << "  emcli scan Ethercat:eth0:3:0\n";
  // CAN 位时序选项（可选）：对该命令打开的每个适配器生效
  output << "\n" << BuildAdapterTimingHelpBlock();
  return output.str();
}

std::string BuildConfigHelp() {
  std::ostringstream output;
  // 只给从站配置（纯 udp/usb）的入口提示：完整说明在该子模式下由 SlaveConfigHelp() 单独显示，
  // 避免电机配置的报错把整篇从站手册一起打出来。
  output << "Slave configuration (UDP/CDC): emcli config <Ethernet|Ethercat*>:<target> "
            "ip|slave|mode|version|reboot|raw\n";
  output << "\n";
  output << "Usage:\n"
         << "  emcli config [--canfd] <target> <item>\n"
         << "  emcli config [--canfd] <target> <item> set <values>\n"
         << "  emcli config [--canfd] <target> comm set <can|canfd|canopen>\n"
         << "\n"
         << "Options:\n"
         << "  --canfd                    Send motor commands with CAN FD frames\n"
         << "\n"
         << "Target:\n"
         << "  AdapterType:AdapterId:ALL\n"
         << "  AdapterType:AdapterId:BusId:ALL\n"
         << "  AdapterType:AdapterId:BusId:MotorId\n"
         << "  AdapterType:AdapterId:SlaveId:BusId:ALL\n"
         << "  AdapterType:AdapterId:SlaveId:BusId:MotorId\n"
         << "\n"
         << "Readable items:\n"
         << "  position, kt, pvt-kp-range, pvt-kd-range, pvt-pos-range,\n"
         << "  pvt-spd-range, pvt-tor-range, pvt-cur-range, cur-pi, spd-pi,\n"
         << "  pos-pd, can-timeout, brake (alias: barke; returns engage or release)\n"
         << "  emcli config <target> brake engage|release (one-shot, waits for acknowledgement)\n"
         << "\n"
         << "Set examples:\n"
         << "  emcli config Ethercat:eth0:0:1 id set 2\n"
         << "  emcli config Ethercat:eth0:0:ALL kt\n"
         << "  emcli config Ethercat:eth0:3:0:1 kt set 0.120000\n"
         << "  emcli config Ethercat:eth0:3:0:1 pvt-kp-range set 1 500\n"
         << "  emcli config Ethercat:eth0:3:0:1 position set 0\n"
         << "  emcli config Ethercat:eth0:3:0:1 position set 45\n"
         << "  emcli config Ethercat:eth0:3:0:1 position reset\n"
         << "  emcli config Ethercat:eth0:3:0:1 comm set canfd\n"
         << "  emcli config Ethercat:eth0:3:0:1 comm set canfd\n";
  // CAN 位时序选项（可选）：对该命令打开的每个适配器生效
  output << "\n" << BuildAdapterTimingHelpBlock();
  return output.str();
}

std::string BuildConfigItemHelp(const std::string& item) {
  std::ostringstream output;
  output << "Usage:\n";
  if (item == "comm") {
    output << "  emcli config [--canfd] <target> comm set <can|canfd|canopen>\n"
           << "\n"
           << "Set motor communication mode.\n"
           << "\n"
           << "Modes:\n"
           << "  can\n"
           << "  canfd\n"
           << "  canopen\n"
           << "\n"
           << "Example:\n"
           << "  emcli config Ethercat:eth0:3:0:1 comm set canfd\n";
    return output.str();
  }
  if (item == "brake" || item == "barke") {
    output << "  emcli config [--canfd] <target> " << item << " [engage|release]\n"
           << "\nRead: brake engage = held, brake release = unlocked.\n"
           << "Control: engage holds, release unlocks; waits for acknowledgement.\n"
           << "brake and barke are aliases.\n";
  } else if (item == "id") {
    output << "  emcli config [--canfd] <target> id set <new_id>\n";
  } else if (item == "position") {
    output << "  emcli config [--canfd] <target> position\n"
           << "  emcli config [--canfd] <target> position set <position_deg>\n"
           << "  emcli config [--canfd] <target> position reset\n";
  } else if (item == "kt") {
    output << "  emcli config [--canfd] <target> kt\n"
           << "  emcli config [--canfd] <target> kt set <value>\n";
  } else if (item == "pvt-kp-range" || item == "pvt-kd-range" || item == "pvt-pos-range" || item == "pvt-spd-range" ||
             item == "pvt-tor-range" || item == "pvt-cur-range") {
    output << "  emcli config [--canfd] <target> " << item << "\n"
           << "  emcli config [--canfd] <target> " << item << " set <min> <max>\n";
  } else if (item == "cur-pi" || item == "spd-pi") {
    output << "  emcli config [--canfd] <target> " << item << "\n"
           << "  emcli config [--canfd] <target> " << item << " set <kp> <ki>\n";
  } else if (item == "pos-pd") {
    output << "  emcli config [--canfd] <target> pos-pd\n"
           << "  emcli config [--canfd] <target> pos-pd set <kp> <kd>\n";
  } else if (item == "can-timeout") {
    output << "  emcli config [--canfd] <target> can-timeout\n"
           << "  emcli config [--canfd] <target> can-timeout set <timeout_ms>\n";
  } else {
    return BuildConfigHelp();
  }
  output << "\n"
         << "Target:\n"
         << "  AdapterType:AdapterId:ALL\n"
         << "  AdapterType:AdapterId:BusId:ALL\n"
         << "  AdapterType:AdapterId:BusId:MotorId\n"
         << "  AdapterType:AdapterId:SlaveId:BusId:ALL\n"
         << "  AdapterType:AdapterId:SlaveId:BusId:MotorId\n";
  return output.str();
}

std::string BuildControlHelp() {
  std::ostringstream output;
  output << "Usage:\n"
         << "  emcli control [--canfd] <mode> <target> <values>\n"
         << "\n"
         << "Options:\n"
         << "  --canfd                    Send motor commands with CAN FD frames\n"
         << "\n"
         << "Modes:\n"
         << "  pvt <kp> <kd> <position_deg> <speed_rad_s> <torque_nm>\n"
         << "  position <position_deg> <max_speed_rad_s> <max_current_a>\n"
         << "  speed <speed_rad_s> <max_current_a>\n"
         << "  current <current_a>\n"
         << "  torque <torque_nm>\n"
         << "  brake engage|release (mechanical brake, one-shot)\n"
         << "  stop full\n"
         << "  stop dynamic <max_current_a>\n"
         << "  stop regenerative <max_current_a>\n"
         << "\n"
         << "Target:\n"
         << "  AdapterType:AdapterId:ALL\n"
         << "  AdapterType:AdapterId:BusId:ALL\n"
         << "  AdapterType:AdapterId:BusId:MotorId\n"
         << "  AdapterType:AdapterId:SlaveId:BusId:ALL\n"
         << "  AdapterType:AdapterId:SlaveId:BusId:MotorId\n"
         << "\n"
         << "Output:\n"
         << "  Mechanical brake executes once and reports acknowledgement per motor.\n"
         << "  Other modes: feedback is printed as a fixed-width table every 0.5s.\n"
         << "  The table header is repeated every 10 feedback rows.\n"
         << "  Press q or Ctrl-C to exit.\n"
         << "\n"
         << "Control examples:\n"
         << "  emcli control pvt Ethercat:eth0:3:0:1 20 1 45 10 0.5\n"
         << "  emcli control position Ethercat:eth0:3:0:1 90 20 3\n"
         << "  emcli control current Ethercat:eth0:0:ALL 1.5\n"
         << "  emcli control speed Ethercat:eth0:3:0:1 15 2\n"
         << "  emcli control current Ethercat:eth0:3:0:1 1.5\n"
         << "  emcli control torque Ethercat:eth0:3:0:1 0.8\n"
         << "  emcli control stop Ethercat:eth0:3:0:1 full\n"
         << "  emcli control stop Ethercat:eth0:3:0:1 dynamic 2\n"
         << "  emcli control stop Ethercat:eth0:3:0:1 regenerative 2\n";
  // CAN 位时序选项（可选）：对该命令打开的每个适配器生效
  output << "\n" << BuildAdapterTimingHelpBlock();
  return output.str();
}

std::string BuildControlModeHelp(const std::string& mode) {
  std::ostringstream output;
  output << "Usage:\n";
  if (mode == "pvt") {
    output << "  emcli control [--canfd] pvt <target> <kp> <kd> <position_deg> <speed_rad_s> <torque_nm>\n";
  } else if (mode == "position") {
    output << "  emcli control [--canfd] position <target> <position_deg> <max_speed_rad_s> <max_current_a>\n";
  } else if (mode == "speed") {
    output << "  emcli control [--canfd] speed <target> <speed_rad_s> <max_current_a>\n";
  } else if (mode == "current") {
    output << "  emcli control [--canfd] current <target> <current_a>\n";
  } else if (mode == "torque") {
    output << "  emcli control [--canfd] torque <target> <torque_nm>\n";
  } else if (mode == "brake") {
    output << "  emcli control [--canfd] brake <target> engage|release\n"
           << "\nMechanical brake: engage holds, release unlocks. Executes once and reports acknowledgement.\n";
    return output.str();
  } else if (mode == "stop") {
    output << "  emcli control [--canfd] stop <target> full\n"
           << "  emcli control [--canfd] stop <target> dynamic <max_current_a>\n"
           << "  emcli control [--canfd] stop <target> regenerative <max_current_a>\n";
  } else {
    return BuildControlHelp();
  }
  output << "\n"
         << "Target:\n"
         << "  AdapterType:AdapterId:ALL\n"
         << "  AdapterType:AdapterId:BusId:ALL\n"
         << "  AdapterType:AdapterId:BusId:MotorId\n"
         << "  AdapterType:AdapterId:SlaveId:BusId:ALL\n"
         << "  AdapterType:AdapterId:SlaveId:BusId:MotorId\n"
         << "\n"
         << "Output:\n"
         << "  Feedback is printed every 0.5s. Press q or Ctrl-C to exit.\n";
  return output.str();
}

std::string BuildImuHelp() {
  std::ostringstream output;
  output << "Usage:\n"
         << "  emcli imu show <target>\n"
         << "  emcli imu <target> <start|stop>\n"
         << "\n"
         << "Target:\n"
         << "  AdapterType:AdapterId:BusId (start/stop only)\n"
         << "  AdapterType:AdapterId:BusId:ImuIdx\n"
         << "  AdapterType:AdapterId:SlaveId:BusId:ImuIdx\n"
         << "\n"
         << "Output:\n"
         << "  Refresh IMU status in place at 50 Hz.\n"
         << "  Fixed rows: accel, gyro, euler.\n"
         << "  Missing groups leave value columns blank.\n"
         << "  start/stop submits a bus-wide forwarding command and exits; ImuIdx is ignored.\n"
         << "  No device acknowledgement. Configure the bus for 1 Mbps classic CAN first.\n"
         << "\n"
         << "Examples:\n"
         << "  emcli imu show Ethercat:eth0:0:0\n"
         << "  emcli imu show Ethercat:eth0:3:0:1\n"
         << "  emcli imu Ethercat:eth0:7 start\n"
         << "  emcli imu Ethercat:eth0:7:0 stop\n"
         << "  emcli imu Ethercat:eth0:3:7:0 start\n";
  // CAN 位时序选项（可选）：对该命令打开的每个适配器生效
  output << "\n" << BuildAdapterTimingHelpBlock();
  return output.str();
}

std::string BuildBatteryHelp() {
  std::ostringstream output;
  output << "Usage:\n"
         << "  emcli battery show <target>\n"
         << "  emcli battery clear <target>\n"
         << "\n"
         << "Target:\n"
         << "  AdapterType:AdapterId:BusId:BatteryIdx\n"
         << "  AdapterType:AdapterId:SlaveId:BusId:BatteryIdx\n"
         << "\n"
         << "Output:\n"
         << "  Show refreshes battery status in place at 50 Hz.\n"
         << "  Each active error is printed as its own error line.\n"
         << "\n"
         << "Examples:\n"
         << "  emcli battery show Ethercat:eth0:0:0\n"
         << "  emcli battery clear Ethercat:eth0:3:0:1\n";
  // CAN 位时序选项（可选）：对该命令打开的每个适配器生效
  output << "\n" << BuildAdapterTimingHelpBlock();
  return output.str();
}

std::string BuildPmsHelp() {
  std::ostringstream output;
  output << "Usage:\n"
         << "  emcli pms show <target>\n"
         << "  emcli pms enable <target> V48_1 ...\n"
         << "  emcli pms disable <target> V48_1 ...\n"
         << "\n"
         << "Target:\n"
         << "  AdapterType:AdapterId:BusId\n"
         << "  AdapterType:AdapterId:SlaveId:BusId\n"
         << "\n"
         << "Channels:\n"
         << "  Controls: V48_1 V48_2 V48_3 V48_4 V48_5 V48_6\n"
         << "  Status: V48_1 ... V48_6, V19, V5\n"
         << "\n"
         << "Output:\n"
         << "  Show refreshes PMS status in place at 50 Hz. Press q or Ctrl-C to exit.\n";
  // CAN 位时序选项（可选）：对该命令打开的每个适配器生效
  output << "\n" << BuildAdapterTimingHelpBlock();
  return output.str();
}

std::string BuildGloveHelp() {
  std::ostringstream output;
  output << "Usage:\n"
         << "  emcli glove show <target>\n"
         << "  emcli glove calibrate <target> all\n"
         << "  emcli glove calibrate <target> <finger_idx> <encoder_idx>\n"
         << "  emcli glove calibrate <target> <finger_idx> mask <encoder_mask>\n"
         << "\n"
         << "Target:\n"
         << "  AdapterType:AdapterId:SlaveId\n"
         << "\n"
         << "Calibration:\n"
         << "  all                        Calibrate all 50 encoders\n"
         << "  <finger_idx> <encoder_idx> Calibrate one encoder (finger 0-4, encoder 0-9)\n"
         << "  <finger_idx> mask <mask>   Calibrate encoders selected by a 10-bit mask\n"
         << "\n"
         << "Output:\n"
         << "  Show refreshes glove encoder status in place at 50 Hz.\n"
         << "  Rows are encoders E0-E9, columns are fingers F0-F4.\n"
         << "  Encoders without valid data are shown as OFF.\n"
         << "  Calibrate is synchronous; the driver waits up to 5 ms per finger.\n"
         << "  Calibrate fails with exit code 1 on error or timeout.\n"
         << "  Press q or Ctrl-C to exit show.\n"
         << "\n"
         << "Examples:\n"
         << "  emcli glove show Ethercat:eth0:3\n"
         << "  emcli glove calibrate Ethercat:eth0:3 all\n"
         << "  emcli glove calibrate Ethercat:eth0:3 1 5\n"
         << "  emcli glove calibrate Ethercat:eth0:3 2 mask 0x03F\n";
  // CAN 位时序选项（可选）：对该命令打开的每个适配器生效
  output << "\n" << BuildAdapterTimingHelpBlock();
  return output.str();
}

std::string BuildBenchHelp() {
  argparse::ArgumentParser parser("bench");
  ConfigureBenchCommand(parser);
  return parser.help().str();
}

std::string BuildStressHelp() {
  argparse::ArgumentParser parser("stress");
  ConfigureStressCommand(parser);
  return parser.help().str();
}

std::string BuildPlayHelp() {
  argparse::ArgumentParser parser("emcli play");
  ConfigurePlayCommand(parser);
  return parser.help().str();
}

std::string BuildHelpForCommand(const std::string& command) {
  if (command == "tui") {
    return BuildTuiHelp();
  }
  if (command == "scan") {
    return BuildScanHelp();
  }
  if (command == "config") {
    return BuildConfigHelp();
  }
  if (command == "control") {
    return BuildControlHelp();
  }
  if (command == "imu") {
    return BuildImuHelp();
  }
  if (command == "battery") {
    return BuildBatteryHelp();
  }
  if (command == "pms") {
    return BuildPmsHelp();
  }
  if (command == "glove") {
    return BuildGloveHelp();
  }
  if (command == "bench") {
    return BuildBenchHelp();
  }
  if (command == "stress") {
    return BuildStressHelp();
  }
  if (command == "play") {
    return BuildPlayHelp();
  }
  return BuildTopLevelHelp();
}

bool IsConfigItemName(const std::string& value) {
  static const std::unordered_set<std::string> items = {"id",
                                                        "position",
                                                        "calibrate",
                                                        "kt",
                                                        "pvt-kp-range",
                                                        "pvt-kd-range",
                                                        "pvt-pos-range",
                                                        "pvt-spd-range",
                                                        "pvt-tor-range",
                                                        "pvt-cur-range",
                                                        "cur-pi",
                                                        "spd-pi",
                                                        "pos-pd",
                                                        "can-timeout",
                                                        "brake",
                                                        "barke",
                                                        "comm"};
  return items.find(value) != items.end();
}

bool IsControlModeName(const std::string& value) {
  static const std::unordered_set<std::string> modes = {"pvt",    "position", "speed", "current",
                                                        "torque", "stop",     "brake"};
  return modes.find(value) != modes.end();
}

std::string BuildHelpForArgs(int argc, char** argv) {
  if (argc < 2) {
    return BuildTopLevelHelp();
  }

  const std::string command = argv[1];
  if (command == "config") {
    // 纯 udp/usb 从站配置子模式（ip|slave|mode|version|reboot|raw）不涉及电机：只显示该模式自己的帮助
    for (int index = 2; index < argc; ++index) {
      if (IsSlaveConfigAction(argv[index])) {
        return SlaveConfigHelp();
      }
    }
    for (int index = 2; index < argc; ++index) {
      const std::string argument = argv[index];
      if (IsConfigItemName(argument)) {
        return BuildConfigItemHelp(argument);
      }
    }
  }
  if (command == "control") {
    for (int index = 2; index < argc; ++index) {
      const std::string argument = argv[index];
      if (IsControlModeName(argument)) {
        return BuildControlModeHelp(argument);
      }
    }
  }
  return BuildHelpForCommand(command);
}
}  // namespace motor_cli
