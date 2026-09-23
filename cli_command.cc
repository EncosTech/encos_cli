// SPDX-License-Identifier: MIT

#include "cli_command.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <iomanip>
#include <limits>
#include <map>
#include <sstream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include "components/math_constants.h"
#include "src/cli/slave_config.h"

namespace motor_cli {
namespace {

std::vector<std::string> SplitColonSeparated(const std::string& value) {
  std::vector<std::string> parts;
  std::string current;
  bool in_quote = false;
  for (const char c : value) {
    if (c == '@') {
      in_quote = !in_quote;
      current.push_back(c);
    } else if (c == ':' && !in_quote) {
      parts.push_back(current);
      current.clear();
    } else {
      current.push_back(c);
    }
  }
  parts.push_back(current);

  if (in_quote) {
    throw std::runtime_error("Invalid target '" + value + "', unbalanced '@'");
  }

  for (std::string& part : parts) {
    if (part.size() >= 2U && part.front() == '@' && part.back() == '@') {
      part = part.substr(1, part.size() - 2U);
    }
  }
  return parts;
}

int64_t ParseInteger(const std::string& value, const std::string& field_name) {
  if (value.empty()) {
    throw std::runtime_error(field_name + " must not be empty");
  }
  if (value.front() == '-') {
    throw std::runtime_error(field_name + " must be non-negative: '" + value + "'");
  }

  int base = 10;
  std::size_t parse_start = 0;
  if (value.size() > 2U && value[0] == '0' && (value[1] == 'x' || value[1] == 'X')) {
    base = 16;
    parse_start = 2;
  } else if (value.size() > 2U && value[0] == '0' && (value[1] == 'b' || value[1] == 'B')) {
    base = 2;
    parse_start = 2;
  }

  if (parse_start >= value.size()) {
    throw std::runtime_error(field_name + " has no digits: '" + value + "'");
  }

  try {
    std::size_t parsed_chars = 0;
    const int64_t parsed = std::stoll(value.substr(parse_start), &parsed_chars, base);
    if (parsed_chars != value.size() - parse_start) {
      throw std::runtime_error(field_name + " contains invalid characters: '" + value + "'");
    }
    return parsed;
  } catch (const std::invalid_argument&) {
    throw std::runtime_error(field_name + " is not a valid integer: '" + value + "'");
  } catch (const std::out_of_range&) {
    throw std::runtime_error(field_name + " is out of range: '" + value + "'");
  }
}

int32_t ParseInt32(const std::string& value, const std::string& field_name) {
  const int64_t parsed = ParseInteger(value, field_name);
  if (parsed > std::numeric_limits<int32_t>::max()) {
    throw std::runtime_error(field_name + " is out of range: '" + value + "'");
  }
  return static_cast<int32_t>(parsed);
}

float ParseControlFloat(const std::string& value, const std::string& field_name) {
  try {
    std::size_t parsed_chars = 0;
    const float parsed = std::stof(value, &parsed_chars);
    if (parsed_chars != value.size() || !std::isfinite(parsed)) {
      throw std::runtime_error(field_name + " contains invalid characters: '" + value + "'");
    }
    return parsed;
  } catch (const std::invalid_argument&) {
    throw std::runtime_error(field_name + " is not a valid float: '" + value + "'");
  } catch (const std::out_of_range&) {
    throw std::runtime_error(field_name + " is out of range: '" + value + "'");
  }
}

struct ConfigSpec {
  ConfigItem item;
  std::size_t value_count;
};

struct FlagParseResult {
  std::vector<std::string> arguments;
  bool canfd{false};
};

const std::map<std::string, ConfigSpec>& ConfigSpecs() {
  static const std::map<std::string, ConfigSpec> specs{
      {"id", {ConfigItem::Id, 1U}},
      {"position", {ConfigItem::Position, 1U}},
      {"calibrate", {ConfigItem::Calibrate, 4U}},
      {"kt", {ConfigItem::Kt, 1U}},
      {"pvt-kp-range", {ConfigItem::PvtKpRange, 2U}},
      {"pvt-kd-range", {ConfigItem::PvtKdRange, 2U}},
      {"pvt-pos-range", {ConfigItem::PvtPositionRange, 2U}},
      {"pvt-spd-range", {ConfigItem::PvtSpeedRange, 2U}},
      {"pvt-tor-range", {ConfigItem::PvtTorqueRange, 2U}},
      {"pvt-cur-range", {ConfigItem::PvtCurrentRange, 2U}},
      {"cur-pi", {ConfigItem::CurrentPi, 2U}},
      {"spd-pi", {ConfigItem::SpeedPi, 2U}},
      {"pos-pd", {ConfigItem::PositionPd, 2U}},
      {"can-timeout", {ConfigItem::CanTimeout, 1U}},
      {"comm", {ConfigItem::CommunicationMode, 1U}},
  };
  return specs;
}

FlagParseResult ExtractCanFdFlag(const std::vector<std::string>& arguments, const std::string& command_name) {
  FlagParseResult result;
  result.arguments.reserve(arguments.size());
  for (const std::string& argument : arguments) {
    if (argument == "--canfd") {
      if (result.canfd) {
        throw std::runtime_error("Duplicate " + command_name + " flag: '--canfd'");
      }
      result.canfd = true;
      continue;
    }
    result.arguments.push_back(argument);
  }
  return result;
}

}  // namespace

bool LooksLikeMotorTarget(const std::string& value) {
  const std::size_t colon_count = static_cast<std::size_t>(std::count(value.begin(), value.end(), ':'));
  return colon_count >= 2U && colon_count <= 4U;
}

uint16_t ParseUint16(const std::string& value, const std::string& field_name) {
  const int64_t parsed = ParseInteger(value, field_name);
  if (parsed > std::numeric_limits<uint16_t>::max()) {
    throw std::runtime_error(field_name + " is out of range: '" + value + "'");
  }
  return static_cast<uint16_t>(parsed);
}

MotorTarget ParseMotorTarget(const std::string& value) {
  const std::vector<std::string> parts = SplitColonSeparated(value);
  if (parts.size() != 3U && parts.size() != 4U && parts.size() != 5U) {
    throw std::runtime_error("Invalid target '" + value +
                             "', expected AdapterType:AdapterId:ALL, AdapterType:AdapterId:BusId:ALL, "
                             "AdapterType:AdapterId:BusId:MotorId, AdapterType:AdapterId:SlaveId:BusId:ALL, or "
                             "AdapterType:AdapterId:SlaveId:BusId:MotorId");
  }

  for (const std::string& part : parts) {
    if (part.empty()) {
      throw std::runtime_error("Invalid target '" + value + "', target parts must not be empty");
    }
  }

  MotorTarget target;
  target.adapter_type = parts[0];
  target.adapter_id = parts[1];
  if (parts.size() == 3U) {
    if (parts[2] != "ALL") {
      throw std::runtime_error("Invalid target '" + value + "', expected AdapterType:AdapterId:ALL");
    }
    target.scope = TargetScope::AdapterAllMotors;
    return target;
  }

  if (parts.size() == 4U) {
    target.bus_id = ParseInt32(parts[2], "BusId");
    if (parts[3] == "ALL") {
      target.scope = TargetScope::BusAllMotors;
      return target;
    }
    target.scope = TargetScope::SingleMotor;
    target.motor_id = ParseUint16(parts[3], "MotorId");
    return target;
  }

  target.slave_id = ParseInt32(parts[2], "SlaveId");
  target.bus_id = ParseInt32(parts[3], "BusId");
  if (parts[4] == "ALL") {
    target.scope = TargetScope::SlaveBusAllMotors;
    return target;
  }
  target.scope = TargetScope::SingleMotor;
  target.motor_id = ParseUint16(parts[4], "MotorId");
  return target;
}

ScanTarget ParseScanTarget(const std::string& value) {
  const std::vector<std::string> parts = SplitColonSeparated(value);
  if (parts.size() != 1U && parts.size() != 2U && parts.size() != 3U && parts.size() != 4U) {
    throw std::runtime_error("Invalid scan target '" + value +
                             "', expected AdapterType, AdapterType:AdapterId, AdapterType:AdapterId:BusId, or "
                             "AdapterType:AdapterId:SlaveId:BusId");
  }

  for (const std::string& part : parts) {
    if (part.empty()) {
      throw std::runtime_error("Invalid scan target '" + value + "', target parts must not be empty");
    }
  }

  ScanTarget target;
  target.adapter_type = parts[0];
  if (parts.size() == 1U) {
    return target;
  }

  target.adapter_id = parts[1];
  if (parts.size() == 3U) {
    target.bus_id = ParseInt32(parts[2], "BusId");
  } else if (parts.size() == 4U) {
    target.slave_id = ParseInt32(parts[2], "SlaveId");
    target.bus_id = ParseInt32(parts[3], "BusId");
  }
  return target;
}

ScanCommand ParseScanCommand(const std::vector<std::string>& arguments) {
  if (arguments.empty()) {
    throw std::runtime_error("Scan expects exactly one target");
  }

  ScanCommand command;
  std::optional<std::string> target_value;
  for (const std::string& argument : arguments) {
    if (!argument.empty() && argument.front() == '-') {
      throw std::runtime_error("Unknown scan flag: '" + argument + "'");
    }
    if (target_value.has_value()) {
      throw std::runtime_error("Scan expects exactly one target");
    }
    target_value = argument;
  }

  if (!target_value.has_value()) {
    throw std::runtime_error("Scan expects exactly one target");
  }
  command.target = ParseScanTarget(*target_value);
  return command;
}

SensorTarget ParseSensorTarget(const std::string& value) {
  const MotorTarget target = ParseMotorTarget(value);
  if (target.scope != TargetScope::SingleMotor || !target.bus_id.has_value() || !target.motor_id.has_value()) {
    throw std::runtime_error("Invalid sensor target '" + value +
                             "', expected AdapterType:AdapterId:BusId:Idx or "
                             "AdapterType:AdapterId:SlaveId:BusId:Idx");
  }

  SensorTarget sensor_target;
  sensor_target.adapter_type = target.adapter_type;
  sensor_target.adapter_id = target.adapter_id;
  sensor_target.slave_id = target.slave_id;
  sensor_target.bus_id = *target.bus_id;
  sensor_target.device_idx = *target.motor_id;
  return sensor_target;
}

SensorCommand ParseImuCommand(const std::vector<std::string>& arguments) {
  if (arguments.size() != 3U || arguments[0] != "imu") {
    throw std::runtime_error("Invalid imu command, expected: imu show <target>");
  }
  if (arguments[1] != "show") {
    throw std::runtime_error("Unsupported imu action: '" + arguments[1] + "'");
  }

  SensorCommand command;
  command.action = SensorCommandAction::Show;
  command.target = ParseSensorTarget(arguments[2]);
  return command;
}

SensorCommand ParseBatteryCommand(const std::vector<std::string>& arguments) {
  if (arguments.size() != 3U || arguments[0] != "battery") {
    throw std::runtime_error("Invalid battery command, expected: battery <show|clear> <target>");
  }

  SensorCommand command;
  if (arguments[1] == "show") {
    command.action = SensorCommandAction::Show;
  } else if (arguments[1] == "clear") {
    command.action = SensorCommandAction::Clear;
  } else {
    throw std::runtime_error("Unsupported battery action: '" + arguments[1] + "'");
  }
  command.target = ParseSensorTarget(arguments[2]);
  return command;
}

PmsTarget ParsePmsTarget(const std::string& value) {
  const ScanTarget target = ParseScanTarget(value);
  if (!target.bus_id.has_value()) {
    throw std::runtime_error("Invalid PMS target '" + value +
                             "', expected AdapterType:AdapterId:BusId or "
                             "AdapterType:AdapterId:SlaveId:BusId");
  }

  PmsTarget pms_target;
  pms_target.adapter_type = target.adapter_type;
  pms_target.adapter_id = target.adapter_id;
  pms_target.slave_id = target.slave_id;
  pms_target.bus_id = *target.bus_id;
  return pms_target;
}

PmsChannel ParsePmsChannel(const std::string& value) {
  static const std::map<std::string, PmsChannel> channels{
      {"V48_1", PmsChannel::V48_1}, {"V48_2", PmsChannel::V48_2}, {"V48_3", PmsChannel::V48_3},
      {"V48_4", PmsChannel::V48_4}, {"V48_5", PmsChannel::V48_5}, {"V48_6", PmsChannel::V48_6},
  };
  const auto channel = channels.find(value);
  if (channel == channels.end()) {
    throw std::runtime_error("Unsupported PMS control channel: '" + value + "', expected V48_1 through V48_6");
  }
  return channel->second;
}

PmsCommand ParsePmsCommand(const std::vector<std::string>& arguments) {
  if (arguments.size() < 3U || arguments[0] != "pms") {
    throw std::runtime_error("Invalid PMS command, expected: pms <show|enable|disable> <target> [V48_1 ...]");
  }

  PmsCommand command;
  command.target = ParsePmsTarget(arguments[2]);
  if (arguments[1] == "show") {
    if (arguments.size() != 3U) {
      throw std::runtime_error("PMS show expects exactly one target");
    }
    command.action = PmsCommandAction::Show;
    return command;
  }
  if (arguments[1] == "enable") {
    command.action = PmsCommandAction::Enable;
  } else if (arguments[1] == "disable") {
    command.action = PmsCommandAction::Disable;
  } else {
    throw std::runtime_error("Unsupported PMS action: '" + arguments[1] + "'");
  }

  if (arguments.size() < 4U) {
    throw std::runtime_error("PMS enable/disable expects at least one V48 channel");
  }
  for (std::size_t index = 3; index < arguments.size(); ++index) {
    const PmsChannel channel = ParsePmsChannel(arguments[index]);
    if (std::find(command.channels.begin(), command.channels.end(), channel) != command.channels.end()) {
      throw std::runtime_error("Duplicate PMS control channel: '" + arguments[index] + "'");
    }
    command.channels.push_back(channel);
  }
  return command;
}

GloveTarget ParseGloveTarget(const std::string& value) {
  const std::vector<std::string> parts = SplitColonSeparated(value);
  if (parts.size() != 3U) {
    throw std::runtime_error("Invalid glove target '" + value + "', expected AdapterType:AdapterId:SlaveId");
  }

  for (const std::string& part : parts) {
    if (part.empty()) {
      throw std::runtime_error("Invalid glove target '" + value + "', target parts must not be empty");
    }
  }

  GloveTarget target;
  target.adapter_type = parts[0];
  target.adapter_id = parts[1];
  target.slave_id = ParseInt32(parts[2], "SlaveId");
  return target;
}

namespace {

constexpr int64_t kGloveFingerCount = 5;
constexpr int64_t kGloveEncodersPerFinger = 10;
constexpr uint16_t kGloveMaxEncoderMask = 0x3FF;

uint8_t ParseGloveFingerIdx(const std::string& value) {
  const int64_t parsed = ParseInteger(value, "finger_idx");
  if (parsed >= kGloveFingerCount) {
    throw std::runtime_error("finger_idx is out of range: '" + value + "', expected 0-4");
  }
  return static_cast<uint8_t>(parsed);
}

uint8_t ParseGloveEncoderIdx(const std::string& value) {
  const int64_t parsed = ParseInteger(value, "encoder_idx");
  if (parsed >= kGloveEncodersPerFinger) {
    throw std::runtime_error("encoder_idx is out of range: '" + value + "', expected 0-9");
  }
  return static_cast<uint8_t>(parsed);
}

uint16_t ParseGloveEncoderMask(const std::string& value) {
  const uint16_t mask = ParseUint16(value, "encoder_mask");
  if (mask == 0U) {
    throw std::runtime_error("encoder_mask must not be zero");
  }
  if (mask > kGloveMaxEncoderMask) {
    throw std::runtime_error("encoder_mask is out of range: '" + value + "', only the low 10 bits are valid");
  }
  return mask;
}

}  // namespace

GloveCommand ParseGloveCommand(const std::vector<std::string>& arguments) {
  if (arguments.size() < 3U || arguments[0] != "glove") {
    throw std::runtime_error("Invalid glove command, expected: glove <show|calibrate> <target> [args]");
  }

  GloveCommand command;
  command.target = ParseGloveTarget(arguments[2]);
  if (arguments[1] == "show") {
    if (arguments.size() != 3U) {
      throw std::runtime_error("glove show expects exactly one target");
    }
    command.action = GloveCommandAction::Show;
    return command;
  }
  if (arguments[1] != "calibrate") {
    throw std::runtime_error("Unsupported glove action: '" + arguments[1] + "'");
  }
  if (arguments.size() < 4U) {
    throw std::runtime_error(
        "glove calibrate expects 'all', '<finger_idx> <encoder_idx>', or '<finger_idx> mask <encoder_mask>'");
  }

  command.action = GloveCommandAction::Calibrate;
  if (arguments[3] == "all") {
    if (arguments.size() != 4U) {
      throw std::runtime_error("glove calibrate all does not take extra arguments");
    }
    command.calibration_mode = GloveCalibrationMode::All;
    return command;
  }

  command.finger_idx = ParseGloveFingerIdx(arguments[3]);
  if (arguments.size() == 5U) {
    command.encoder_idx = ParseGloveEncoderIdx(arguments[4]);
    command.calibration_mode = GloveCalibrationMode::Single;
    return command;
  }
  if (arguments.size() == 6U && arguments[4] == "mask") {
    command.encoder_mask = ParseGloveEncoderMask(arguments[5]);
    command.calibration_mode = GloveCalibrationMode::Mask;
    return command;
  }

  throw std::runtime_error(
      "Invalid glove calibrate syntax, expected: glove calibrate <target> all | <finger_idx> <encoder_idx> | "
      "<finger_idx> mask <encoder_mask>");
}

CliCommand ParseCliCommand(const std::vector<std::string>& arguments) {
  const FlagParseResult flag_parse = ExtractCanFdFlag(arguments, "config");
  const std::vector<std::string>& parsed_arguments = flag_parse.arguments;
  if (parsed_arguments.size() < 3U) {
    throw std::runtime_error("Invalid CLI command, expected: config <target> <item> [set <values>]");
  }
  if (parsed_arguments[0] != "config") {
    throw std::runtime_error("Invalid CLI command, expected 'config'");
  }

  const auto spec_it = ConfigSpecs().find(parsed_arguments[2]);
  if (spec_it == ConfigSpecs().end()) {
    throw std::runtime_error("Unknown config item: '" + parsed_arguments[2] + "'");
  }

  CliCommand command;
  command.canfd = flag_parse.canfd;
  command.target = ParseMotorTarget(parsed_arguments[1]);
  command.item = spec_it->second.item;

  if (command.item == ConfigItem::CommunicationMode) {
    if (parsed_arguments.size() != 5U || parsed_arguments[3] != "set") {
      throw std::runtime_error("Config item 'comm' expects: comm set <can|canfd|canopen>");
    }
    if (parsed_arguments[4] != "can" && parsed_arguments[4] != "canfd" && parsed_arguments[4] != "canopen") {
      throw std::runtime_error("Unknown communication mode: '" + parsed_arguments[4] + "'");
    }
    command.operation = ConfigOperation::Set;
    command.values.push_back(parsed_arguments[4]);
    return command;
  }

  if (parsed_arguments.size() == 3U) {
    if (command.item == ConfigItem::Id) {
      throw std::runtime_error("Config item 'id' requires set; the current id is already in target");
    }
    if (command.item == ConfigItem::Calibrate) {
      throw std::runtime_error("Config item '" + parsed_arguments[2] + "' requires set values");
    }
    command.operation = ConfigOperation::Read;
    return command;
  }

  if (command.item == ConfigItem::Position) {
    if (parsed_arguments.size() == 4U && parsed_arguments[3] == "reset") {
      command.operation = ConfigOperation::Set;
      return command;
    }
    if (parsed_arguments.size() != 5U || parsed_arguments[3] != "set") {
      throw std::runtime_error("Config item 'position' expects: position set <position_deg> or position reset");
    }
    command.operation = ConfigOperation::Set;
    command.values.push_back(parsed_arguments[4]);
    return command;
  }

  if (parsed_arguments[3] != "set") {
    throw std::runtime_error("Invalid config operation: '" + parsed_arguments[3] + "'");
  }

  if (command.item == ConfigItem::Id && command.target.scope != TargetScope::SingleMotor) {
    throw std::runtime_error("Config item 'id' does not support ALL targets");
  }

  command.operation = ConfigOperation::Set;
  command.values.assign(parsed_arguments.begin() + 4, parsed_arguments.end());
  if (command.values.size() != spec_it->second.value_count) {
    throw std::runtime_error("Config item '" + parsed_arguments[2] + "' expects " +
                             std::to_string(spec_it->second.value_count) + " value(s)");
  }
  return command;
}

ControlCommand ParseControlCommand(const std::vector<std::string>& arguments) {
  const FlagParseResult flag_parse = ExtractCanFdFlag(arguments, "control");
  const std::vector<std::string>& parsed_arguments = flag_parse.arguments;
  if (parsed_arguments.size() < 3U) {
    throw std::runtime_error("Invalid control command, expected: control <mode> <target> <values>");
  }
  if (parsed_arguments[0] != "control") {
    throw std::runtime_error("Invalid control command, expected 'control'");
  }

  ControlCommand command;
  command.canfd = flag_parse.canfd;
  const std::string& mode = parsed_arguments[1];
  command.target = ParseMotorTarget(parsed_arguments[2]);

  auto parse_values = [&](std::size_t expected_count) {
    const std::size_t actual_count = parsed_arguments.size() - 3U;
    if (actual_count != expected_count) {
      throw std::runtime_error("Control mode '" + mode + "' expects " + std::to_string(expected_count) + " value(s)");
    }
    command.values.reserve(expected_count);
    for (std::size_t index = 0; index < expected_count; ++index) {
      command.values.push_back(ParseControlFloat(parsed_arguments[3U + index], "Value"));
    }
  };

  if (mode == "pvt") {
    command.item = ControlItem::Pvt;
    parse_values(5U);
    command.values[2] *= kDegreesToRadians;
    return command;
  }
  if (mode == "position") {
    command.item = ControlItem::Position;
    parse_values(3U);
    command.values[0] *= kDegreesToRadians;
    return command;
  }
  if (mode == "speed") {
    command.item = ControlItem::Speed;
    parse_values(2U);
    return command;
  }
  if (mode == "current") {
    command.item = ControlItem::Current;
    parse_values(1U);
    return command;
  }
  if (mode == "torque") {
    command.item = ControlItem::Torque;
    parse_values(1U);
    return command;
  }
  if (mode == "brake") {
    if (parsed_arguments.size() != 4U || (parsed_arguments[3] != "engage" && parsed_arguments[3] != "release")) {
      throw std::runtime_error("Mechanical brake expects engage or release; use 'control stop' for electronic braking");
    }
    command.item = ControlItem::Brake;
    command.brake_enabled = parsed_arguments[3] == "engage";
    return command;
  }
  if (mode == "stop") {
    if (parsed_arguments.size() < 4U) {
      throw std::runtime_error("Control mode 'stop' expects stop mode");
    }
    command.item = ControlItem::Stop;
    const std::string& stop_mode = parsed_arguments[3];
    if (stop_mode == "full") {
      command.stop_mode = StopMode::Full;
      if (parsed_arguments.size() != 4U) {
        throw std::runtime_error("Control mode 'stop full' does not accept current");
      }
      return command;
    }
    if (stop_mode == "dynamic") {
      command.stop_mode = StopMode::Dynamic;
    } else if (stop_mode == "regenerative") {
      command.stop_mode = StopMode::Regenerative;
    } else {
      throw std::runtime_error("Unknown stop mode: '" + stop_mode + "'");
    }
    if (parsed_arguments.size() != 5U) {
      throw std::runtime_error("Control mode 'stop " + stop_mode + "' expects max_current_a");
    }
    command.values.push_back(ParseControlFloat(parsed_arguments[4], "Current"));
    return command;
  }

  throw std::runtime_error("Unknown control mode: '" + mode + "'");
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
         << "  imu                        Show IMU status from a bus device\n"
         << "  battery                    Show or clear battery status from a bus device\n"
         << "  pms                        Show or control the power management system\n"
         << "  glove                      Show or calibrate glove encoders\n"
         << "  play                       Play motors from a trajectory CSV\n"
         << "  zero                       Zero motors from a CSV calibration config\n"
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
  return output.str();
}

std::string BuildConfigHelp() {
  std::ostringstream output;
  output << SlaveConfigHelp() << "\n";
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
         << "  pos-pd, can-timeout\n"
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
         << "  emcli config Ethercat:eth0:3:0:1 calibrate set -90 90 1 2\n";
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
  if (item == "id") {
    output << "  emcli config [--canfd] <target> id set <new_id>\n";
  } else if (item == "position") {
    output << "  emcli config [--canfd] <target> position\n"
           << "  emcli config [--canfd] <target> position set <position_deg>\n"
           << "  emcli config [--canfd] <target> position reset\n";
  } else if (item == "calibrate") {
    output << "  emcli config [--canfd] <target> calibrate set <min_deg> <max_deg> <speed_rad_s> <current_a>\n";
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
         << "\n"
         << "Target:\n"
         << "  AdapterType:AdapterId:BusId:ImuIdx\n"
         << "  AdapterType:AdapterId:SlaveId:BusId:ImuIdx\n"
         << "\n"
         << "Output:\n"
         << "  Refresh IMU status in place at 50 Hz.\n"
         << "  Fixed rows: accel, gyro, euler.\n"
         << "  Missing groups leave value columns blank.\n"
         << "\n"
         << "Examples:\n"
         << "  emcli imu show Ethercat:eth0:0:0\n"
         << "  emcli imu show Ethercat:eth0:3:0:1\n";
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
  return output.str();
}

std::string FormatScanHeader() { return "slave\tbus\tid\teff\tcanfd"; }

std::string FormatScanMotorRow(std::optional<int32_t> slave_id, int32_t bus_id, int motor_id, bool eff, bool canfd) {
  std::ostringstream output;
  if (slave_id.has_value()) {
    output << *slave_id;
  }
  output << '\t' << bus_id << '\t' << motor_id << '\t' << (eff ? 1 : 0) << '\t' << (canfd ? 1 : 0);
  return output.str();
}

std::string FormatScanTable(const std::vector<std::string>& rows) {
  std::ostringstream output;
  output << FormatScanHeader() << '\n';
  for (const std::string& row : rows) {
    output << row << '\n';
  }
  return output.str();
}

std::string FormatSortedScanTable(std::vector<ScanMotorRow> rows) {
  std::sort(rows.begin(), rows.end(), [](const ScanMotorRow& lhs, const ScanMotorRow& rhs) {
    if (lhs.slave_id.value_or(-1) != rhs.slave_id.value_or(-1)) {
      return lhs.slave_id.value_or(-1) < rhs.slave_id.value_or(-1);
    }
    if (lhs.bus_id != rhs.bus_id) {
      return lhs.bus_id < rhs.bus_id;
    }
    return lhs.motor_id < rhs.motor_id;
  });

  std::vector<std::string> formatted_rows;
  formatted_rows.reserve(rows.size());
  for (const ScanMotorRow& row : rows) {
    formatted_rows.push_back(FormatScanMotorRow(row.slave_id, row.bus_id, row.motor_id, row.eff, row.canfd));
  }
  return FormatScanTable(formatted_rows);
}

std::string FormatControlHeader() {
  std::ostringstream output;
  output << std::right << std::setw(10) << "pos_deg" << "  " << std::setw(9) << "spd" << "  " << std::setw(9) << "tor"
         << "  " << std::setw(9) << "cur" << "  " << std::setw(9) << "tmp" << "  " << std::setw(9) << "mos_tmp" << "  "
         << "err";
  return output.str();
}

std::string FormatControlRow(float position_degrees, float speed, float torque, float current, float motor_temperature,
                             float mos_temperature, const std::string& error) {
  std::ostringstream output;
  output << std::fixed << std::setprecision(6) << std::right << std::setw(10) << position_degrees << "  "
         << std::setw(9) << speed << "  " << std::setw(9) << torque << "  " << std::setw(9) << current << "  "
         << std::setw(9) << motor_temperature << "  " << std::setw(9) << mos_temperature << "  " << error;
  return output.str();
}

}  // namespace motor_cli
