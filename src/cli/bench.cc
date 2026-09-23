// SPDX-License-Identifier: MIT

#include "src/cli/bench.h"

#include <encos/encos_motor.h>
#include <encos/utils/thread_priority.h>
#include <nanobench.h>
#include <pthread.h>
#include <sched.h>
#include <sys/mman.h>

#include <argparse/argparse.hpp>
#include <atomic>
#include <chrono>
#include <cstdlib>
#include <iostream>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#include "src/cli/adapter_cli_utils.h"
#include "src/cli/interface_name.h"

namespace motor_cli {

namespace {

int ParsePositiveInt(const std::string& value, const std::string& field_name) {
  try {
    std::size_t pos = 0;
    const int parsed = std::stoi(value, &pos, 10);
    if (pos != value.size()) {
      throw std::runtime_error("Invalid integer for " + field_name + ": '" + value + "'");
    }
    if (parsed < 0) {
      throw std::runtime_error(field_name + " must be non-negative: '" + value + "'");
    }
    return parsed;
  } catch (const std::invalid_argument&) {
    throw std::runtime_error("Invalid integer for " + field_name + ": '" + value + "'");
  }
}

std::vector<std::string> SplitColonSeparated(const std::string& value) {
  std::vector<std::string> parts;
  std::string current;
  for (const char c : value) {
    if (c == ':') {
      parts.push_back(current);
      current.clear();
    } else {
      current.push_back(c);
    }
  }
  parts.push_back(current);
  return parts;
}

}  // namespace

BenchTarget ParseBenchTarget(const std::string& value) {
  const std::vector<std::string> parts = SplitColonSeparated(value);
  if (parts.size() < 2U || parts.size() > 4U) {
    throw std::runtime_error("Invalid bench target '" + value +
                             "', expected AdapterType:AdapterId, AdapterType:AdapterId:BusId, or "
                             "AdapterType:AdapterId:BusId:MotorId");
  }
  if (parts[0].empty() || parts[1].empty()) {
    throw std::runtime_error("Invalid bench target '" + value + "', adapter type and id must not be empty");
  }

  BenchTarget target;
  target.adapter_type = parts[0];
  target.adapter_id = parts[1];
  if (parts.size() >= 3U) {
    target.bus_id = ParsePositiveInt(parts[2], "BusId");
  }
  if (parts.size() == 4U) {
    target.motor_id = ParsePositiveInt(parts[3], "MotorId");
  }
  return target;
}

}  // namespace motor_cli

namespace {

using motor_cli::BenchTarget;
using motor_cli::ParseBenchTarget;

constexpr auto kCongestionMotorModel = encos::MotorModel::EC_A4310_P2;

struct BenchOptions {
  int congestion_motor_count = 2;
  int congestion_motor_base_id = 0x700;
  int min_packet_threshold = 50;
  int max_drop_count_before_threshold = 5;
  double max_drop_rate_after_threshold = 0.1;
};

struct DropStats {
  std::string label;
  int drop_count;
  int total_count;

