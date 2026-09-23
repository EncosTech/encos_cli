// SPDX-License-Identifier: MIT

#pragma once

#include <argparse/argparse.hpp>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>

namespace motor_cli {

enum class StressLiveDetailLevel {
  Full,
  Bus,
  Adapter,
  Overview,
};

struct StressLiveReportRows {
  std::size_t full = 0;
  std::size_t bus = 0;
  std::size_t adapter = 0;
  std::size_t overview = 0;
};

struct StressBusAddress {
  std::optional<int32_t> slave_id;
  int32_t bus_id{0};
};

std::size_t CountStressTerminalRows(const std::string& text, std::size_t terminal_columns);
StressBusAddress DecodeStressBusAddress(int adapter_bus_id);
std::string FormatStressBusLabel(const StressBusAddress& address);
std::string StressAlternateScreenEnterSequence();
std::string BuildStressInPlaceRefreshPrefix();
std::string StressAlternateScreenLeaveSequence();
StressLiveDetailLevel SelectStressLiveDetailLevel(std::size_t terminal_rows, const StressLiveReportRows& report_rows);

}  // namespace motor_cli

void ConfigureBenchCommand(argparse::ArgumentParser& parser);
void ConfigureStressCommand(argparse::ArgumentParser& parser);

int RunBenchCommand(const argparse::ArgumentParser& parser);
int RunStressCommand(const argparse::ArgumentParser& parser);
