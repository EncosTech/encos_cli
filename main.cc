#include <sys/select.h>
#include <termios.h>
#include <unistd.h>

#include <argparse/argparse.hpp>
#include <atomic>
#include <cmath>
#include <csignal>
#include <cstdint>
#include <exception>
#include <filesystem>
#include <future>
#include <iomanip>
#include <iostream>
#include <memory>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

#include "cli_command.h"
#include "components/app_state.h"
#include "components/control_panel.h"
#include "components/graph_panel.h"
#include "components/left_panel.h"
#include "components/math_constants.h"
#include "components/middle_panel.h"
#include "ftxui/component/component.hpp"
#include "ftxui/component/screen_interactive.hpp"
#include "ftxui/dom/elements.hpp"
#include "src/cli/battery.h"
#include "src/cli/bench.h"
#include "src/cli/glove.h"
#include "src/cli/imu.h"
#include "src/cli/interface_name.h"
#include "src/cli/play.h"
#include "src/cli/pms.h"
#include "src/cli/stress.h"
#include "src/cli/zero.h"
#include "src/driver_version.h"

#ifndef EMCLI_VERSION
#define EMCLI_VERSION "unknown"
#endif

namespace motor_cli {
namespace {

namespace fs = std::filesystem;

std::atomic<bool> g_stop_requested{false};

struct AdapterSpec {
  std::string type;
  std::string id;
};

struct ResolvedMotorTarget {
  std::optional<int32_t> slave_id;
  int32_t bus_id{0};
  uint16_t motor_id{0};
  encos::Bus* bus{nullptr};
  encos::Motor* motor{nullptr};
};

class TerminalRawMode {
public:
  TerminalRawMode() {
    if (!isatty(STDIN_FILENO)) {
      return;
    }
    if (tcgetattr(STDIN_FILENO, &original_) != 0) {
      return;
    }
    termios raw = original_;
    raw.c_lflag = static_cast<tcflag_t>(raw.c_lflag & ~(ICANON | ECHO));
    raw.c_cc[VMIN] = 0;
    raw.c_cc[VTIME] = 0;
    if (tcsetattr(STDIN_FILENO, TCSANOW, &raw) == 0) {
      active_ = true;
    }
  }

  ~TerminalRawMode() {
    if (active_) {
      tcsetattr(STDIN_FILENO, TCSANOW, &original_);
    }
  }

  TerminalRawMode(const TerminalRawMode&) = delete;
  TerminalRawMode& operator=(const TerminalRawMode&) = delete;

private:
  termios original_{};
  bool active_{false};
};

void HandleSignal(int) { g_stop_requested.store(true); }

class SignalGuard {
public:
  explicit SignalGuard(int signal) : signal_(signal), previous_handler_(std::signal(signal, HandleSignal)) {}
  ~SignalGuard() { std::signal(signal_, previous_handler_); }

