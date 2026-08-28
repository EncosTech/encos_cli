#pragma once

#include <argparse/argparse.hpp>
#include <optional>
#include <string>

namespace motor_cli {

struct BenchTarget {
  std::string adapter_type;
  std::string adapter_id;
  std::optional<int> bus_id;
  std::optional<int> motor_id;
};

BenchTarget ParseBenchTarget(const std::string& value);

}  // namespace motor_cli

void ConfigureBenchCommand(argparse::ArgumentParser& parser);
void ConfigureStressCommand(argparse::ArgumentParser& parser);

int RunBenchCommand(const argparse::ArgumentParser& parser);
int RunStressCommand(const argparse::ArgumentParser& parser);