  double DropRate() const { return total_count == 0 ? 0.0 : static_cast<double>(drop_count) / total_count; }
};

enum class ReadPattern {
  kAlternatingPositionAndSpeed,
  kPositionOnly,
};

void ConfigureRealtimeHints() {
  if (!encos::utils::SetCurrentThreadPriority(50)) {
    std::cerr << "Warning: Failed to set real-time scheduling. Run as root or with elevated "
                 "privileges."
              << std::endl;
  }

  cpu_set_t cpuset;
  CPU_ZERO(&cpuset);
  CPU_SET(2, &cpuset);
  if (pthread_setaffinity_np(pthread_self(), sizeof(cpu_set_t), &cpuset) != 0) {
    std::cerr << "Warning: Failed to set CPU affinity. Run as root or with elevated privileges." << std::endl;
  }

  if (mlockall(MCL_CURRENT | MCL_FUTURE) != 0) {
    std::cerr << "Warning: Failed to lock memory pages. Run as root or with elevated privileges." << std::endl;
  }
}

int ParseInt(const argparse::ArgumentParser& parser, const std::string& key, int base = 10) {
  std::size_t pos = 0;
  const auto value = parser.get<std::string>(key);
  const int parsed = std::stoi(value, &pos, base);
  if (pos != value.size()) {
    throw std::runtime_error("Invalid integer for " + key + ": '" + value + "'");
  }
  return parsed;
}

double ParseDouble(const argparse::ArgumentParser& parser, const std::string& key) {
  std::size_t pos = 0;
  const auto value = parser.get<std::string>(key);
  const double parsed = std::stod(value, &pos);
  if (pos != value.size()) {
    throw std::runtime_error("Invalid number for " + key + ": '" + value + "'");
  }
  return parsed;
}

BenchOptions ParseBenchOptions(const argparse::ArgumentParser& parser) {
  BenchOptions options;
  options.congestion_motor_count = ParseInt(parser, "--congestion-motor-count");
  options.congestion_motor_base_id = ParseInt(parser, "--congestion-motor-base-id", 0);
  options.min_packet_threshold = ParseInt(parser, "--min-packet-threshold");
  options.max_drop_count_before_threshold = ParseInt(parser, "--max-drop-count-before-threshold");
  options.max_drop_rate_after_threshold = ParseDouble(parser, "--max-drop-rate-after-threshold");

  if (options.congestion_motor_count < 0) {
    throw std::runtime_error("--congestion-motor-count must be >= 0");
  }
  if (options.congestion_motor_base_id < 0) {
    throw std::runtime_error("--congestion-motor-base-id must be >= 0");
  }
  if (options.min_packet_threshold < 0) {
    throw std::runtime_error("--min-packet-threshold must be >= 0");
  }
  if (options.max_drop_count_before_threshold < 0) {
    throw std::runtime_error("--max-drop-count-before-threshold must be >= 0");
  }
  if (options.max_drop_rate_after_threshold < 0.0 || options.max_drop_rate_after_threshold > 1.0) {
    throw std::runtime_error("--max-drop-rate-after-threshold must be within [0.0, 1.0]");
  }

  return options;
}

template <typename MotorT>
void ReadMotorParameter(MotorT& motor, int total_count, ReadPattern pattern) {
  if (pattern == ReadPattern::kPositionOnly || total_count % 2 == 0) {
    ankerl::nanobench::doNotOptimizeAway(motor->template GetParameter<encos::MotorParameter::Position>());
    return;
  }

  ankerl::nanobench::doNotOptimizeAway(motor->template GetParameter<encos::MotorParameter::Speed>());
}

template <typename BenchT, typename MotorT>
DropStats RunBenchmark(BenchT& bench, const std::string& bench_name, const std::string& display_label, MotorT& motor,
                       const BenchOptions& options, ReadPattern pattern = ReadPattern::kAlternatingPositionAndSpeed) {
  DropStats stats{display_label, 0, 0};
  bench.run(bench_name, [&] {
    try {
      ++stats.total_count;
      ReadMotorParameter(motor, stats.total_count, pattern);
    } catch (const std::exception&) {
      ++stats.drop_count;
      const bool too_many_drops_before_threshold = stats.total_count < options.min_packet_threshold &&
                                                   stats.drop_count > options.max_drop_count_before_threshold;
      const bool drop_rate_too_high_after_threshold =
          stats.total_count >= options.min_packet_threshold && stats.DropRate() > options.max_drop_rate_after_threshold;
      if (too_many_drops_before_threshold || drop_rate_too_high_after_threshold) {
        throw std::runtime_error("Too many dropped packets during benchmark");
      }
    }
  });
  return stats;
}

void PrintDropStats(const DropStats& stats) {
  std::cout << stats.label << ": " << stats.DropRate() * 100 << "% (" << stats.drop_count << "/" << stats.total_count
            << ")" << std::endl;
}

void PrepareCongestionDelay(std::atomic<int>& wait, int delay_ms, bool reset_before_change) {
  if (reset_before_change) {
    wait.store(100);
    std::this_thread::sleep_for(std::chrono::seconds(1));
    wait.store(delay_ms);
  }
  std::this_thread::sleep_for(std::chrono::milliseconds(200));
}

std::vector<encos::Motor*> CreateSyntheticCongestionMotors(encos::Bus* bus, const BenchOptions& options) {
  std::vector<encos::Motor*> motors;
  motors.reserve(options.congestion_motor_count);
  for (int i = 0; i < options.congestion_motor_count; ++i) {
    encos::Motor* motor = bus->GetMotor(options.congestion_motor_base_id + i, kCongestionMotorModel);
    if (options.congestion_motor_count > 2) {
      motor->EnableCanFd();
    }
    motors.push_back(motor);
  }
  return motors;
}

struct ScannedMotor {
  int bus_id;
  encos::Bus* bus;
  int motor_id;
  encos::Motor* motor;
};

std::vector<ScannedMotor> ScanAdapterMotors(encos::BaseAdapter& adapter, const std::optional<int>& filter_bus_id) {
  std::vector<ScannedMotor> result;
  const auto buses = adapter.GetBuses();
  for (const auto& [bus_id, bus] : buses) {
    if (filter_bus_id.has_value() && bus_id != *filter_bus_id) {
      continue;
    }
    const auto motors = bus->ScanMotors();
    for (const auto& [motor_id, motor] : motors) {
      result.push_back(ScannedMotor{bus_id, bus, motor_id, motor});
    }
  }
  return result;
}

struct BenchContext {
  encos::Motor* benchmark_motor;
  std::vector<encos::Motor*> congestion_motors;
};

BenchContext PrepareMotorLevelBench(encos::BaseAdapter& adapter, const BenchTarget& target,
                                    const BenchOptions& options) {
  if (!target.bus_id.has_value()) {
    throw std::runtime_error("Bench motor-level target requires BusId");
  }
  encos::Bus* bus = adapter.GetBus(*target.bus_id);
  if (!bus) {
    throw std::runtime_error("Failed to get target bus: " + std::to_string(*target.bus_id));
  }
  if (!target.motor_id.has_value()) {
    throw std::runtime_error("Bench motor-level target requires MotorId");
  }
  encos::Motor* motor = bus->GetMotor(*target.motor_id);
  if (!motor) {
    throw std::runtime_error("Failed to get target motor: " + std::to_string(*target.motor_id));
  }
  return BenchContext{motor, CreateSyntheticCongestionMotors(bus, options)};
}

BenchContext PrepareScanLevelBench(encos::BaseAdapter& adapter, const BenchTarget& target,
                                   const BenchOptions& /*options*/) {
  auto scanned = ScanAdapterMotors(adapter, target.bus_id);
  if (scanned.empty()) {
    throw std::runtime_error("No motors found for bench target");
  }
  const ScannedMotor& benchmark = scanned.front();
  std::vector<encos::Motor*> congestion_motors;
  congestion_motors.reserve(scanned.size() - 1U);
  for (std::size_t index = 1; index < scanned.size(); ++index) {
    congestion_motors.push_back(scanned[index].motor);
  }
  return BenchContext{benchmark.motor, congestion_motors};
}

}  // namespace