  SignalGuard(const SignalGuard&) = delete;
  SignalGuard& operator=(const SignalGuard&) = delete;

private:
  int signal_;
  void (*previous_handler_)(int);
};

bool QuitKeyPressed() {
  if (!isatty(STDIN_FILENO)) {
    return false;
  }

  fd_set read_fds;
  FD_ZERO(&read_fds);
  FD_SET(STDIN_FILENO, &read_fds);
  timeval timeout{0, 0};
  if (select(STDIN_FILENO + 1, &read_fds, nullptr, nullptr, &timeout) <= 0) {
    return false;
  }

  char input = '\0';
  if (read(STDIN_FILENO, &input, 1) != 1) {
    return false;
  }
  return input == 'q' || input == 'Q';
}

std::pair<std::string, std::string> ParseAdapterArg(const std::string& value) {
  const std::size_t separator = value.find(':');
  if (separator == std::string::npos || separator == 0 || separator + 1 >= value.size()) {
    throw std::runtime_error("Invalid adapter value: '" + value + "', expected Type:Id");
  }
  return {value.substr(0, separator), value.substr(separator + 1)};
}

std::vector<AdapterSpec> ResolveAdapterSpecs(const std::vector<std::string>& raw_specs) {
  const auto adapter_types = encos::GetAvailableAdapterTypes();
  const std::unordered_set<std::string> available_types(adapter_types.begin(), adapter_types.end());

  std::unordered_map<std::string, std::unordered_set<std::string>> interfaces_by_type;
  std::unordered_set<std::string> dedup_keys;
  std::vector<AdapterSpec> resolved_specs;

  for (const std::string& raw_spec : raw_specs) {
    const auto [type, id] = ParseAdapterArg(raw_spec);
    if (available_types.find(type) == available_types.end()) {
      throw std::runtime_error("Unknown adapter type: '" + type + "'");
    }

    auto interface_it = interfaces_by_type.find(type);
    if (interface_it == interfaces_by_type.end()) {
      const auto all_interfaces = encos::GetAvailableInterface(type);
      interface_it = interfaces_by_type
                         .emplace(type, std::unordered_set<std::string>(all_interfaces.begin(), all_interfaces.end()))
                         .first;
    }

    const auto& type_interfaces = interface_it->second;
    if (id == "ALL") {
      if (type_interfaces.empty()) {
        std::cerr << "Warning: no available interfaces for adapter type '" << type << "', skip '" << raw_spec << "'"
                  << std::endl;
        continue;
      }
      for (const std::string& interface_name : type_interfaces) {
        const std::string dedup_key = type + "\n" + interface_name;
        if (dedup_keys.insert(dedup_key).second) {
          resolved_specs.push_back(AdapterSpec{type, interface_name});
        }
      }
      continue;
    }

    if (type_interfaces.find(id) == type_interfaces.end()) {
      throw std::runtime_error("Unknown adapter id '" + id + "' for type '" + type + "'");
    }

    const std::string dedup_key = type + "\n" + id;
    if (dedup_keys.insert(dedup_key).second) {
      resolved_specs.push_back(AdapterSpec{type, id});
    }
  }

  return resolved_specs;
}

void PreloadAdapters(const std::vector<AdapterSpec>& adapter_specs, AppState& app_state) {
  for (const AdapterSpec& spec : adapter_specs) {
    encos::BaseAdapterPtr adapter =
        encos::MakeAdapter(spec.type, spec.id, GetLoggerName(spec.type, spec.id), encos::LogLevel::Off);
    if (!adapter) {
      throw std::runtime_error("Failed to create adapter: '" + spec.type + ":" + spec.id + "'");
    }
    app_state.adapter_state.adapters.push_back(AdapterEntry{spec.type, std::move(adapter)});
  }
}

bool ContainsHelpRequest(int argc, char** argv) {
  for (int index = 1; index < argc; ++index) {
    const std::string argument = argv[index];
    if (argument == "-h" || argument == "--help") {
      return true;
    }
  }
  return false;
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

std::string BuildZeroHelp() {
  argparse::ArgumentParser parser("emcli zero");
  ConfigureZeroCommand(parser);
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
  if (command == "zero") {
    return BuildZeroHelp();
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
                                                        "comm"};
  return items.find(value) != items.end();
}

bool IsControlModeName(const std::string& value) {
  static const std::unordered_set<std::string> modes = {"pvt", "position", "speed", "current", "torque", "brake"};
  return modes.find(value) != modes.end();
}

std::string BuildHelpForArgs(int argc, char** argv) {
  if (argc < 2) {
    return BuildTopLevelHelp();
  }

  const std::string command = argv[1];
  if (command == "config") {
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

std::string FormatCliFloat(float value) {
  std::ostringstream stream;
  stream << std::fixed << std::setprecision(6) << value;
  return stream.str();
}

float ParseFloat(const std::string& value, const std::string& field_name) {
  try {
    std::size_t parsed_chars = 0;
    const float parsed = std::stof(value, &parsed_chars);
    if (parsed_chars != value.size() || !std::isfinite(parsed)) {
      throw std::runtime_error(field_name + " is not a valid finite float: '" + value + "'");
    }
    return parsed;
  } catch (const std::invalid_argument&) {
    throw std::runtime_error(field_name + " is not a valid float: '" + value + "'");
  } catch (const std::out_of_range&) {
    throw std::runtime_error(field_name + " is out of range: '" + value + "'");
  }
}

std::string FormatMotorError(encos::MotorError error) {
  switch (error) {
    case encos::MotorError::NoError:
      return "NoError";
    case encos::MotorError::OverTemperature:
      return "OverTemperature";
    case encos::MotorError::OverCurrent:
      return "OverCurrent";
    case encos::MotorError::VoltageHigh:
      return "VoltageHigh";
    case encos::MotorError::VoltageLow:
      return "VoltageLow";
    case encos::MotorError::EncoderError:
      return "EncoderError";
    case encos::MotorError::BrakeVoltageHigh:
      return "BrakeVoltageHigh";
    case encos::MotorError::DriverError:
      return "DriverError";
    case encos::MotorError::OverTemperatureWarning:
      return "OverTemperatureWarning";
    case encos::MotorError::NoResponse:
      return "NoResponse";
  }
  return std::to_string(static_cast<int>(error));
}

encos::BaseAdapterPtr OpenTargetAdapter(const std::string& adapter_type, const std::string& adapter_id) {
  encos::BaseAdapterPtr adapter =
      encos::MakeAdapter(adapter_type, adapter_id, GetLoggerName(adapter_type, adapter_id), encos::LogLevel::Warn);
  if (!adapter) {
    throw std::runtime_error("Failed to create adapter: '" + adapter_type + ":" + adapter_id + "'");
  }
  return adapter;
}

std::pair<std::optional<int32_t>, int32_t> DecodeAdapterBusId(int adapter_bus_id) {
  if (adapter_bus_id > 0xFFFF) {
    return {adapter_bus_id >> 16, adapter_bus_id & 0xFFFF};
  }
  return {std::nullopt, adapter_bus_id};
}

encos::Bus* OpenTargetBus(encos::BaseAdapter& adapter, const MotorTarget& target) {
  if (!target.bus_id.has_value()) {
    throw std::runtime_error("Target bus is not specified");
  }
  encos::Bus* bus =
      target.slave_id.has_value() ? adapter.GetBus(*target.slave_id, *target.bus_id) : adapter.GetBus(*target.bus_id);
  if (!bus) {
    throw std::runtime_error("Failed to get target bus");
  }
  return bus;
}

std::string FormatTargetPrefix(std::optional<int32_t> slave_id, int32_t bus_id, uint16_t motor_id,
                               const std::string& adapter_type = "Ethercat", const std::string& adapter_id = "") {
  std::ostringstream output;
  output << adapter_type << ':' << adapter_id << ':';
  if (slave_id.has_value()) {
    output << *slave_id << ':';
  }
  output << bus_id << ':' << motor_id;
  return output.str();
}

std::string FormatTargetPrefix(const ResolvedMotorTarget& target, const MotorTarget& request) {
  return FormatTargetPrefix(target.slave_id, target.bus_id, target.motor_id, request.adapter_type, request.adapter_id);
}

std::vector<ResolvedMotorTarget> ResolveMotorTargets(const MotorTarget& target) {
  encos::BaseAdapterPtr adapter = OpenTargetAdapter(target.adapter_type, target.adapter_id);
  std::vector<ResolvedMotorTarget> resolved;

  auto append_scanned_bus = [&](std::optional<int32_t> slave_id, int32_t bus_id, encos::Bus* bus) {
    if (!bus) {
      throw std::runtime_error("Failed to get target bus");
    }
    const auto motors = bus->ScanMotors();
    for (const auto& [motor_id, motor] : motors) {
      if (motor) {
        resolved.push_back(ResolvedMotorTarget{slave_id, bus_id, static_cast<uint16_t>(motor_id), bus, nullptr});
      }
    }
  };

  switch (target.scope) {
    case TargetScope::SingleMotor: {
      encos::Bus* bus = OpenTargetBus(*adapter, target);
      if (!target.motor_id.has_value()) {
        throw std::runtime_error("Target motor is not specified");
      }
      encos::Motor* motor = bus->GetMotor(*target.motor_id);
      if (!motor) {
        throw std::runtime_error("Failed to get target motor");
      }
      resolved.push_back(ResolvedMotorTarget{target.slave_id, *target.bus_id, *target.motor_id, bus, motor});
      break;
    }
    case TargetScope::AdapterAllMotors: {
      const std::unordered_map<int, encos::Bus*> buses = adapter->GetBuses();
      for (const auto& [adapter_bus_id, bus] : buses) {
        const auto [slave_id, bus_id] = DecodeAdapterBusId(adapter_bus_id);
        append_scanned_bus(slave_id, bus_id, bus);
      }
      break;
    }
    case TargetScope::BusAllMotors:
    case TargetScope::SlaveBusAllMotors: {
      encos::Bus* bus = OpenTargetBus(*adapter, target);
      append_scanned_bus(target.slave_id, *target.bus_id, bus);
      break;
    }
  }

  std::sort(resolved.begin(), resolved.end(), [](const ResolvedMotorTarget& lhs, const ResolvedMotorTarget& rhs) {
    if (lhs.slave_id.value_or(-1) != rhs.slave_id.value_or(-1)) {
      return lhs.slave_id.value_or(-1) < rhs.slave_id.value_or(-1);
    }
    if (lhs.bus_id != rhs.bus_id) {
      return lhs.bus_id < rhs.bus_id;
    }
    return lhs.motor_id < rhs.motor_id;
  });

  if (resolved.empty()) {
    throw std::runtime_error("No motors matched target");
  }
  return resolved;
}

void EnsureMotorInitialized(ResolvedMotorTarget& target) {
  if (target.motor) {
    return;
  }
  if (!target.bus) {
    throw std::runtime_error("Target bus is not available");
  }
  target.motor = target.bus->GetMotor(target.motor_id);
  if (!target.motor) {
    throw std::runtime_error("Failed to get target motor");
  }
}

encos::BaseAdapterPtr OpenScanAdapter(const ScanTarget& target) {
  return OpenTargetAdapter(target.adapter_type, target.adapter_id);
}

void PrintAvailableInterfaces(const std::string& adapter_type) {
  const auto adapter_types = encos::GetAvailableAdapterTypes();
  if (std::find(adapter_types.begin(), adapter_types.end(), adapter_type) == adapter_types.end()) {
    throw std::runtime_error("Unknown adapter type: '" + adapter_type + "'");
  }

  const auto interfaces = encos::GetAvailableInterface(adapter_type);
  for (const std::string& interface_name : interfaces) {
    std::cout << GetDisplayInterfaceName(adapter_type, interface_name) << '\n';
  }
}

std::string GetConfigValue(encos::Motor& motor, ConfigItem item) {
  std::ostringstream output;
  output << std::fixed << std::setprecision(6);
  switch (item) {
    case ConfigItem::Id:
      throw std::runtime_error("Config item 'id' is not readable");
    case ConfigItem::Position: {
      const float position_radians = motor.GetParameter<encos::MotorParameter::Position>();
      output << "position " << FormatCliFloat(position_radians * kRadiansToDegrees);
      break;
    }
    case ConfigItem::Kt:
      output << "kt " << FormatCliFloat(motor.GetParameter<encos::MotorParameter::Kt>());
      break;
    case ConfigItem::PvtKpRange: {
      const auto range = motor.GetParameter<encos::MotorParameter::PVTKpRange>();
      output << "pvt-kp-range " << range.min << ' ' << range.max;
      break;
    }
    case ConfigItem::PvtKdRange: {
      const auto range = motor.GetParameter<encos::MotorParameter::PVTKdRange>();
      output << "pvt-kd-range " << range.min << ' ' << range.max;
      break;
    }
    case ConfigItem::PvtPositionRange: {
      const auto range = motor.GetParameter<encos::MotorParameter::PVTPosRange>();
      output << "pvt-pos-range " << FormatCliFloat(range.min) << ' ' << FormatCliFloat(range.max);
      break;
    }
    case ConfigItem::PvtSpeedRange: {
      const auto range = motor.GetParameter<encos::MotorParameter::PVTSpdRange>();
      output << "pvt-spd-range " << FormatCliFloat(range.min) << ' ' << FormatCliFloat(range.max);
      break;
    }
    case ConfigItem::PvtTorqueRange: {
      const auto range = motor.GetParameter<encos::MotorParameter::PVTTorRange>();
      output << "pvt-tor-range " << FormatCliFloat(range.min) << ' ' << FormatCliFloat(range.max);
      break;
    }
    case ConfigItem::PvtCurrentRange: {
      const auto range = motor.GetParameter<encos::MotorParameter::PVTCurRange>();
      output << "pvt-cur-range " << FormatCliFloat(range.min) << ' ' << FormatCliFloat(range.max);
      break;
    }
    case ConfigItem::CurrentPi: {
      const auto values = motor.GetParameter<encos::MotorParameter::CurKpKi>();
      output << "cur-pi " << FormatCliFloat(values.kp) << ' ' << FormatCliFloat(values.ki);
      break;
    }
    case ConfigItem::SpeedPi: {
      const auto values = motor.GetParameter<encos::MotorParameter::SpdKpKi>();
      output << "spd-pi " << FormatCliFloat(values.kp) << ' ' << FormatCliFloat(values.ki);
      break;
    }
    case ConfigItem::PositionPd: {
      const auto values = motor.GetParameter<encos::MotorParameter::PosKpKd>();
      output << "pos-pd " << FormatCliFloat(values.kp) << ' ' << FormatCliFloat(values.kd);
      break;
    }
    case ConfigItem::CanTimeout:
      output << "can-timeout " << motor.GetParameter<encos::MotorParameter::CanTimeout>();
      break;
    case ConfigItem::Calibrate:
      throw std::runtime_error("Config item 'calibrate' is not readable");
    case ConfigItem::CommunicationMode:
      throw std::runtime_error("Config item 'comm' is not readable");
  }
  return output.str();
}

std::vector<ScanMotorRow> ScanBusAndFormatRows(std::optional<int32_t> slave_id, int32_t bus_id, encos::Bus* bus) {
  if (!bus) {
    throw std::runtime_error("Failed to get scan bus");
  }

  std::vector<ScanMotorRow> rows;
  const auto motors = bus->ScanMotors();
  for (const auto& [motor_id, motor] : motors) {
    if (motor) {
      rows.push_back(ScanMotorRow{slave_id, bus_id, motor_id, motor->IsCanEffEnabled(), motor->IsCanFdEnabled()});
    }
  }
  return rows;
}

void PrintConfigValue(encos::Motor& motor, ConfigItem item) { std::cout << GetConfigValue(motor, item) << '\n'; }

bool IsConfigReadbackItem(ConfigItem item) {
  return item != ConfigItem::Id && item != ConfigItem::Calibrate && item != ConfigItem::CommunicationMode;
}

bool SetConfigValue(encos::Motor& motor, const CliCommand& command) {
  const std::vector<std::string>& values = command.values;
  switch (command.item) {
    case ConfigItem::Id:
      return motor.SetId(ParseUint16(values[0], "NewId"), true);
    case ConfigItem::Calibrate: {
      const float min_radians = ParseFloat(values[0], "Min") * kDegreesToRadians;
      const float max_radians = ParseFloat(values[1], "Max") * kDegreesToRadians;
      const float speed = ParseFloat(values[2], "Speed");
      const float current = ParseFloat(values[3], "Current");
      const int direction = speed >= 0.0F ? 1 : -1;
      encos::Range<float> limit{min_radians, max_radians};
      return motor.Calibrate(limit, direction, speed, current);
    }
    case ConfigItem::Kt:
      return motor.SetKt(ParseFloat(values[0], "Kt"), true);
    case ConfigItem::PvtKpRange: {
      encos::Range<uint16_t> range{ParseUint16(values[0], "Min"), ParseUint16(values[1], "Max")};
      return motor.SetPVTKpRange(range, true);
    }
    case ConfigItem::PvtKdRange: {
      encos::Range<uint16_t> range{ParseUint16(values[0], "Min"), ParseUint16(values[1], "Max")};
      return motor.SetPVTKdRange(range, true);
    }
    case ConfigItem::PvtPositionRange: {
      encos::Range<float> range{ParseFloat(values[0], "Min"), ParseFloat(values[1], "Max")};
      return motor.SetPVTPosRange(range, true);
    }
    case ConfigItem::PvtSpeedRange: {
      encos::Range<float> range{ParseFloat(values[0], "Min"), ParseFloat(values[1], "Max")};
      return motor.SetPVTSpdRange(range, true);
    }
    case ConfigItem::PvtTorqueRange: {
      encos::Range<float> range{ParseFloat(values[0], "Min"), ParseFloat(values[1], "Max")};
      return motor.SetPVTTorRange(range, true);
    }
    case ConfigItem::PvtCurrentRange: {
      encos::Range<float> range{ParseFloat(values[0], "Min"), ParseFloat(values[1], "Max")};
      return motor.SetPVTCurRange(range, true);
    }
    case ConfigItem::CurrentPi:
      return motor.SetCurPI(ParseFloat(values[0], "Kp"), ParseFloat(values[1], "Ki"), true);
    case ConfigItem::SpeedPi:
      return motor.SetSpdPI(ParseFloat(values[0], "Kp"), ParseFloat(values[1], "Ki"), true);
    case ConfigItem::PositionPd:
      return motor.SetPosPD(ParseFloat(values[0], "Kp"), ParseFloat(values[1], "Kd"), true);
    case ConfigItem::CanTimeout:
      return motor.SetCanTimeout(ParseUint16(values[0], "Timeout"), true);
    case ConfigItem::Position:
      if (values.empty()) {
        return motor.ResetZeroPos(true);
      }
      return motor.SetPos(static_cast<double>(ParseFloat(values[0], "Position") * kDegreesToRadians));
    case ConfigItem::CommunicationMode:
      if (values[0] == "can") {
        return motor.SetCommunicationMode(encos::MotorCommunicationMode::ClassicCan, true);
      }
      if (values[0] == "canfd") {
        return motor.SetCommunicationMode(encos::MotorCommunicationMode::CanFd, true);
      }
      if (values[0] == "canopen") {
        return motor.SetCommunicationMode(encos::MotorCommunicationMode::CanOpen, true);
      }
      throw std::runtime_error("Unsupported communication mode");
  }
  throw std::runtime_error("Unsupported config item");
}

encos::MotorStopMode ToMotorStopMode(BrakeMode mode) {
  switch (mode) {
    case BrakeMode::Full:
      return encos::MotorStopMode::FullBrake;
    case BrakeMode::Dynamic:
      return encos::MotorStopMode::DynamicBrake;
    case BrakeMode::Regenerative:
      return encos::MotorStopMode::RegenerativeBrake;
  }
  return encos::MotorStopMode::FullBrake;
}

encos::MotorFeedbackMsg1 SendControlCommand(encos::Motor& motor, const ControlCommand& command) {
  const std::vector<float>& values = command.values;
  switch (command.item) {
    case ControlItem::Pvt:
      return motor.PVTControl<1>(values[0], values[1], values[2], values[3], values[4]);
    case ControlItem::Position:
      return motor.PosControl<1>(values[0], values[1], values[2]);
    case ControlItem::Speed:
      return motor.SpdControl<1>(values[0], values[1]);
    case ControlItem::Current:
      return motor.CurControl<1>(values[0]);
    case ControlItem::Torque:
      return motor.TorControl<1>(values[0]);
    case ControlItem::Brake: {
      const float current = command.brake_mode == BrakeMode::Full ? 0.0F : values[0];
      return motor.Stop<1>(ToMotorStopMode(command.brake_mode), current);
    }
  }
  throw std::runtime_error("Unsupported control mode");
}

void PrintControlFeedback(const encos::MotorFeedbackMsg1& feedback, float kt) {
  const float position_degrees = feedback.position * kRadiansToDegrees;
  const float torque = feedback.current * kt;
  std::cout << FormatControlRow(position_degrees, feedback.speed, torque, feedback.current, feedback.motor_temperature,
                                feedback.mos_temperature, FormatMotorError(feedback.error))
            << '\n';
}

std::string FormatBatchControlHeader() {
  std::ostringstream output;
  output << std::right << std::setw(5) << "slave" << "  " << std::setw(5) << "bus" << "  " << std::setw(5) << "id"
         << "  " << FormatControlHeader();
  return output.str();
}

std::string FormatBatchControlRow(const ResolvedMotorTarget& target, const encos::MotorFeedbackMsg1& feedback,
                                  float kt) {
  std::ostringstream output;
  output << std::right << std::setw(5);
  if (target.slave_id.has_value()) {
    output << *target.slave_id;
  } else {
    output << "";
  }
  output << "  " << std::setw(5) << target.bus_id << "  " << std::setw(5) << target.motor_id << "  ";
  const float position_degrees = feedback.position * kRadiansToDegrees;
  const float torque = feedback.current * kt;
  output << FormatControlRow(position_degrees, feedback.speed, torque, feedback.current, feedback.motor_temperature,
                             feedback.mos_temperature, FormatMotorError(feedback.error));
  return output.str();
}

int RunCli(int argc, char** argv) {
  if (ContainsHelpRequest(argc, argv)) {
    std::cout << BuildHelpForArgs(argc, argv);
    return 0;
  }

  std::vector<std::string> arguments;
  for (int index = 1; index < argc; ++index) {
    arguments.emplace_back(argv[index]);
  }

  CliCommand command;
  try {
    command = ParseCliCommand(arguments);
  } catch (const std::exception& error) {
    std::cerr << "Error: " << error.what() << '\n';
    std::cerr << BuildHelpForArgs(argc, argv);
    return 1;
  }

  try {
    std::vector<ResolvedMotorTarget> targets = ResolveMotorTargets(command.target);
    bool had_failure = false;
    for (ResolvedMotorTarget& target : targets) {
      try {
        EnsureMotorInitialized(target);
        if (command.canfd) {
          target.motor->EnableCanFd();
        }
        const std::string target_prefix = FormatTargetPrefix(target, command.target);
        if (command.operation == ConfigOperation::Read) {
          if (command.target.scope == TargetScope::SingleMotor) {
            PrintConfigValue(*target.motor, command.item);
          } else {
            std::cout << target_prefix << ' ' << GetConfigValue(*target.motor, command.item) << '\n';
          }
          continue;
        }

        if (!SetConfigValue(*target.motor, command)) {
          throw std::runtime_error("Failed to set config value");
        }

        if (command.target.scope == TargetScope::SingleMotor) {
          if (IsConfigReadbackItem(command.item)) {
            PrintConfigValue(*target.motor, command.item);
          } else {
            std::cout << "success\n";
          }
        } else if (IsConfigReadbackItem(command.item)) {
          std::cout << target_prefix << ' ' << GetConfigValue(*target.motor, command.item) << '\n';
        } else {
          std::cout << target_prefix << " success\n";
        }
      } catch (const std::exception& error) {
        had_failure = true;
        if (command.target.scope == TargetScope::SingleMotor) {
          throw;
        }
        std::cerr << FormatTargetPrefix(target, command.target) << " error: " << error.what() << '\n';
      }
    }
    return had_failure ? 1 : 0;
  } catch (const std::exception& error) {
    std::cerr << "Error: " << error.what() << '\n';
    return 1;
  }
}

int RunScan(int argc, char** argv) {
  if (ContainsHelpRequest(argc, argv)) {
    std::cout << BuildScanHelp();
    return 0;
  }

  std::vector<std::string> arguments;
  for (int index = 2; index < argc; ++index) {
    arguments.emplace_back(argv[index]);
  }

  try {
    const ScanCommand command = ParseScanCommand(arguments);
    const ScanTarget& target = command.target;
    if (target.adapter_id.empty()) {
      PrintAvailableInterfaces(target.adapter_type);
      return 0;
    }

    encos::BaseAdapterPtr adapter = OpenScanAdapter(target);

    if (target.bus_id.has_value()) {
      encos::Bus* bus = target.slave_id.has_value() ? adapter->GetBus(*target.slave_id, *target.bus_id)
                                                    : adapter->GetBus(*target.bus_id);
      const std::vector<ScanMotorRow> rows = ScanBusAndFormatRows(target.slave_id, *target.bus_id, bus);
      std::cout << FormatSortedScanTable(rows);
      return 0;
    }

    const std::unordered_map<int, encos::Bus*> buses = adapter->GetBuses();
    std::vector<std::future<std::vector<ScanMotorRow>>> scan_tasks;
    scan_tasks.reserve(buses.size());
    for (const auto& bus_pair : buses) {
      encos::Bus* bus = bus_pair.second;
      std::optional<int32_t> slave_id;
      int32_t bus_id = bus_pair.first;
      if (bus_pair.first > 0xFFFF) {
        slave_id = bus_pair.first >> 16;
        bus_id = bus_pair.first & 0xFFFF;
      }
      scan_tasks.push_back(std::async(std::launch::async,
                                      [slave_id, bus_id, bus] { return ScanBusAndFormatRows(slave_id, bus_id, bus); }));
    }

    std::vector<ScanMotorRow> rows;
    for (std::future<std::vector<ScanMotorRow>>& scan_task : scan_tasks) {
      std::vector<ScanMotorRow> task_rows = scan_task.get();
      rows.insert(rows.end(), task_rows.begin(), task_rows.end());
    }
    std::cout << FormatSortedScanTable(rows);
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "Error: " << error.what() << '\n';
    return 1;
  }
}

int RunControl(int argc, char** argv) {
  if (ContainsHelpRequest(argc, argv)) {
    std::cout << BuildHelpForArgs(argc, argv);
    return 0;
  }

  std::vector<std::string> arguments;
  for (int index = 1; index < argc; ++index) {
    arguments.emplace_back(argv[index]);
  }

  ControlCommand command;
  try {
    command = ParseControlCommand(arguments);
  } catch (const std::exception& error) {
    std::cerr << "Error: " << error.what() << '\n';
    std::cerr << BuildHelpForArgs(argc, argv);
    return 1;
  }

  try {
    std::vector<ResolvedMotorTarget> targets = ResolveMotorTargets(command.target);
    std::vector<float> kts;
    kts.reserve(targets.size());
    for (ResolvedMotorTarget& target : targets) {
      try {
        EnsureMotorInitialized(target);
        if (command.canfd) {
          target.motor->EnableCanFd();
        }
        kts.push_back(target.motor->GetParameter<encos::MotorParameter::Kt>());
      } catch (const std::exception& error) {
        if (command.target.scope == TargetScope::SingleMotor) {
          throw;
        }
        std::cerr << "Error: " << FormatTargetPrefix(target, command.target) << ": " << error.what() << '\n';
        return 1;
      }
    }

    g_stop_requested.store(false);
    SignalGuard sigint_guard(SIGINT);
    TerminalRawMode terminal_raw_mode;

    using namespace std::chrono_literals;
    auto last_print = std::chrono::steady_clock::now();
    std::size_t printed_feedback_rows = 0;
    while (!g_stop_requested.load()) {
      if (QuitKeyPressed()) {
        break;
      }

      std::vector<encos::MotorFeedbackMsg1> feedbacks;
      feedbacks.reserve(targets.size());
      for (const ResolvedMotorTarget& target : targets) {
        try {
          feedbacks.push_back(SendControlCommand(*target.motor, command));
        } catch (const std::exception& error) {
          if (command.target.scope == TargetScope::SingleMotor) {
            throw;
          }
          std::cerr << "Error: " << FormatTargetPrefix(target, command.target) << ": " << error.what() << '\n';
          return 1;
        }
      }
      const auto now = std::chrono::steady_clock::now();
      if (now - last_print >= 500ms) {
        if (printed_feedback_rows % 10U == 0U) {
          std::cout << (command.target.scope == TargetScope::SingleMotor ? FormatControlHeader()
                                                                         : FormatBatchControlHeader())
                    << '\n';
        }
        if (command.target.scope == TargetScope::SingleMotor) {
          PrintControlFeedback(feedbacks.front(), kts.front());
          ++printed_feedback_rows;
        } else {
          for (std::size_t index = 0; index < targets.size(); ++index) {
            std::cout << FormatBatchControlRow(targets[index], feedbacks[index], kts[index]) << '\n';
            ++printed_feedback_rows;
          }
        }
        last_print = now;
      }

      std::this_thread::sleep_for(100ms);
    }

    return 0;
  } catch (const std::exception& error) {
    std::cerr << "Error: " << error.what() << '\n';
    return 1;
  }
}

int RunTui(const std::vector<std::string>& adapter_args) {
  AppState app_state;
  const std::vector<AdapterSpec> adapter_specs = ResolveAdapterSpecs(adapter_args);
  PreloadAdapters(adapter_specs, app_state);

  ControlRuntime control_runtime(app_state);
  GraphRuntime graph_runtime(app_state);
  control_runtime.Start();

  auto screen = ftxui::ScreenInteractive::Fullscreen();
  app_state.dialog_state.exit_callback = screen.ExitLoopClosure();

  int left_panel_width = 30;
  ftxui::Component middle_panel = CreateMiddlePanel(app_state, control_runtime, graph_runtime);
  ftxui::Component left_panel = CreateLeftPanel(app_state);
  ftxui::Component dialog = CreateAddAdapterDialog(app_state);
  ftxui::Component motor_scan_dialog = CreateMotorScanDialog(app_state);

  ftxui::Component layout = ftxui::ResizableSplitLeft(left_panel, middle_panel, &left_panel_width);
  ftxui::Component tab_container = ftxui::Container::Tab({layout, dialog}, &app_state.dialog_state.current_page);

  const auto should_show_motor_scan_dialog = [&app_state] {
    if (!app_state.adapter_state.global_scan_dialog_visible.load()) {
      return false;
    }
    const bool visible = ShouldShowMotorScanDialog(app_state.adapter_state.global_scan_active.load(),
                                                   app_state.adapter_state.global_scan_dialog_has_rendered.load());
    if (!visible) {
      app_state.adapter_state.global_scan_dialog_visible.store(false);
    }
    return visible;
  };

  ftxui::Component renderer = ftxui::Renderer(tab_container, [&] {
    ftxui::Element main_view = tab_container->Render() | ftxui::border;
    if (app_state.dialog_state.current_page == 1) {
      main_view = ftxui::dbox(
          {main_view | ftxui::dim, tab_container->ChildAt(1)->Render() | ftxui::clear_under | ftxui::center});
    } else if (should_show_motor_scan_dialog()) {
      main_view =
          ftxui::dbox({main_view | ftxui::dim, motor_scan_dialog->Render() | ftxui::clear_under | ftxui::center});
    }
    return main_view;
  });

  renderer = ftxui::CatchEvent(renderer, [&should_show_motor_scan_dialog](ftxui::Event event) {
    return should_show_motor_scan_dialog() && event != ftxui::Event::Custom;
  });

  std::atomic<bool> refresh_running{true};
  std::thread refresh_thread([&] {
    using namespace std::chrono_literals;
    while (refresh_running.load()) {
      std::this_thread::sleep_for(50ms);
      screen.PostEvent(ftxui::Event::Custom);
    }
  });

  screen.Loop(renderer);

  refresh_running.store(false);
  refresh_thread.join();
  graph_runtime.Stop();
  control_runtime.Stop();
  return 0;
}

int Run(int argc, char** argv) {
  const auto driver_version = GetLoadedEncosDriverVersion();
  const bool driver_version_supported = IsSupportedEncosDriverVersion(driver_version);

  if (argc == 2 && (std::string(argv[1]) == "-v" || std::string(argv[1]) == "--version")) {
    std::cout << "emcli " << EMCLI_VERSION << '\n';
    std::cout << "libencosdriver " << driver_version.value_or("<3.1.0") << '\n';
    if (!driver_version_supported) {
      std::cout << "Required driver version: " << GetSupportedEncosDriverVersionRequirement() << '\n';
      return 1;
    }
    return 0;
  }

  if (!driver_version_supported) {
    std::cerr << "Error: unsupported libencosdriver " << *driver_version
              << ". Required driver version: " << GetSupportedEncosDriverVersionRequirement() << '\n';
    return 1;
  }

  if (argc == 1) {
    return RunTui({});
  }

  argparse::ArgumentParser program("emcli");
  argparse::ArgumentParser tui_command("tui");
  argparse::ArgumentParser scan_command("scan");
  argparse::ArgumentParser config_command("config");
  argparse::ArgumentParser control_command("control");
  argparse::ArgumentParser imu_command("imu");
  argparse::ArgumentParser battery_command("battery");
  argparse::ArgumentParser pms_command("pms");
  argparse::ArgumentParser glove_command("glove");
  argparse::ArgumentParser bench_command("bench");
  argparse::ArgumentParser stress_command("stress");
  argparse::ArgumentParser play_command("play");
  argparse::ArgumentParser zero_command("zero");

  tui_command.add_argument("adapters").help("Adapter preload list: AdapterType:AdapterId").remaining();
  scan_command.add_argument("args").help("Scan command: <AdapterType[:AdapterId[:BusId]]>").remaining();
  config_command.add_argument("args").help("Config command: <target> <item> [set <values>]").remaining();
  control_command.add_argument("args").help("Control command: <mode> <target> <values>").remaining();
  imu_command.add_argument("args").help("IMU command: show <target>").remaining();
  battery_command.add_argument("args").help("Battery command: <show|clear> <target>").remaining();
  pms_command.add_argument("args").help("PMS command: <show|enable|disable> <target> [V48_1 ...]").remaining();
  glove_command.add_argument("args")
      .help(
          "Glove command: show <target> | calibrate <target> all | calibrate <target> <finger_idx> <encoder_idx> | "
          "calibrate <target> <finger_idx> mask <encoder_mask>")
      .remaining();
  program.add_subparser(tui_command);
  program.add_subparser(scan_command);
  program.add_subparser(config_command);
  program.add_subparser(control_command);
  program.add_subparser(imu_command);
  program.add_subparser(battery_command);
  program.add_subparser(pms_command);
  program.add_subparser(glove_command);
  program.add_subparser(bench_command);
  program.add_subparser(stress_command);
  program.add_subparser(play_command);
  program.add_subparser(zero_command);

  ConfigureBenchCommand(bench_command);
  ConfigureStressCommand(stress_command);
  ConfigurePlayCommand(play_command);
  ConfigureZeroCommand(zero_command);

  if (argc == 2 && (std::string(argv[1]) == "-h" || std::string(argv[1]) == "--help")) {
    std::cout << BuildTopLevelHelp();
    return 0;
  }

  if (argc >= 3 && ContainsHelpRequest(argc, argv)) {
    std::cout << BuildHelpForArgs(argc, argv);
    return 0;
  }

  try {
    program.parse_args(argc, argv);
  } catch (const std::runtime_error& error) {
    if (ContainsHelpRequest(argc, argv)) {
      if (argc >= 2) {
        const std::string command = argv[1];
        if (command == "bench") {
          std::cout << bench_command;
          return 0;
        }
        if (command == "stress") {
          std::cout << stress_command;
          return 0;
        }
        if (command == "zero") {
          std::cout << BuildZeroHelp();
          return 0;
        }
        if (command == "play") {
          std::cout << BuildPlayHelp();
          return 0;
        }
        std::cout << BuildHelpForArgs(argc, argv);
      } else {
        std::cout << BuildTopLevelHelp();
      }
      return 0;
    }
    std::cerr << "Error: " << error.what() << '\n';
    if (argc >= 2) {
      const std::string command = argv[1];
      if (command == "bench") {
        std::cerr << bench_command;
        return 1;
      }
      if (command == "stress") {
        std::cerr << stress_command;
        return 1;
      }
      if (command == "zero") {
        std::cerr << BuildZeroHelp();
        return 1;
      }
      if (command == "play") {
        std::cerr << BuildPlayHelp();
        return 1;
      }
      std::cerr << BuildHelpForArgs(argc, argv);
    } else {
      std::cerr << BuildTopLevelHelp();
    }
    return 1;
  }

  if (program.is_subcommand_used(tui_command)) {
    const std::vector<std::string> adapter_args = tui_command.get<std::vector<std::string>>("adapters");
    return RunTui(adapter_args);
  }

  if (program.is_subcommand_used(scan_command)) {
    return RunScan(argc, argv);
  }

  if (program.is_subcommand_used(config_command)) {
    return RunCli(argc, argv);
  }

  if (program.is_subcommand_used(control_command)) {
    return RunControl(argc, argv);
  }

  if (program.is_subcommand_used(imu_command)) {
    return RunImuCommand(argc, argv);
  }

  if (program.is_subcommand_used(battery_command)) {
    return RunBatteryCommand(argc, argv);
  }

  if (program.is_subcommand_used(pms_command)) {
    return RunPmsCommand(argc, argv);
  }

  if (program.is_subcommand_used(glove_command)) {
    return RunGloveCommand(argc, argv);
  }

  if (program.is_subcommand_used(bench_command)) {
    if (const auto plugin_path = bench_command.present<std::string>("--plugin-path")) {
      encos::SetPluginPath(fs::absolute(*plugin_path).string());
    }
    return RunBenchCommand(bench_command);
  }

  if (program.is_subcommand_used(stress_command)) {
    if (const auto plugin_path = stress_command.present<std::string>("--plugin-path")) {
      encos::SetPluginPath(fs::absolute(*plugin_path).string());
    }
    return RunStressCommand(stress_command);
  }

  if (program.is_subcommand_used(play_command)) {
    return RunPlayCommand(play_command);
  }

  if (program.is_subcommand_used(zero_command)) {
    return RunZeroCommand(zero_command);
  }

  std::cerr << "Error: command required\n";
  std::cerr << BuildTopLevelHelp();
  return 1;
}

}  // namespace
}  // namespace motor_cli

int main(int argc, char** argv) {
  try {
    return motor_cli::Run(argc, argv);
  } catch (const std::exception& error) {
    std::cout << "\033[2J\033[H";
    std::cout << "\n=================================\n";
    std::cout << "  Program terminated with error  \n";
    std::cout << "=================================\n\n";
    std::cout << "Error: " << error.what() << "\n\n";
    return 1;
  } catch (...) {
    std::cout << "\033[2J\033[H";
    std::cout << "\n=================================\n";
    std::cout << "  Program terminated with error  \n";
    std::cout << "=================================\n\n";
    std::cout << "Error: Unknown exception occurred\n\n";
    return 1;
  }
}
