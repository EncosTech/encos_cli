#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace motor_cli {

enum class TargetScope {
  SingleMotor,
  AdapterAllMotors,
  BusAllMotors,
  SlaveBusAllMotors,
};

struct MotorTarget {
  TargetScope scope{TargetScope::SingleMotor};
  std::string adapter_type;
  std::string adapter_id;
  std::optional<int32_t> slave_id;
  std::optional<int32_t> bus_id;
  std::optional<uint16_t> motor_id;
};

enum class ConfigItem {
  Id,
  Position,
  Calibrate,
  Kt,
  PvtKpRange,
  PvtKdRange,
  PvtPositionRange,
  PvtSpeedRange,
  PvtTorqueRange,
  PvtCurrentRange,
  CurrentPi,
  SpeedPi,
  PositionPd,
  CanTimeout,
  CommunicationMode,
};

enum class ConfigOperation {
  Read,
  Set,
};

enum class ControlItem {
  Pvt,
  Position,
  Speed,
  Current,
  Torque,
  Stop,
  Brake,
};

enum class StopMode {
  Full,
  Dynamic,
  Regenerative,
};

struct CliCommand {
  MotorTarget target;
  ConfigItem item{ConfigItem::Id};
  ConfigOperation operation{ConfigOperation::Read};
  bool canfd{false};
  std::vector<std::string> values;
};

struct ControlCommand {
  MotorTarget target;
  ControlItem item{ControlItem::Pvt};
  StopMode stop_mode{StopMode::Full};
  bool brake_enabled{false};
  bool canfd{false};
  std::vector<float> values;
};

struct ScanTarget {
  std::string adapter_type;
  std::string adapter_id;
  std::optional<int32_t> slave_id;
  std::optional<int32_t> bus_id;
};

struct ScanCommand {
  ScanTarget target;
};

struct ScanMotorRow {
  std::optional<int32_t> slave_id;
  int32_t bus_id{0};
  int motor_id{0};
  bool eff{false};
  bool canfd{false};
};

enum class SensorCommandAction {
  Show,
  Clear,
};

enum class PmsCommandAction {
  Show,
  Enable,
  Disable,
};

enum class PmsChannel {
  V48_1,
  V48_2,
  V48_3,
  V48_4,
  V48_5,
  V48_6,
};

struct SensorTarget {
  std::string adapter_type;
  std::string adapter_id;
  std::optional<int32_t> slave_id;
  int32_t bus_id{0};
  uint16_t device_idx{0};
};

struct SensorCommand {
  SensorTarget target;
  SensorCommandAction action{SensorCommandAction::Show};
};

struct PmsTarget {
  std::string adapter_type;
  std::string adapter_id;
  std::optional<int32_t> slave_id;
  int32_t bus_id{0};
};

struct PmsCommand {
  PmsTarget target;
  PmsCommandAction action{PmsCommandAction::Show};
  std::vector<PmsChannel> channels;
};

enum class GloveCommandAction {
  Show,
  Calibrate,
};

enum class GloveCalibrationMode {
  All,
  Single,
  Mask,
};

struct GloveTarget {
  std::string adapter_type;
  std::string adapter_id;
  int32_t slave_id{0};
};

struct GloveCommand {
  GloveTarget target;
  GloveCommandAction action{GloveCommandAction::Show};
  GloveCalibrationMode calibration_mode{GloveCalibrationMode::All};
  uint8_t finger_idx{0};
  uint8_t encoder_idx{0};
  uint16_t encoder_mask{0};
};

bool LooksLikeMotorTarget(const std::string& value);
MotorTarget ParseMotorTarget(const std::string& value);
ScanTarget ParseScanTarget(const std::string& value);
ScanCommand ParseScanCommand(const std::vector<std::string>& arguments);
SensorTarget ParseSensorTarget(const std::string& value);
SensorCommand ParseImuCommand(const std::vector<std::string>& arguments);
SensorCommand ParseBatteryCommand(const std::vector<std::string>& arguments);
PmsCommand ParsePmsCommand(const std::vector<std::string>& arguments);
GloveTarget ParseGloveTarget(const std::string& value);
GloveCommand ParseGloveCommand(const std::vector<std::string>& arguments);
uint16_t ParseUint16(const std::string& value, const std::string& field_name);
CliCommand ParseCliCommand(const std::vector<std::string>& arguments);
ControlCommand ParseControlCommand(const std::vector<std::string>& arguments);
std::string BuildTopLevelHelp();
std::string BuildTuiHelp();
std::string BuildScanHelp();
std::string BuildConfigHelp();
std::string BuildConfigItemHelp(const std::string& item);
std::string BuildControlHelp();
std::string BuildControlModeHelp(const std::string& mode);
std::string BuildImuHelp();
std::string BuildBatteryHelp();
std::string BuildPmsHelp();
std::string BuildGloveHelp();
std::string FormatScanHeader();
std::string FormatScanMotorRow(std::optional<int32_t> slave_id, int32_t bus_id, int motor_id, bool eff, bool canfd);
std::string FormatScanTable(const std::vector<std::string>& rows);
std::string FormatSortedScanTable(std::vector<ScanMotorRow> rows);
std::string FormatControlHeader();
std::string FormatControlRow(float position_degrees, float speed, float torque, float current, float motor_temperature,
                             float mos_temperature, const std::string& error);

}  // namespace motor_cli
