#include "cli_command.h"

#include <encos/battery/battery.h>

#include <cstdint>
#include <doctest.hpp>
#include <stdexcept>
#include <string>

#include "src/cli/battery.h"
#include "src/cli/glove.h"
#include "src/cli/imu.h"
#include "src/cli/pms.h"

namespace motor_cli {
namespace {

TEST_CASE("ParseMotorTarget accepts four-part target") {
  const MotorTarget target = ParseMotorTarget("Ethercat:eth0:0:1");

  CHECK(target.adapter_type == "Ethercat");
  CHECK(target.adapter_id == "eth0");
  REQUIRE(!target.slave_id.has_value());
  CHECK(target.bus_id == 0);
  CHECK(target.motor_id == 1);
}

TEST_CASE("ParseMotorTarget accepts five-part target") {
  const MotorTarget target = ParseMotorTarget("Ethercat:eth0:3:0:1");

  CHECK(target.adapter_type == "Ethercat");
  CHECK(target.adapter_id == "eth0");
  REQUIRE(target.slave_id.has_value());
  CHECK(*target.slave_id == 3);
  CHECK(target.bus_id == 0);
  CHECK(target.motor_id == 1);
}

TEST_CASE("ParseMotorTarget supports @...@ quoted adapter id with colons") {
  const MotorTarget target = ParseMotorTarget("wsRelay:@http://192.168.1.1:8080@:ALL");
  CHECK(target.adapter_type == "wsRelay");
  CHECK(target.adapter_id == "http://192.168.1.1:8080");
  CHECK(target.scope == TargetScope::AdapterAllMotors);
}

TEST_CASE("ParseMotorTarget supports quoted URL with bus and motor") {
  const MotorTarget target = ParseMotorTarget("wsRelay:@http://192.168.1.1:8080@:0:1");
  CHECK(target.adapter_type == "wsRelay");
  CHECK(target.adapter_id == "http://192.168.1.1:8080");
  CHECK(target.scope == TargetScope::SingleMotor);
  REQUIRE(target.bus_id.has_value());
  CHECK(*target.bus_id == 0);
  REQUIRE(target.motor_id.has_value());
  CHECK(*target.motor_id == 1);
}

TEST_CASE("ParseScanTarget supports quoted URL adapter id") {
  const ScanTarget target = ParseScanTarget("wsRelay:@http://192.168.1.1:8080@");
  CHECK(target.adapter_type == "wsRelay");
  CHECK(target.adapter_id == "http://192.168.1.1:8080");
}

TEST_CASE("ParseMotorTarget strips @...@ without colons") {
  const MotorTarget target = ParseMotorTarget("Ethercat:@eth0@:ALL");
  CHECK(target.adapter_type == "Ethercat");
  CHECK(target.adapter_id == "eth0");
}

TEST_CASE("ParseMotorTarget rejects unbalanced @") {
  CHECK_THROWS_AS(ParseMotorTarget("wsRelay:@http://192.168.1.1:8080:ALL"), std::runtime_error);
}

TEST_CASE("ParseMotorTarget accepts adapter bus and slave-bus all targets") {
  const MotorTarget adapter_target = ParseMotorTarget("Ethercat:eth0:ALL");
  CHECK(adapter_target.adapter_type == "Ethercat");
  CHECK(adapter_target.adapter_id == "eth0");
  CHECK(adapter_target.scope == TargetScope::AdapterAllMotors);
  CHECK(!adapter_target.slave_id.has_value());
  CHECK(!adapter_target.bus_id.has_value());
  CHECK(!adapter_target.motor_id.has_value());

  const MotorTarget bus_target = ParseMotorTarget("Ethercat:eth0:0:ALL");
  CHECK(bus_target.adapter_type == "Ethercat");
  CHECK(bus_target.adapter_id == "eth0");
  CHECK(bus_target.scope == TargetScope::BusAllMotors);
  CHECK(!bus_target.slave_id.has_value());
  REQUIRE(bus_target.bus_id.has_value());
  CHECK(*bus_target.bus_id == 0);
  CHECK(!bus_target.motor_id.has_value());

  const MotorTarget slave_bus_target = ParseMotorTarget("Ethercat:eth0:3:0:ALL");
  CHECK(slave_bus_target.adapter_type == "Ethercat");
  CHECK(slave_bus_target.adapter_id == "eth0");
  CHECK(slave_bus_target.scope == TargetScope::SlaveBusAllMotors);
  REQUIRE(slave_bus_target.slave_id.has_value());
  CHECK(*slave_bus_target.slave_id == 3);
  REQUIRE(slave_bus_target.bus_id.has_value());
  CHECK(*slave_bus_target.bus_id == 0);
  CHECK(!slave_bus_target.motor_id.has_value());
}

TEST_CASE("ParseMotorTarget rejects invalid targets") {
  CHECK_THROWS_AS(ParseMotorTarget("Ethercat:eth0:1"), std::runtime_error);
  CHECK_THROWS_AS(ParseMotorTarget("Ethercat::0:1"), std::runtime_error);
  CHECK_THROWS_AS(ParseMotorTarget("Ethercat:eth0:not-a-bus:1"), std::runtime_error);
  CHECK_THROWS_AS(ParseMotorTarget("Ethercat:eth0:0:not-a-motor"), std::runtime_error);
  CHECK_THROWS_AS(ParseMotorTarget("Ethercat:eth0:ALL:ALL"), std::runtime_error);
  CHECK_THROWS_AS(ParseMotorTarget("Ethercat:eth0:1:0:1:extra"), std::runtime_error);
}

TEST_CASE("ParseScanTarget accepts adapter and bus targets") {
  const ScanTarget adapter_type_target = ParseScanTarget("Ethercat");
  CHECK(adapter_type_target.adapter_type == "Ethercat");
  CHECK(adapter_type_target.adapter_id.empty());
  CHECK(!adapter_type_target.slave_id.has_value());
  CHECK(!adapter_type_target.bus_id.has_value());

  const ScanTarget adapter_target = ParseScanTarget("Ethercat:eth0");
  CHECK(adapter_target.adapter_type == "Ethercat");
  CHECK(adapter_target.adapter_id == "eth0");
  CHECK(!adapter_target.slave_id.has_value());
  CHECK(!adapter_target.bus_id.has_value());

  const ScanTarget bus_target = ParseScanTarget("Ethercat:eth0:1");
  CHECK(bus_target.adapter_type == "Ethercat");
  CHECK(bus_target.adapter_id == "eth0");
  CHECK(!bus_target.slave_id.has_value());
  REQUIRE(bus_target.bus_id.has_value());
  CHECK(*bus_target.bus_id == 1);

  const ScanTarget slave_bus_target = ParseScanTarget("Ethercat:eth0:3:1");
  CHECK(slave_bus_target.adapter_type == "Ethercat");
  CHECK(slave_bus_target.adapter_id == "eth0");
  REQUIRE(slave_bus_target.slave_id.has_value());
  REQUIRE(slave_bus_target.bus_id.has_value());
  CHECK(*slave_bus_target.slave_id == 3);
  CHECK(*slave_bus_target.bus_id == 1);
}

TEST_CASE("ParseScanTarget rejects invalid targets") {
  CHECK_THROWS_AS(ParseScanTarget(""), std::runtime_error);
  CHECK_THROWS_AS(ParseScanTarget("Ethercat:"), std::runtime_error);
  CHECK_THROWS_AS(ParseScanTarget("Ethercat:eth0:not-a-bus"), std::runtime_error);
  CHECK_THROWS_AS(ParseScanTarget("Ethercat:eth0:3:not-a-bus"), std::runtime_error);
  CHECK_THROWS_AS(ParseScanTarget("Ethercat:eth0:3:1:extra"), std::runtime_error);
}

TEST_CASE("ParseScanCommand parses target") {
  const ScanCommand without_flag = ParseScanCommand({"Ethercat:eth0"});
  CHECK(without_flag.target.adapter_type == "Ethercat");
  CHECK(without_flag.target.adapter_id == "eth0");

  const ScanCommand slave_bus = ParseScanCommand({"Ethercat:eth0:3:1"});
  CHECK(slave_bus.target.adapter_type == "Ethercat");
  CHECK(slave_bus.target.adapter_id == "eth0");
  REQUIRE(slave_bus.target.slave_id.has_value());
  CHECK(*slave_bus.target.slave_id == 3);
  REQUIRE(slave_bus.target.bus_id.has_value());
  CHECK(*slave_bus.target.bus_id == 1);

  const ScanCommand bus = ParseScanCommand({"Ethercat:eth0:1"});
  CHECK(bus.target.adapter_type == "Ethercat");
  CHECK(bus.target.adapter_id == "eth0");
  REQUIRE(bus.target.bus_id.has_value());
  CHECK(*bus.target.bus_id == 1);
}

TEST_CASE("ParseScanCommand rejects invalid flags and arity") {
  CHECK_THROWS_AS(ParseScanCommand({}), std::runtime_error);
  CHECK_THROWS_AS(ParseScanCommand({"--canfd"}), std::runtime_error);
  CHECK_THROWS_AS(ParseScanCommand({"Ethercat:eth0", "--canfd"}), std::runtime_error);
  CHECK_THROWS_AS(ParseScanCommand({"Ethercat:eth0", "--unknown"}), std::runtime_error);
  CHECK_THROWS_AS(ParseScanCommand({"Ethercat:eth0", "Ethercat:eth1"}), std::runtime_error);
}

TEST_CASE("ParseSensorTarget accepts four-part and five-part targets") {
  const SensorTarget bus_target = ParseSensorTarget("Ethercat:eth0:0:1");
  CHECK(bus_target.adapter_type == "Ethercat");
  CHECK(bus_target.adapter_id == "eth0");
  CHECK(!bus_target.slave_id.has_value());
  CHECK(bus_target.bus_id == 0);
  CHECK(bus_target.device_idx == 1);

  const SensorTarget slave_bus_target = ParseSensorTarget("Ethercat:eth0:3:0:2");
  CHECK(slave_bus_target.adapter_type == "Ethercat");
  CHECK(slave_bus_target.adapter_id == "eth0");
  REQUIRE(slave_bus_target.slave_id.has_value());
  CHECK(*slave_bus_target.slave_id == 3);
  CHECK(slave_bus_target.bus_id == 0);
  CHECK(slave_bus_target.device_idx == 2);
}

TEST_CASE("ParseSensorTarget rejects ALL-style and malformed targets") {
  CHECK_THROWS_AS(ParseSensorTarget("Ethercat:eth0:ALL"), std::runtime_error);
  CHECK_THROWS_AS(ParseSensorTarget("Ethercat:eth0:0:ALL"), std::runtime_error);
  CHECK_THROWS_AS(ParseSensorTarget("Ethercat:eth0:3:0:ALL"), std::runtime_error);
  CHECK_THROWS_AS(ParseSensorTarget("Ethercat:eth0:0"), std::runtime_error);
  CHECK_THROWS_AS(ParseSensorTarget("Ethercat:eth0:not-a-bus:1"), std::runtime_error);
  CHECK_THROWS_AS(ParseSensorTarget("Ethercat:eth0:0:not-a-idx"), std::runtime_error);
}

TEST_CASE("ParseImuCommand parses show action") {
  const SensorCommand command = ParseImuCommand({"imu", "show", "Ethercat:eth0:0:1"});
  CHECK(command.action == SensorCommandAction::Show);
  CHECK(command.target.adapter_type == "Ethercat");
  CHECK(command.target.adapter_id == "eth0");
  CHECK(command.target.bus_id == 0);
  CHECK(command.target.device_idx == 1);
}

TEST_CASE("ParseBatteryCommand parses show and clear actions") {
  const SensorCommand show_command = ParseBatteryCommand({"battery", "show", "Ethercat:eth0:0:1"});
  CHECK(show_command.action == SensorCommandAction::Show);
  CHECK(show_command.target.bus_id == 0);
  CHECK(show_command.target.device_idx == 1);

  const SensorCommand clear_command = ParseBatteryCommand({"battery", "clear", "Ethercat:eth0:3:0:2"});
  CHECK(clear_command.action == SensorCommandAction::Clear);
  REQUIRE(clear_command.target.slave_id.has_value());
  CHECK(*clear_command.target.slave_id == 3);
  CHECK(clear_command.target.bus_id == 0);
  CHECK(clear_command.target.device_idx == 2);
}

TEST_CASE("ParsePmsCommand parses bus status and named V48 controls") {
  const PmsCommand show_command = ParsePmsCommand({"pms", "show", "Ethercat:eth0:0"});
  CHECK(show_command.action == PmsCommandAction::Show);
  CHECK(show_command.target.adapter_type == "Ethercat");
  CHECK(show_command.target.adapter_id == "eth0");
  CHECK(show_command.target.bus_id == 0);
  CHECK(!show_command.target.slave_id.has_value());

  const PmsCommand enable_command = ParsePmsCommand({"pms", "enable", "Ethercat:eth0:3:0", "V48_1", "V48_3", "V48_6"});
  CHECK(enable_command.action == PmsCommandAction::Enable);
  CHECK(enable_command.channels == std::vector<PmsChannel>{PmsChannel::V48_1, PmsChannel::V48_3, PmsChannel::V48_6});
  REQUIRE(enable_command.target.slave_id.has_value());
  CHECK(*enable_command.target.slave_id == 3);
  CHECK(enable_command.target.bus_id == 0);
}

TEST_CASE("ParsePmsCommand rejects unsupported or duplicate channels") {
  CHECK_THROWS_AS(ParsePmsCommand({"pms", "show", "Ethercat:eth0:0:1:2"}), std::runtime_error);
  CHECK_THROWS_AS(ParsePmsCommand({"pms", "enable", "Ethercat:eth0:0", "V19_1"}), std::runtime_error);
  CHECK_THROWS_AS(ParsePmsCommand({"pms", "disable", "Ethercat:eth0:0", "V48_1", "V48_1"}), std::runtime_error);
  CHECK_THROWS_AS(ParsePmsCommand({"pms", "enable", "Ethercat:eth0:0"}), std::runtime_error);
}

TEST_CASE("ParseGloveTarget parses slave targets") {
  const GloveTarget slave_target = ParseGloveTarget("Ethercat:eth0:3");
  CHECK(slave_target.adapter_type == "Ethercat");
  CHECK(slave_target.adapter_id == "eth0");
  CHECK(slave_target.slave_id == 3);

  const GloveTarget slave_zero_target = ParseGloveTarget("Ethercat:eth0:0");
  CHECK(slave_zero_target.adapter_type == "Ethercat");
  CHECK(slave_zero_target.adapter_id == "eth0");
  CHECK(slave_zero_target.slave_id == 0);
}

TEST_CASE("ParseGloveTarget rejects malformed targets") {
  CHECK_THROWS_AS(ParseGloveTarget("Ethercat"), std::runtime_error);
  CHECK_THROWS_AS(ParseGloveTarget("Ethercat:eth0"), std::runtime_error);
  CHECK_THROWS_AS(ParseGloveTarget("Ethercat:eth0:ALL"), std::runtime_error);
  CHECK_THROWS_AS(ParseGloveTarget("Ethercat:eth0:0:1"), std::runtime_error);
  CHECK_THROWS_AS(ParseGloveTarget("Ethercat:eth0:0:1:2"), std::runtime_error);
}

TEST_CASE("ParseGloveCommand parses show and calibrate variants") {
  const GloveCommand show_command = ParseGloveCommand({"glove", "show", "Ethercat:eth0:0"});
  CHECK(show_command.action == GloveCommandAction::Show);
  CHECK(show_command.target.adapter_type == "Ethercat");
  CHECK(show_command.target.adapter_id == "eth0");
  CHECK(show_command.target.slave_id == 0);

  const GloveCommand all_command = ParseGloveCommand({"glove", "calibrate", "Ethercat:eth0:0", "all"});
  CHECK(all_command.action == GloveCommandAction::Calibrate);
  CHECK(all_command.calibration_mode == GloveCalibrationMode::All);

  const GloveCommand single_command = ParseGloveCommand({"glove", "calibrate", "Ethercat:eth0:3", "1", "5"});
  CHECK(single_command.action == GloveCommandAction::Calibrate);
  CHECK(single_command.calibration_mode == GloveCalibrationMode::Single);
  CHECK(single_command.finger_idx == static_cast<uint8_t>(1));
  CHECK(single_command.encoder_idx == static_cast<uint8_t>(5));
  CHECK(single_command.target.slave_id == 3);

  const GloveCommand mask_command = ParseGloveCommand({"glove", "calibrate", "Ethercat:eth0:0", "2", "mask", "0x03F"});
  CHECK(mask_command.action == GloveCommandAction::Calibrate);
  CHECK(mask_command.calibration_mode == GloveCalibrationMode::Mask);
  CHECK(mask_command.finger_idx == static_cast<uint8_t>(2));
  CHECK(mask_command.encoder_mask == static_cast<uint16_t>(0x03F));
}

TEST_CASE("ParseGloveCommand rejects invalid arguments") {
  CHECK_THROWS_AS(ParseGloveCommand({"glove"}), std::runtime_error);
  CHECK_THROWS_AS(ParseGloveCommand({"glove", "show"}), std::runtime_error);
  CHECK_THROWS_AS(ParseGloveCommand({"glove", "show", "Ethercat:eth0:0", "extra"}), std::runtime_error);
  CHECK_THROWS_AS(ParseGloveCommand({"glove", "invalid", "Ethercat:eth0:0"}), std::runtime_error);
  CHECK_THROWS_AS(ParseGloveCommand({"glove", "calibrate", "Ethercat:eth0:0"}), std::runtime_error);
  CHECK_THROWS_AS(ParseGloveCommand({"glove", "calibrate", "Ethercat:eth0:0", "all", "extra"}), std::runtime_error);
  CHECK_THROWS_AS(ParseGloveCommand({"glove", "calibrate", "Ethercat:eth0:0", "5", "0"}), std::runtime_error);
  CHECK_THROWS_AS(ParseGloveCommand({"glove", "calibrate", "Ethercat:eth0:0", "0", "10"}), std::runtime_error);
  CHECK_THROWS_AS(ParseGloveCommand({"glove", "calibrate", "Ethercat:eth0:0", "0", "mask", "0"}), std::runtime_error);
  CHECK_THROWS_AS(ParseGloveCommand({"glove", "calibrate", "Ethercat:eth0:0", "0", "mask", "0x400"}),
                  std::runtime_error);
}

TEST_CASE("ParseImuCommand and ParseBatteryCommand validate shape") {
  CHECK_THROWS_AS(ParseImuCommand({"imu"}), std::runtime_error);
  CHECK_THROWS_AS(ParseImuCommand({"imu", "clear", "Ethercat:eth0:0:1"}), std::runtime_error);
  CHECK_THROWS_AS(ParseImuCommand({"imu", "show", "Ethercat:eth0:0:1", "extra"}), std::runtime_error);
  CHECK_THROWS_AS(ParseBatteryCommand({"battery"}), std::runtime_error);
  CHECK_THROWS_AS(ParseBatteryCommand({"battery", "invalid", "Ethercat:eth0:0:1"}), std::runtime_error);
  CHECK_THROWS_AS(ParseBatteryCommand({"battery", "show", "Ethercat:eth0:ALL"}), std::runtime_error);
}

TEST_CASE("ParseUint16 accepts decimal hex and binary") {
  CHECK(ParseUint16("2", "id") == static_cast<uint16_t>(2));
  CHECK(ParseUint16("0x02", "id") == static_cast<uint16_t>(2));
  CHECK(ParseUint16("0X0A", "id") == static_cast<uint16_t>(10));
  CHECK(ParseUint16("0b10", "id") == static_cast<uint16_t>(2));
  CHECK(ParseUint16("0B1010", "id") == static_cast<uint16_t>(10));
}

TEST_CASE("ParseUint16 rejects invalid values") {
  CHECK_THROWS_AS(ParseUint16("-1", "id"), std::runtime_error);
  CHECK_THROWS_AS(ParseUint16("65536", "id"), std::runtime_error);
  CHECK_THROWS_AS(ParseUint16("abc", "id"), std::runtime_error);
  CHECK_THROWS_AS(ParseUint16("1abc", "id"), std::runtime_error);
}

TEST_CASE("ParseCliCommand parses config read command") {
  const CliCommand command = ParseCliCommand({"config", "Ethercat:eth0:3:0:1", "kt"});

  CHECK(command.target.adapter_type == "Ethercat");
  CHECK(command.target.adapter_id == "eth0");
  CHECK(command.target.scope == TargetScope::SingleMotor);
  REQUIRE(command.target.slave_id.has_value());
  CHECK(*command.target.slave_id == 3);
  REQUIRE(command.target.bus_id.has_value());
  CHECK(*command.target.bus_id == 0);
  REQUIRE(command.target.motor_id.has_value());
  CHECK(*command.target.motor_id == 1);
  CHECK(command.item == ConfigItem::Kt);
  CHECK(command.operation == ConfigOperation::Read);
  CHECK(!command.canfd);
  CHECK(command.values.empty());
}

TEST_CASE("ParseCliCommand parses config set command") {
  const CliCommand command = ParseCliCommand({"config", "Ethercat:eth0:0:1", "pvt-kp-range", "set", "1", "500"});

  CHECK(command.item == ConfigItem::PvtKpRange);
  CHECK(command.operation == ConfigOperation::Set);
  CHECK(!command.canfd);
  REQUIRE(command.values.size() == 2U);
  CHECK(command.values[0] == "1");
  CHECK(command.values[1] == "500");
}

TEST_CASE("ParseCliCommand parses batch config targets") {
  const CliCommand adapter_read = ParseCliCommand({"config", "Ethercat:eth0:ALL", "kt"});
  CHECK(adapter_read.target.scope == TargetScope::AdapterAllMotors);
  CHECK(adapter_read.operation == ConfigOperation::Read);

  const CliCommand bus_write = ParseCliCommand({"config", "Ethercat:eth0:0:ALL", "position", "set", "45"});
  CHECK(bus_write.target.scope == TargetScope::BusAllMotors);
  CHECK(bus_write.operation == ConfigOperation::Set);

  const CliCommand slave_bus_read = ParseCliCommand({"config", "Ethercat:eth0:3:0:ALL", "position"});
  CHECK(slave_bus_read.target.scope == TargetScope::SlaveBusAllMotors);
  CHECK(slave_bus_read.operation == ConfigOperation::Read);
}

TEST_CASE("ParseCliCommand accepts optional canfd flag") {
  const CliCommand read_command = ParseCliCommand({"config", "--canfd", "Ethercat:eth0:0:1", "position"});

  CHECK(read_command.item == ConfigItem::Position);
  CHECK(read_command.operation == ConfigOperation::Read);
  CHECK(read_command.canfd);
  CHECK(read_command.values.empty());

  const CliCommand set_command = ParseCliCommand({"config", "Ethercat:eth0:0:1", "position", "set", "45", "--canfd"});

  CHECK(set_command.item == ConfigItem::Position);
  CHECK(set_command.operation == ConfigOperation::Set);
  CHECK(set_command.canfd);
  REQUIRE(set_command.values.size() == 1U);
  CHECK(set_command.values[0] == "45");
}

TEST_CASE("ParseCliCommand parses communication mode command") {
  const CliCommand can_command = ParseCliCommand({"config", "Ethercat:eth0:0:1", "comm", "set", "can"});

  CHECK(can_command.item == ConfigItem::CommunicationMode);
  CHECK(can_command.operation == ConfigOperation::Set);
  REQUIRE(can_command.values.size() == 1U);
  CHECK(can_command.values[0] == "can");

  const CliCommand canfd_command = ParseCliCommand({"config", "--canfd", "Ethercat:eth0:0:1", "comm", "set", "canfd"});

  CHECK(canfd_command.item == ConfigItem::CommunicationMode);
  CHECK(canfd_command.operation == ConfigOperation::Set);
  CHECK(canfd_command.canfd);
  REQUIRE(canfd_command.values.size() == 1U);
  CHECK(canfd_command.values[0] == "canfd");

  const CliCommand canopen_command = ParseCliCommand({"config", "Ethercat:eth0:0:1", "comm", "set", "canopen"});

  CHECK(canopen_command.item == ConfigItem::CommunicationMode);
  CHECK(canopen_command.operation == ConfigOperation::Set);
  REQUIRE(canopen_command.values.size() == 1U);
  CHECK(canopen_command.values[0] == "canopen");
}

TEST_CASE("ParseCliCommand parses position set command") {
  const CliCommand zero_command = ParseCliCommand({"config", "Ethercat:eth0:0:1", "position", "set", "0"});

  CHECK(zero_command.item == ConfigItem::Position);
  CHECK(zero_command.operation == ConfigOperation::Set);
  REQUIRE(zero_command.values.size() == 1U);
  CHECK(zero_command.values[0] == "0");

  const CliCommand nonzero_command = ParseCliCommand({"config", "Ethercat:eth0:0:1", "position", "set", "45"});

  CHECK(nonzero_command.item == ConfigItem::Position);
  CHECK(nonzero_command.operation == ConfigOperation::Set);
  REQUIRE(nonzero_command.values.size() == 1U);
  CHECK(nonzero_command.values[0] == "45");

  const CliCommand reset_command = ParseCliCommand({"config", "Ethercat:eth0:0:1", "position", "reset"});

  CHECK(reset_command.item == ConfigItem::Position);
  CHECK(reset_command.operation == ConfigOperation::Set);
  CHECK(reset_command.values.empty());
}

TEST_CASE("ParseCliCommand validates value arity") {
  CHECK_THROWS_AS(ParseCliCommand({"config", "Ethercat:eth0:0:1", "kt", "set"}), std::runtime_error);
  CHECK_THROWS_AS(ParseCliCommand({"config", "Ethercat:eth0:0:1", "kt", "set", "1", "2"}), std::runtime_error);
  CHECK_THROWS_AS(ParseCliCommand({"config", "Ethercat:eth0:0:1", "pvt-kp-range", "set", "1"}), std::runtime_error);
  CHECK_THROWS_AS(ParseCliCommand({"config", "Ethercat:eth0:0:1", "position", "set"}), std::runtime_error);
  CHECK_THROWS_AS(ParseCliCommand({"config", "Ethercat:eth0:0:1", "position", "set", "1", "2"}), std::runtime_error);
  CHECK_THROWS_AS(ParseCliCommand({"config", "Ethercat:eth0:0:1", "position", "reset-zero"}), std::runtime_error);
  CHECK_THROWS_AS(ParseCliCommand({"config", "Ethercat:eth0:0:1", "comm"}), std::runtime_error);
  CHECK_THROWS_AS(ParseCliCommand({"config", "Ethercat:eth0:0:1", "comm", "can"}), std::runtime_error);
  CHECK_THROWS_AS(ParseCliCommand({"config", "Ethercat:eth0:0:1", "comm", "set", "invalid"}), std::runtime_error);
  CHECK_THROWS_AS(ParseCliCommand({"config", "Ethercat:eth0:0:1", "comm", "set", "can", "extra"}), std::runtime_error);
  CHECK_THROWS_AS(ParseCliCommand({"config", "--canfd", "Ethercat:eth0:0:1", "kt", "--canfd"}), std::runtime_error);
  CHECK_THROWS_AS(ParseCliCommand({"config", "Ethercat:eth0:ALL", "id", "set", "2"}), std::runtime_error);
  CHECK_THROWS_AS(ParseCliCommand({"config", "Ethercat:eth0:0:1", "id"}), std::runtime_error);
  CHECK_THROWS_AS(ParseCliCommand({"config", "Ethercat:eth0:0:1", "unknown"}), std::runtime_error);
  CHECK_THROWS_AS(ParseCliCommand({"Ethercat:eth0:0:1", "config", "kt"}), std::runtime_error);
}

TEST_CASE("ParseControlCommand parses continuous control commands") {
  const ControlCommand pvt =
      ParseControlCommand({"control", "pvt", "Ethercat:eth0:3:0:1", "20", "1", "90", "10", "0.5"});
  CHECK(pvt.item == ControlItem::Pvt);
  CHECK(!pvt.canfd);
  REQUIRE(pvt.target.slave_id.has_value());
  CHECK(*pvt.target.slave_id == 3);
  REQUIRE(pvt.values.size() == 5U);
  CHECK(pvt.values[0] == doctest::Approx(20.0f));
  CHECK(pvt.values[1] == doctest::Approx(1.0f));
  CHECK(pvt.values[2] == doctest::Approx(1.5707963f));
  CHECK(pvt.values[3] == doctest::Approx(10.0f));
  CHECK(pvt.values[4] == doctest::Approx(0.5f));

  const ControlCommand position = ParseControlCommand({"control", "position", "Ethercat:eth0:0:1", "45", "2", "3"});
  CHECK(position.item == ControlItem::Position);
  REQUIRE(position.values.size() == 3U);
  CHECK(position.values[0] == doctest::Approx(0.7853982f));

  const ControlCommand speed = ParseControlCommand({"control", "speed", "Ethercat:eth0:0:1", "5", "2"});
  CHECK(speed.item == ControlItem::Speed);
  REQUIRE(speed.values.size() == 2U);

  const ControlCommand current = ParseControlCommand({"control", "current", "Ethercat:eth0:0:1", "1.5"});
  CHECK(current.item == ControlItem::Current);
  REQUIRE(current.values.size() == 1U);

  const ControlCommand torque = ParseControlCommand({"control", "torque", "Ethercat:eth0:0:1", "0.8"});
  CHECK(torque.item == ControlItem::Torque);
  REQUIRE(torque.values.size() == 1U);

  const ControlCommand brake = ParseControlCommand({"control", "brake", "Ethercat:eth0:0:1", "dynamic", "2"});
  CHECK(brake.item == ControlItem::Brake);
  CHECK(brake.brake_mode == BrakeMode::Dynamic);
  REQUIRE(brake.values.size() == 1U);
  CHECK(brake.values[0] == doctest::Approx(2.0f));
}

TEST_CASE("ParseControlCommand parses batch targets") {
  const ControlCommand adapter_target = ParseControlCommand({"control", "current", "Ethercat:eth0:ALL", "1.5"});
  CHECK(adapter_target.target.scope == TargetScope::AdapterAllMotors);
  REQUIRE(adapter_target.values.size() == 1U);

  const ControlCommand bus_target = ParseControlCommand({"control", "speed", "Ethercat:eth0:0:ALL", "5", "2"});
  CHECK(bus_target.target.scope == TargetScope::BusAllMotors);
  REQUIRE(bus_target.values.size() == 2U);

  const ControlCommand slave_bus_target = ParseControlCommand({"control", "torque", "Ethercat:eth0:3:0:ALL", "0.8"});
  CHECK(slave_bus_target.target.scope == TargetScope::SlaveBusAllMotors);
  REQUIRE(slave_bus_target.values.size() == 1U);
}

TEST_CASE("ParseControlCommand accepts optional canfd flag") {
  const ControlCommand before_mode =
      ParseControlCommand({"control", "--canfd", "position", "Ethercat:eth0:0:1", "45", "2", "3"});

  CHECK(before_mode.item == ControlItem::Position);
  CHECK(before_mode.canfd);
  REQUIRE(before_mode.values.size() == 3U);
  CHECK(before_mode.values[0] == doctest::Approx(0.7853982f));

  const ControlCommand after_values =
      ParseControlCommand({"control", "current", "Ethercat:eth0:0:1", "1.5", "--canfd"});

  CHECK(after_values.item == ControlItem::Current);
  CHECK(after_values.canfd);
  REQUIRE(after_values.values.size() == 1U);
  CHECK(after_values.values[0] == doctest::Approx(1.5f));
}

TEST_CASE("ParseControlCommand validates mode and arity") {
  CHECK_THROWS_AS(ParseControlCommand({"control", "disable", "Ethercat:eth0:0:1"}), std::runtime_error);
  CHECK_THROWS_AS(ParseControlCommand({"control", "pvt", "Ethercat:eth0:0:1", "1", "2", "3", "4"}), std::runtime_error);
  CHECK_THROWS_AS(ParseControlCommand({"control", "position", "Ethercat:eth0:0:1", "1", "2"}), std::runtime_error);
  CHECK_THROWS_AS(ParseControlCommand({"control", "speed", "Ethercat:eth0:0:1", "1"}), std::runtime_error);
  CHECK_THROWS_AS(ParseControlCommand({"control", "current", "Ethercat:eth0:0:1"}), std::runtime_error);
  CHECK_THROWS_AS(ParseControlCommand({"control", "torque", "Ethercat:eth0:0:1"}), std::runtime_error);
  CHECK_THROWS_AS(ParseControlCommand({"control", "brake", "Ethercat:eth0:0:1", "invalid", "2"}), std::runtime_error);
  CHECK_THROWS_AS(ParseControlCommand({"control", "brake", "Ethercat:eth0:0:1", "full", "1"}), std::runtime_error);
  CHECK_THROWS_AS(ParseControlCommand({"control", "--canfd", "current", "Ethercat:eth0:0:1", "1", "--canfd"}),
                  std::runtime_error);
}

TEST_CASE("BuildTopLevelHelp describes TUI and command mode") {
  const std::string help = BuildTopLevelHelp();

  CHECK(help.find("Usage:") != std::string::npos);
  CHECK(help.find("Commands:") != std::string::npos);
  CHECK(help.find("tui") != std::string::npos);
  CHECK(help.find("scan") != std::string::npos);
  CHECK(help.find("config") != std::string::npos);
  CHECK(help.find("control") != std::string::npos);
  CHECK(help.find("imu") != std::string::npos);
  CHECK(help.find("battery") != std::string::npos);
  CHECK(help.find("pms") != std::string::npos);
  CHECK(help.find("glove") != std::string::npos);
  CHECK(help.find("zero") != std::string::npos);
  CHECK(help.find("Scan output:") == std::string::npos);
  CHECK(help.find("Control examples:") == std::string::npos);
  CHECK(help.find("Readable items:") == std::string::npos);
  CHECK(help.find("-a, --adapter") == std::string::npos);
}

TEST_CASE("Subcommand help describes only the requested command") {
  const std::string tui_help = BuildTuiHelp();
  CHECK(tui_help.find("emcli tui [AdapterType:AdapterId...]") != std::string::npos);
  CHECK(tui_help.find("emcli tui Ethercat:eth0 Ethercat:ALL") != std::string::npos);
  CHECK(tui_help.find("Scan output:") == std::string::npos);
  CHECK(tui_help.find("Control examples:") == std::string::npos);

  const std::string scan_help = BuildScanHelp();
  CHECK(scan_help.find("emcli scan <AdapterType>") != std::string::npos);
  CHECK(scan_help.find("Scan output:") != std::string::npos);
  CHECK(scan_help.find("Readable items:") == std::string::npos);
  CHECK(scan_help.find("Control examples:") == std::string::npos);

  const std::string config_help = BuildConfigHelp();
  CHECK(config_help.find("emcli config [--canfd] <target> <item>") != std::string::npos);
  CHECK(config_help.find("emcli config [--canfd] <target> comm set <can|canfd|canopen>") != std::string::npos);
  CHECK(config_help.find("AdapterType:AdapterId:ALL") != std::string::npos);
  CHECK(config_help.find("AdapterType:AdapterId:BusId:ALL") != std::string::npos);
  CHECK(config_help.find("AdapterType:AdapterId:SlaveId:BusId:ALL") != std::string::npos);
  CHECK(config_help.find("--canfd") != std::string::npos);
  CHECK(config_help.find("Readable items:") != std::string::npos);
  CHECK(config_help.find("config Ethercat:eth0:0:1 id set") != std::string::npos);
  CHECK(config_help.find("config Ethercat:eth0:0:ALL kt") != std::string::npos);
  CHECK(config_help.find("config Ethercat:eth0:3:0:1 position set 0") != std::string::npos);
  CHECK(config_help.find("config Ethercat:eth0:3:0:1 position reset") != std::string::npos);
  CHECK(config_help.find("position reset-zero") == std::string::npos);
  CHECK(config_help.find("Scan output:") == std::string::npos);
  CHECK(config_help.find("Control examples:") == std::string::npos);

  const std::string control_help = BuildControlHelp();
  CHECK(control_help.find("emcli control [--canfd] <mode> <target> <values>") != std::string::npos);
  CHECK(control_help.find("AdapterType:AdapterId:ALL") != std::string::npos);
  CHECK(control_help.find("--canfd") != std::string::npos);
  CHECK(control_help.find("Control examples:") != std::string::npos);
  CHECK(control_help.find("control current Ethercat:eth0:0:ALL 1.5") != std::string::npos);
  CHECK(control_help.find("control current Ethercat:eth0:3:0:1 1.5") != std::string::npos);
  CHECK(control_help.find("Scan output:") == std::string::npos);
  CHECK(control_help.find("Readable items:") == std::string::npos);

  const std::string imu_help = BuildImuHelp();
  CHECK(imu_help.find("emcli imu show <target>") != std::string::npos);
  CHECK(imu_help.find("AdapterType:AdapterId:BusId:ImuIdx") != std::string::npos);
  CHECK(imu_help.find("50 Hz") != std::string::npos);
  CHECK(imu_help.find("accel") != std::string::npos);
  CHECK(imu_help.find("gyro") != std::string::npos);
  CHECK(imu_help.find("euler") != std::string::npos);

  const std::string battery_help = BuildBatteryHelp();
  CHECK(battery_help.find("emcli battery show <target>") != std::string::npos);
  CHECK(battery_help.find("emcli battery clear <target>") != std::string::npos);
  CHECK(battery_help.find("AdapterType:AdapterId:BusId:BatteryIdx") != std::string::npos);
  CHECK(battery_help.find("50 Hz") != std::string::npos);
  CHECK(battery_help.find("error") != std::string::npos);

  const std::string pms_help = BuildPmsHelp();
  CHECK(pms_help.find("emcli pms show <target>") != std::string::npos);
  CHECK(pms_help.find("emcli pms enable <target> V48_1 ...") != std::string::npos);
  CHECK(pms_help.find("V19") != std::string::npos);
  CHECK(pms_help.find("V5") != std::string::npos);

  const std::string glove_help = BuildGloveHelp();
  CHECK(glove_help.find("emcli glove show <target>") != std::string::npos);
  CHECK(glove_help.find("emcli glove calibrate <target> all") != std::string::npos);
  CHECK(glove_help.find("emcli glove calibrate <target> <finger_idx> <encoder_idx>") != std::string::npos);
  CHECK(glove_help.find("emcli glove calibrate <target> <finger_idx> mask <encoder_mask>") != std::string::npos);
  CHECK(glove_help.find("AdapterType:AdapterId:SlaveId") != std::string::npos);
  CHECK(glove_help.find("AdapterType:AdapterId:BusId") == std::string::npos);
  CHECK(glove_help.find("50 Hz") != std::string::npos);
  CHECK(glove_help.find("OFF") != std::string::npos);
}

TEST_CASE("Config item help describes only requested item") {
  const std::string kt_help = BuildConfigItemHelp("kt");
  CHECK(kt_help.find("emcli config [--canfd] <target> kt") != std::string::npos);
  CHECK(kt_help.find("emcli config [--canfd] <target> kt set <value>") != std::string::npos);
  CHECK(kt_help.find("pvt-kp-range") == std::string::npos);
  CHECK(kt_help.find("Control examples:") == std::string::npos);

  const std::string comm_help = BuildConfigItemHelp("comm");
  CHECK(comm_help.find("emcli config [--canfd] <target> comm set <can|canfd|canopen>") != std::string::npos);
  CHECK(comm_help.find("kt set") == std::string::npos);
  CHECK(comm_help.find("Control examples:") == std::string::npos);

  const std::string position_help = BuildConfigItemHelp("position");
  CHECK(position_help.find("emcli config [--canfd] <target> position set <position_deg>") != std::string::npos);
  CHECK(position_help.find("emcli config [--canfd] <target> position reset") != std::string::npos);
  CHECK(position_help.find("kt set") == std::string::npos);
  CHECK(position_help.find("Control examples:") == std::string::npos);
}

TEST_CASE("Control mode help describes only requested mode") {
  const std::string position_help = BuildControlModeHelp("position");
  CHECK(position_help.find("emcli control [--canfd] position <target> <position_deg> <max_speed_rad_s> "
                           "<max_current_a>") != std::string::npos);
  CHECK(position_help.find("pvt <kp>") == std::string::npos);
  CHECK(position_help.find("Readable items:") == std::string::npos);
}

TEST_CASE("Scan motor output is tab-separated table format") {
  CHECK(FormatScanHeader() == "slave\tbus\tid\teff\tcanfd");
  CHECK(FormatScanMotorRow(std::nullopt, 0, 1, false, true) == "\t0\t1\t0\t1");
  CHECK(FormatScanMotorRow(3, 0, 1, true, false) == "3\t0\t1\t1\t0");
  CHECK(FormatScanTable({"\t0\t1\t0\t1", "3\t0\t1\t1\t0"}) ==
        "slave\tbus\tid\teff\tcanfd\n\t0\t1\t0\t1\n3\t0\t1\t1\t0\n");
  CHECK(FormatScanTable({}) == "slave\tbus\tid\teff\tcanfd\n");
}

TEST_CASE("Scan motor rows sort by slave bus and motor") {
  const std::vector<ScanMotorRow> rows{
      {2, 0, 4, false, true}, {std::nullopt, 1, 7, false, false}, {1, 3, 2, true, true}, {1, 3, 1, false, true},
      {1, 2, 8, true, false},
  };

  CHECK(FormatSortedScanTable(rows) ==
        "slave\tbus\tid\teff\tcanfd\n"
        "\t1\t7\t0\t0\n"
        "1\t2\t8\t1\t0\n"
        "1\t3\t1\t0\t1\n"
        "1\t3\t2\t1\t1\n"
        "2\t0\t4\t0\t1\n");
}

TEST_CASE("Control feedback output is fixed-width table format") {
  CHECK(FormatControlHeader() == "   pos_deg        spd        tor        cur        tmp    mos_tmp  err");
  CHECK(FormatControlRow(90.0f, 1.5f, -0.25f, 2.0f, 31.25f, 45.5f, "NoError") ==
        " 90.000000   1.500000  -0.250000   2.000000  31.250000  45.500000  NoError");
}

TEST_CASE("IMU in-place refresh prefix clears the full previous table") {
  CHECK(BuildImuInPlaceRefreshPrefix(0) == "");
  CHECK(BuildImuInPlaceRefreshPrefix(4) ==
        "\r\033[2K"
        "\033[1A\r\033[2K"
        "\033[1A\r\033[2K"
        "\033[1A\r\033[2K"
        "\033[1A\r\033[2K");
}

TEST_CASE("Battery and PMS in-place refresh prefixes clear the full previous table") {
  const std::string expected =
      "\r\033[2K"
      "\033[1A\r\033[2K"
      "\033[1A\r\033[2K";
  CHECK(BuildBatteryInPlaceRefreshPrefix(2) == expected);
  CHECK(BuildPmsInPlaceRefreshPrefix(2) == expected);
  CHECK(BuildGloveInPlaceRefreshPrefix(2) == expected);
}

TEST_CASE("Glove in-place refresh prefix is empty before the first report") {
  CHECK(BuildGloveInPlaceRefreshPrefix(0) == "");
}

TEST_CASE("Battery report uses one row per active error and aligns its value column") {
  encos::BatteryStatus status{};
  status.error.comm_timeout = true;

  const std::string report = BuildBatteryReport(status);

  CHECK(report ==
        "item                  value\n"
        "soc                   \n"
        "battery_temp_c        \n"
        "mos_temp_c            \n"
        "voltage_v             \n"
        "discharge_current_a   \n"
        "error                 communication timeout\n");
  CHECK(BuildBatteryInPlaceRefreshPrefix(7) ==
        "\r\033[2K"
        "\033[1A\r\033[2K"
        "\033[1A\r\033[2K"
        "\033[1A\r\033[2K"
        "\033[1A\r\033[2K"
        "\033[1A\r\033[2K"
        "\033[1A\r\033[2K"
        "\033[1A\r\033[2K");
}

TEST_CASE("Battery report aligns a fault-free status in the value column") {
  const encos::BatteryStatus status{};

  CHECK(BuildBatteryReport(status).find("error                 none\n") != std::string::npos);
}

}  // namespace
}  // namespace motor_cli
