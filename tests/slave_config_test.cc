// SPDX-License-Identifier: MIT

#include "src/cli/slave_config.h"

#include <doctest.hpp>
namespace motor_cli {
TEST_CASE("Slave targets select transport without claiming motor targets") {
  auto command = ParseSlaveConfig({"config", "Ethernet:eth0:10", "ip"});
  REQUIRE(command);
  CHECK(command->target.slave == 10);
  CHECK_FALSE(command->target.serial);
  CHECK(command->commands == std::vector<std::string>{"NET GET"});
  auto uuid = ParseSlaveConfig({"config", "Ethernet:eth0:4925c78e2e1d44ecca22ddb104730b57", "mode"});
  REQUIRE(uuid);
  CHECK_FALSE(uuid->target.slave);
  CHECK(uuid->target.uuid[0] == 0x49);
  for (const auto* target :
       {"Ethernet:/dev/ttyACM0", "Ethercat:/dev/ttyACM1", "EthercatIGH:/dev/ttyACM1", "EthercatWindows:/dev/ttyACM1"}) {
    auto serial = ParseSlaveConfig({"config", target, "mode"});
    REQUIRE(serial);
    CHECK(serial->target.serial);
  }
  for (const auto* target :
       {"Ethernet:eth0:10:0:1", "Ethernet:eth0:0:1", "Ethercat:eth0:ALL", "Ethercat:eth0:1:0:1", "Can:can0:0:1"})
    CHECK_FALSE(ParseSlaveConfig({"config", target, "kt"}));
}
TEST_CASE("Slave writes save then reboot and validate before IO") {
  auto mode = ParseSlaveConfig({"config", "Ethernet:eth0:1", "mode", "set", "enet"});
  REQUIRE(mode);
  CHECK(mode->commands == std::vector<std::string>{"MODE SET UDP", "CONFIG SAVE", "REBOOT"});
  auto ip = ParseSlaveConfig({"config", "Ethercat:/dev/ttyACM1", "ip", "set", "192.168.100.253"});
  REQUIRE(ip);
  CHECK(ip->commands == std::vector<std::string>{"NET SETIP 192.168.100.253", "CONFIG SAVE", "REBOOT"});
  for (const auto* target : {"Ethernet:eth0:254", "Ethernet:eth0:253", "Ethernet:eth0:ALL",
                             "Ethernet:eth0:00000000000000000000000000000000", "Ethercat:eth0"})
    CHECK_THROWS(ParseSlaveConfig({"config", target, "ip"}));
  CHECK_THROWS(ParseSlaveConfig({"config", "Ethernet:eth0:1", "ip", "set", "192.168.100.254"}));
  CHECK_THROWS(ParseSlaveConfig({"config", "Ethernet:eth0:1", "ip", "set", "192.168.101.1"}));
  CHECK_THROWS(ParseSlaveConfig({"config", "--canfd", "Ethernet:eth0:1", "mode"}));
  CHECK_THROWS(ParseSlaveConfig({"config", "Ethernet:eth0:1", "raw", "MODE GET\nREBOOT"}));
  auto raw = ParseSlaveConfig({"config", "Ethernet:eth0:1", "raw", "MODE", "GET"});
  REQUIRE(raw);
  CHECK(raw->commands == std::vector<std::string>{"MODE GET"});
}
}  // namespace motor_cli

TEST_CASE("Slave scan table orders indices and preserves empty EtherCAT UUID") {
  CHECK(motor_cli::IsEthercatPlugin("EthercatIGH"));
  CHECK(motor_cli::IsEthercatPlugin("EtherCATWindows"));
  CHECK_FALSE(motor_cli::IsEthercatPlugin("Can"));
  const auto table = motor_cli::FormatSlaveTable({{10, "abcd"}, {0, ""}});
  CHECK(table.find("SlaveIdx") != std::string::npos);
  CHECK(table.find("UUID") != std::string::npos);
  CHECK(table.find("0 ") < table.find("10 "));
}

TEST_CASE("Ethernet slave indices are zero based") {
  for (unsigned id : {0u, 252u}) {
    const auto request = motor_cli::ParseSlaveConfig({"config", "Ethernet:eth0:" + std::to_string(id), "ip"});
    REQUIRE(request);
    CHECK(request->target.slave == id);
  }
}

TEST_CASE("Slave configuration maps indices to IP and saves before reboot") {
  for (const auto* target : {"Ethernet:eth0:9", "Ethernet:eth0:1234567890abcdef1234567890abcdef",
                             "Ethernet:/dev/ttyACM0", "Ethercat:/dev/ttyACM0"}) {
    for (unsigned id : {0u, 9u, 252u}) {
      const auto request = motor_cli::ParseSlaveConfig({"config", target, "slave", "set", std::to_string(id)});
      REQUIRE(request);
      CHECK(request->commands ==
            std::vector<std::string>{"NET SETIP 192.168.100." + std::to_string(id + 1), "CONFIG SAVE", "REBOOT"});
    }
    for (const auto* invalid : {"-1", "253", "254", "256", "1x", "", "1\nREBOOT"}) {
      CHECK_THROWS(motor_cli::ParseSlaveConfig({"config", target, "slave", "set", invalid}));
    }
    const auto query = motor_cli::ParseSlaveConfig({"config", target, "slave", "get"});
    REQUIRE(query);
    CHECK(query->commands == std::vector<std::string>{"NET GET"});
    CHECK_THROWS(motor_cli::ParseSlaveConfig({"config", target, "slave", "set"}));
  }
}

TEST_CASE("USB CAN modes stage persistent configuration before reboot") {
  for (const auto* mode : {"usb3can", "usb8can"}) {
    const auto request = motor_cli::ParseSlaveConfig({"config", "Ethernet:/dev/ttyACM1", "mode", "set", mode});
    REQUIRE(request);
    CHECK(request->commands ==
          std::vector<std::string>{std::string("MODE SET ") + (std::string(mode) == "usb3can" ? "USB3CAN" : "USB8CAN"),
                                   "CONFIG SAVE", "REBOOT"});
  }

  CHECK(motor_cli::SlaveConfigHelp().find("ecat|enet|usb3can|usb8can") != std::string::npos);
}