void ConfigureBenchCommand(argparse::ArgumentParser& parser) {
  parser.add_description("Benchmark a single adapter, bus, or motor");
  AddAdapterArgument(parser);
  parser.add_argument("--plugin-path").help("Override plugin directory path").metavar("PATH");
  parser.add_argument("--congestion-motor-count")
      .help(
          "Number of synthetic congestion motors when target is MotorId-level (ignored for adapter/bus-level targets)")
      .default_value(std::string("2"))
      .metavar("N");
  parser.add_argument("--congestion-motor-base-id")
      .help("Base motor id for synthetic congestion motors")
      .default_value(std::string("0x700"))
      .metavar("ID");
  parser.add_argument("--min-packet-threshold")
      .help("Minimum sample count before drop-rate threshold applies")
      .default_value(std::string("50"))
      .metavar("N");
  parser.add_argument("--max-drop-count-before-threshold")
      .help("Maximum drop count allowed before min packet threshold")
      .default_value(std::string("5"))
      .metavar("N");
  parser.add_argument("--max-drop-rate-after-threshold")
      .help("Maximum drop rate allowed after min packet threshold")
      .default_value(std::string("0.1"))
      .metavar("RATE");
}

int RunBenchCommand(const argparse::ArgumentParser& parser) {
  const auto options = ParseBenchOptions(parser);

  ConfigureRealtimeHints();

  const auto raw_links = parser.get<std::vector<std::string>>("link");
  if (raw_links.size() != 1U) {
    throw std::runtime_error("bench requires exactly one link");
  }
  const BenchTarget target = ParseBenchTarget(raw_links[0]);

  encos::BaseAdapterPtr adapter =
      encos::MakeAdapter(target.adapter_type, target.adapter_id,
                         motor_cli::GetLoggerName(target.adapter_type, target.adapter_id), encos::LogLevel::Warn);
  if (!adapter) {
    throw std::runtime_error("Failed to create adapter for link: '" + target.adapter_type + ":" + target.adapter_id +
                             "'");
  }

  std::this_thread::sleep_for(std::chrono::seconds(1));

  const BenchContext context = target.motor_id.has_value() ? PrepareMotorLevelBench(*adapter, target, options)
                                                           : PrepareScanLevelBench(*adapter, target, options);

  std::cout << "Benchmark motor: CanFD=" << std::boolalpha << context.benchmark_motor->IsCanFdEnabled()
            << " CanEFF=" << context.benchmark_motor->IsCanEffEnabled() << std::endl;
  std::cout << "Congestion motors: " << context.congestion_motors.size() << std::endl;
  std::cout << std::endl;

  auto bench = ankerl::nanobench::Bench()
                   .performanceCounters(false)
                   .timeUnit(std::chrono::microseconds(1), "us")
                   .minEpochIterations(100);

  std::vector<DropStats> drop_stats;
  drop_stats.push_back(RunBenchmark(bench, "duplicate_delay", "Duplicate", context.benchmark_motor, options,
                                    ReadPattern::kPositionOnly));
  drop_stats.push_back(RunBenchmark(bench, "idle_delay", "Idle", context.benchmark_motor, options));

  std::atomic<bool> running{true};
  std::atomic<int> wait{10};
  std::optional<std::thread> congestion_thread;
  if (!context.congestion_motors.empty()) {
    congestion_thread.emplace([&] {
      while (running) {
        for (encos::Motor* congestion_motor : context.congestion_motors) {
          congestion_motor->PVTControl<0>(0, 1, 0, 0, 0);
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(wait));
      }
    });
  }

  for (int delay_ms : {10, 5, 3, 2, 1}) {
    PrepareCongestionDelay(wait, delay_ms, delay_ms != 10);
    const auto delay_text = std::to_string(wait.load()) + "ms";
    drop_stats.push_back(RunBenchmark(bench, "congestion_" + delay_text + "_delay", "Congestion " + delay_text,
                                      context.benchmark_motor, options));
  }

  std::cout << std::endl << "Drop rates:" << std::endl;
  for (const auto& stats : drop_stats) {
    PrintDropStats(stats);
  }

  running = false;
  if (congestion_thread.has_value()) {
    congestion_thread->join();
  }
  return 0;
}
