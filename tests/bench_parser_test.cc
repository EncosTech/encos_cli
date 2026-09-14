#include <argparse/argparse.hpp>
#include <array>
#include <cstdio>
#include <cstdlib>
#include <doctest.hpp>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

#include "src/cli/bench.h"
#include "src/cli/play.h"
#include "src/cli/stress.h"
#include "src/cli/zero.h"
#include "src/driver_version.h"

namespace motor_cli {
namespace {

std::string RunEmcli(const std::string& args) {
  std::array<char, 4096> buffer{};
  std::string result;
  const std::string command = "\"" + std::string(EMCLI_BIN) + "\" " + args + " 2>&1";
  FILE* pipe = popen(command.c_str(), "r");
  if (pipe == nullptr) {
    return {};
  }
  while (fgets(buffer.data(), static_cast<int>(buffer.size()), pipe) != nullptr) {
    result += buffer.data();
  }
  pclose(pipe);
  return result;
}

TEST_CASE("emcli version reports the runtime driver version or the compatibility fallback") {
  const std::string version = RunEmcli("--version");

  CHECK(version.find("emcli ") != std::string::npos);
  CHECK(version.find("libencosdriver ") != std::string::npos);
}

TEST_CASE("Runtime driver version must be within the supported range when available") {
  CHECK(std::string(GetSupportedEncosDriverVersionRequirement()) == "3.3.0 <= libencosdriver < 3.4.0");
  CHECK(IsSupportedEncosDriverVersion(std::nullopt));
  CHECK_FALSE(IsSupportedEncosDriverVersion(std::string("3.2.9")));
  CHECK(IsSupportedEncosDriverVersion(std::string("3.3.0")));
  CHECK(IsSupportedEncosDriverVersion(std::string("3.3.1")));
  CHECK_FALSE(IsSupportedEncosDriverVersion(std::string("3.4.0")));
  CHECK_FALSE(IsSupportedEncosDriverVersion(std::string("invalid")));
}

TEST_CASE("Bench help output contains bench description") {
  argparse::ArgumentParser bench_parser("bench");
  ConfigureBenchCommand(bench_parser);
  std::ostringstream output;
  output << bench_parser;
  const std::string help = output.str();
  CHECK(help.find("Benchmark") != std::string::npos);
  CHECK(help.find("adapter") != std::string::npos);
  CHECK(help.find("bus") != std::string::npos);
  CHECK(help.find("motor") != std::string::npos);
  CHECK(help.find("link") != std::string::npos);
  CHECK(help.find("--congestion-motor-count") != std::string::npos);
  CHECK(help.find("--plugin-path") != std::string::npos);
}

TEST_CASE("Stress help output contains stress description") {
  argparse::ArgumentParser stress_parser("stress");
  ConfigureStressCommand(stress_parser);
  std::ostringstream output;
  output << stress_parser;
  const std::string help = output.str();
  CHECK(help.find("Stress") != std::string::npos);
  CHECK(help.find("link") != std::string::npos);
  CHECK(help.find("--loop-period-ms") != std::string::npos);
  CHECK(help.find("--plugin-path") != std::string::npos);
}

TEST_CASE("Zero help output contains zero description") {
  argparse::ArgumentParser zero_parser("zero");
  ConfigureZeroCommand(zero_parser);
  std::ostringstream output;
  output << zero_parser;
  const std::string help = output.str();
  CHECK(help.find("Zero") != std::string::npos);
  CHECK(help.find("--canfd") != std::string::npos);
  CHECK(help.find("--dry-run") != std::string::npos);
  CHECK(help.find("config") != std::string::npos);
}

TEST_CASE("Play help output contains play description") {
  argparse::ArgumentParser play_parser("play");
  ConfigurePlayCommand(play_parser);
  std::ostringstream output;
  output << play_parser;
  const std::string help = output.str();
  CHECK(help.find("Play") != std::string::npos);
  CHECK(help.find("--canfd") == std::string::npos);
  CHECK(help.find("--dry-run") != std::string::npos);
  CHECK(help.find("--endless") != std::string::npos);
  CHECK(help.find("--max-speed") != std::string::npos);
  CHECK(help.find("--max-current") != std::string::npos);
  CHECK(help.find("config") != std::string::npos);
}

TEST_CASE("Bench rejects invalid arguments") {
  argparse::ArgumentParser bench_parser("bench");
  ConfigureBenchCommand(bench_parser);

  // Missing required link argument
  CHECK_THROWS_AS(bench_parser.parse_args({"bench"}), std::runtime_error);
}

TEST_CASE("Stress rejects invalid arguments") {
  argparse::ArgumentParser stress_parser("stress");
  ConfigureStressCommand(stress_parser);

  // Missing required link argument
  CHECK_THROWS_AS(stress_parser.parse_args({"stress"}), std::runtime_error);
}

TEST_CASE("Zero rejects invalid arguments") {
  argparse::ArgumentParser zero_parser("zero");
  ConfigureZeroCommand(zero_parser);

  CHECK_THROWS_AS(zero_parser.parse_args({"zero"}), std::runtime_error);
}

TEST_CASE("Bench parses valid arguments") {
  argparse::ArgumentParser bench_parser("bench");
  ConfigureBenchCommand(bench_parser);

  bench_parser.parse_args({"bench", "Ethercat:eth0"});
  CHECK(bench_parser.get<std::vector<std::string>>("link") == std::vector<std::string>{"Ethercat:eth0"});
  CHECK(bench_parser.get<std::string>("--congestion-motor-count") == "2");

  argparse::ArgumentParser bench_parser2("bench");
  ConfigureBenchCommand(bench_parser2);
  bench_parser2.parse_args(
      {"bench", "--congestion-motor-count", "4", "--congestion-motor-base-id", "0x800", "Ethercat:eth0"});
  CHECK(bench_parser2.get<std::vector<std::string>>("link") == std::vector<std::string>{"Ethercat:eth0"});
  CHECK(bench_parser2.get<std::string>("--congestion-motor-count") == "4");
  CHECK(bench_parser2.get<std::string>("--congestion-motor-base-id") == "0x800");

  argparse::ArgumentParser bench_parser3("bench");
  ConfigureBenchCommand(bench_parser3);
  bench_parser3.parse_args({"bench", "--congestion-motor-count", "0", "Ethercat:eth0"});
  CHECK(bench_parser3.get<std::string>("--congestion-motor-count") == "0");
}

TEST_CASE("ParseBenchTarget accepts adapter, bus, and motor level targets") {
  const motor_cli::BenchTarget adapter_target = motor_cli::ParseBenchTarget("Ethercat:eth0");
  CHECK(adapter_target.adapter_type == "Ethercat");
  CHECK(adapter_target.adapter_id == "eth0");
  CHECK(!adapter_target.bus_id.has_value());
  CHECK(!adapter_target.motor_id.has_value());

  const motor_cli::BenchTarget bus_target = motor_cli::ParseBenchTarget("Ethercat:eth0:1");
  CHECK(bus_target.adapter_type == "Ethercat");
  CHECK(bus_target.adapter_id == "eth0");
  REQUIRE(bus_target.bus_id.has_value());
  CHECK(*bus_target.bus_id == 1);
  CHECK(!bus_target.motor_id.has_value());

  const motor_cli::BenchTarget motor_target = motor_cli::ParseBenchTarget("Ethercat:eth0:1:3");
  CHECK(motor_target.adapter_type == "Ethercat");
  CHECK(motor_target.adapter_id == "eth0");
  REQUIRE(motor_target.bus_id.has_value());
  CHECK(*motor_target.bus_id == 1);
  REQUIRE(motor_target.motor_id.has_value());
  CHECK(*motor_target.motor_id == 3);
}

TEST_CASE("ParseBenchTarget rejects invalid targets") {
  CHECK_THROWS_AS(motor_cli::ParseBenchTarget(""), std::runtime_error);
  CHECK_THROWS_AS(motor_cli::ParseBenchTarget("Ethercat"), std::runtime_error);
  CHECK_THROWS_AS(motor_cli::ParseBenchTarget("Ethercat:"), std::runtime_error);
  CHECK_THROWS_AS(motor_cli::ParseBenchTarget("Ethercat:eth0:1:3:extra"), std::runtime_error);
  CHECK_THROWS_AS(motor_cli::ParseBenchTarget("Ethercat:eth0:not-a-bus"), std::runtime_error);
  CHECK_THROWS_AS(motor_cli::ParseBenchTarget("Ethercat:eth0:-1"), std::runtime_error);
}

TEST_CASE("Stress parses valid arguments") {
  argparse::ArgumentParser stress_parser("stress");
  ConfigureStressCommand(stress_parser);

  stress_parser.parse_args({"stress", "Ethercat:eth0"});
  CHECK(stress_parser.get<std::vector<std::string>>("link") == std::vector<std::string>{"Ethercat:eth0"});

  argparse::ArgumentParser stress_parser2("stress");
  ConfigureStressCommand(stress_parser2);
  stress_parser2.parse_args({"stress", "--loop-period-ms", "5", "--warmup-delay-ms", "200", "--drain-delay-ms", "500",
                             "Ethercat:eth0", "Can:vcan0"});
  CHECK(stress_parser2.get<std::vector<std::string>>("link") == std::vector<std::string>{"Ethercat:eth0", "Can:vcan0"});
  CHECK(stress_parser2.get<std::string>("--loop-period-ms") == "5");
  CHECK(stress_parser2.get<std::string>("--warmup-delay-ms") == "200");
  CHECK(stress_parser2.get<std::string>("--drain-delay-ms") == "500");
}

TEST_CASE("Stress terminal row count includes wrapped output lines") {
  CHECK(motor_cli::CountStressTerminalRows("12345", 5) == 1);
  CHECK(motor_cli::CountStressTerminalRows("123456", 5) == 2);
  CHECK(motor_cli::CountStressTerminalRows("123456\nabc\n12345678901", 5) == 6);
}

TEST_CASE("Stress decodes and formats encoded slave bus IDs") {
  const motor_cli::StressBusAddress encoded = motor_cli::DecodeStressBusAddress(65536);
  REQUIRE(encoded.slave_id.has_value());
  CHECK(*encoded.slave_id == 1);
  CHECK(encoded.bus_id == 0);
  CHECK(motor_cli::FormatStressBusLabel(encoded) == "Slave 1 Bus 0");

  const motor_cli::StressBusAddress plain = motor_cli::DecodeStressBusAddress(3);
  CHECK(!plain.slave_id.has_value());
  CHECK(plain.bus_id == 3);
  CHECK(motor_cli::FormatStressBusLabel(plain) == "Bus 3");
}

TEST_CASE("Stress in-place terminal sequences isolate and redraw live output") {
  CHECK(motor_cli::StressAlternateScreenEnterSequence() == "\033[?1049h");
  CHECK(motor_cli::BuildStressInPlaceRefreshPrefix() == "\033[H\033[2J");
  CHECK(motor_cli::StressAlternateScreenLeaveSequence() == "\033[?1049l");
}

TEST_CASE("Stress live report progressively folds to fit terminal height") {
  const motor_cli::StressLiveReportRows rows{
      19,
      15,
      10,
      4,
  };

  CHECK(motor_cli::SelectStressLiveDetailLevel(20, rows) == motor_cli::StressLiveDetailLevel::Full);
  CHECK(motor_cli::SelectStressLiveDetailLevel(19, rows) == motor_cli::StressLiveDetailLevel::Bus);
  CHECK(motor_cli::SelectStressLiveDetailLevel(15, rows) == motor_cli::StressLiveDetailLevel::Adapter);
  CHECK(motor_cli::SelectStressLiveDetailLevel(10, rows) == motor_cli::StressLiveDetailLevel::Overview);
  CHECK(motor_cli::SelectStressLiveDetailLevel(4, rows) == motor_cli::StressLiveDetailLevel::Overview);
}

TEST_CASE("Zero parses valid arguments in mixed order") {
  argparse::ArgumentParser zero_parser("zero");
  ConfigureZeroCommand(zero_parser);

  zero_parser.parse_args({"zero", "--canfd", "--dry-run", "points.csv"});
  CHECK(zero_parser.get<bool>("--canfd"));
  CHECK(zero_parser.get<bool>("--dry-run"));
  CHECK(zero_parser.get<std::string>("config") == "points.csv");

  argparse::ArgumentParser zero_parser2("zero");
  ConfigureZeroCommand(zero_parser2);
  zero_parser2.parse_args({"zero", "points.csv", "--canfd"});
  CHECK(zero_parser2.get<bool>("--canfd"));
  CHECK(!zero_parser2.get<bool>("--dry-run"));
  CHECK(zero_parser2.get<std::string>("config") == "points.csv");
}

TEST_CASE("Bench and stress do not contain emd naming") {
  argparse::ArgumentParser bench_parser("bench");
  ConfigureBenchCommand(bench_parser);
  std::ostringstream bench_output;
  bench_output << bench_parser;
  const std::string bench_help = bench_output.str();
  CHECK(bench_help.find("emd") == std::string::npos);
  CHECK(bench_help.find("bench") != std::string::npos);

  argparse::ArgumentParser stress_parser("stress");
  ConfigureStressCommand(stress_parser);
  std::ostringstream stress_output;
  stress_output << stress_parser;
  const std::string stress_help = stress_output.str();
  CHECK(stress_help.find("emd") == std::string::npos);
  CHECK(stress_help.find("stress") != std::string::npos);
}

TEST_CASE("emcli bench --help entry prints bench help") {
  const std::string help = RunEmcli("bench --help");
  CHECK(!help.empty());
  CHECK(help.find("Benchmark") != std::string::npos);
  CHECK(help.find("adapter") != std::string::npos);
  CHECK(help.find("bus") != std::string::npos);
  CHECK(help.find("motor") != std::string::npos);
  CHECK(help.find("--congestion-motor-count") != std::string::npos);
  CHECK(help.find("--plugin-path") != std::string::npos);
}

TEST_CASE("emcli stress --help entry prints stress help") {
  const std::string help = RunEmcli("stress --help");
  CHECK(!help.empty());
  CHECK(help.find("Stress") != std::string::npos);
  CHECK(help.find("--loop-period-ms") != std::string::npos);
  CHECK(help.find("--plugin-path") != std::string::npos);
}

TEST_CASE("emcli zero --help entry prints zero help") {
  const std::string help = RunEmcli("zero --help");
  CHECK(!help.empty());
  CHECK(help.find("Usage: emcli zero") != std::string::npos);
  CHECK(help.find("--canfd") != std::string::npos);
  CHECK(help.find("--dry-run") != std::string::npos);
  CHECK(help.find("config") != std::string::npos);
}

TEST_CASE("emcli play --help entry prints play help") {
  const std::string help = RunEmcli("play --help");
  CHECK(!help.empty());
  CHECK(help.find("Usage: emcli play") != std::string::npos);
  CHECK(help.find("--canfd") == std::string::npos);
  CHECK(help.find("--dry-run") != std::string::npos);
  CHECK(help.find("--endless") != std::string::npos);
  CHECK(help.find("--max-speed") != std::string::npos);
  CHECK(help.find("--max-current") != std::string::npos);
  CHECK(help.find("config") != std::string::npos);
}

TEST_CASE("emcli top-level help lists zero command") {
  const std::string help = RunEmcli("--help");
  CHECK(!help.empty());
  CHECK(help.find("zero") != std::string::npos);
  CHECK(help.find("play") != std::string::npos);
  CHECK(help.find("imu") != std::string::npos);
  CHECK(help.find("battery") != std::string::npos);
  CHECK(help.find("pms") != std::string::npos);
}

TEST_CASE("emcli imu battery and pms --help entries print sensor help") {
  const std::string imu_help = RunEmcli("imu --help");
  CHECK(!imu_help.empty());
  CHECK(imu_help.find("Usage:") != std::string::npos);
  CHECK(imu_help.find("emcli imu show <target>") != std::string::npos);
  CHECK(imu_help.find("AdapterType:AdapterId:BusId:ImuIdx") != std::string::npos);

  const std::string battery_help = RunEmcli("battery --help");
  CHECK(!battery_help.empty());
  CHECK(battery_help.find("Usage:") != std::string::npos);
  CHECK(battery_help.find("emcli battery show <target>") != std::string::npos);
  CHECK(battery_help.find("emcli battery clear <target>") != std::string::npos);

  const std::string pms_help = RunEmcli("pms --help");
  CHECK(!pms_help.empty());
  CHECK(pms_help.find("Usage:") != std::string::npos);
  CHECK(pms_help.find("emcli pms show <target>") != std::string::npos);
  CHECK(pms_help.find("V48_1") != std::string::npos);
}

}  // namespace
}  // namespace motor_cli
