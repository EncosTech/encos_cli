#include "src/cli/stress.h"

#include <encos/encos_motor.h>
#include <encos/utils/thread_priority.h>
#include <pthread.h>
#include <sched.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <unistd.h>

#include <algorithm>
#include <argparse/argparse.hpp>
#include <atomic>
#include <chrono>
#include <csignal>
#include <cstdint>
#include <cstdlib>
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
#include <utility>
#include <vector>

#include "src/cli/adapter_cli_utils.h"

namespace {

using Clock = std::chrono::steady_clock;

constexpr auto kStatusRefreshInterval = std::chrono::milliseconds(500);
constexpr auto kStopPollInterval = std::chrono::milliseconds(100);
constexpr int kSenderThreadPriority = 10;

volatile std::sig_atomic_t g_stop_requested = 0;

struct StressOptions {
  int loop_period_ms = 1;
  int warmup_delay_ms = 100;
  int drain_delay_ms = 200;
  bool no_inplace_refresh = false;
};

struct MotorContext {
  int motor_idx = -1;
  encos::Motor* motor{nullptr};
  std::atomic<std::uint64_t> sent{0};
  std::atomic<std::uint64_t> received{0};
};

struct BusContext {
  std::optional<int32_t> slave_id;
  int bus_idx = -1;
  std::vector<std::shared_ptr<MotorContext>> motors;
};

struct AdapterContext {
  std::string label;
  encos::BaseAdapterPtr adapter;
  std::vector<BusContext> buses;
};

struct Totals {
  std::uint64_t sent = 0;
  std::uint64_t received = 0;
};

struct RenderedReport {
  std::string text;
  std::size_t terminal_rows = 0;
};

struct TerminalSize {
  std::size_t columns = 0;
  std::size_t rows = 0;
};

void HandleSigInt(int) { g_stop_requested = 1; }

bool SetCurrentThreadAffinity(int cpu_index) {
  cpu_set_t cpuset;
  CPU_ZERO(&cpuset);
  CPU_SET(cpu_index, &cpuset);
  return pthread_setaffinity_np(pthread_self(), sizeof(cpu_set_t), &cpuset) == 0;
}

std::vector<int> StressSenderCpuCandidates() {
  const long cpu_count = sysconf(_SC_NPROCESSORS_ONLN);
  if (cpu_count <= 0) {
    return {};
  }

  std::vector<int> cpus;
  for (int cpu = 2; cpu < cpu_count; ++cpu) {
    cpus.push_back(cpu);
  }
  if (!cpus.empty()) {
    return cpus;
  }

  for (int cpu = 0; cpu < cpu_count; ++cpu) {
    cpus.push_back(cpu);
  }
  return cpus;
}

std::optional<int> StressSenderCpuIndex(std::size_t sender_index) {
  static const std::vector<int> candidates = StressSenderCpuCandidates();
  if (candidates.empty()) {
    return std::nullopt;
  }
  return candidates[sender_index % candidates.size()];
}

void ConfigureMemoryLockHints() {
  if (mlockall(MCL_CURRENT | MCL_FUTURE) != 0) {
    std::cerr << "Warning: Failed to lock memory pages. Run as root or with elevated privileges." << std::endl;
  }
}

void ConfigureSenderThreadHints(std::size_t sender_index) {
  if (!encos::utils::SetCurrentThreadPriority(kSenderThreadPriority)) {
    std::cerr << "Warning: Failed to set real-time scheduling. Run as root or with elevated "
                 "privileges."
              << std::endl;
  }

  const auto cpu_index = StressSenderCpuIndex(sender_index);
  if (cpu_index.has_value() && !SetCurrentThreadAffinity(*cpu_index)) {
    std::cerr << "Warning: Failed to set CPU affinity for sender thread" << ". Run as root or with elevated privileges."
              << std::endl;
  }

  ConfigureMemoryLockHints();
}

int ParseInt(const argparse::ArgumentParser& parser, const std::string& key) {
  std::size_t pos = 0;
  const auto value = parser.get<std::string>(key);
  const int parsed = std::stoi(value, &pos, 10);
  if (pos != value.size()) {
    throw std::runtime_error("Invalid integer for " + key + ": '" + value + "'");
  }
  return parsed;
}

StressOptions ParseStressOptions(const argparse::ArgumentParser& parser) {
  StressOptions options;
  options.loop_period_ms = ParseInt(parser, "--loop-period-ms");
  options.warmup_delay_ms = ParseInt(parser, "--warmup-delay-ms");
  options.drain_delay_ms = ParseInt(parser, "--drain-delay-ms");
  options.no_inplace_refresh = parser.get<bool>("--no-inplace-refresh");

  if (options.loop_period_ms < 1) {
    throw std::runtime_error("--loop-period-ms must be >= 1");
  }
  if (options.warmup_delay_ms < 0) {
    throw std::runtime_error("--warmup-delay-ms must be >= 0");
  }
  if (options.drain_delay_ms < 0) {
    throw std::runtime_error("--drain-delay-ms must be >= 0");
  }

  return options;
}

std::vector<std::pair<int, encos::Bus*>> SortBuses(const std::unordered_map<int, encos::Bus*>& buses) {
  std::vector<std::pair<int, encos::Bus*>> result(buses.begin(), buses.end());
  std::sort(result.begin(), result.end(), [](const auto& lhs, const auto& rhs) { return lhs.first < rhs.first; });
  return result;
}

std::vector<std::pair<int, encos::Motor*>> SortMotors(const std::unordered_map<int, encos::Motor*>& motors) {
  std::vector<std::pair<int, encos::Motor*>> result(motors.begin(), motors.end());
  std::sort(result.begin(), result.end(), [](const auto& lhs, const auto& rhs) { return lhs.first < rhs.first; });
  return result;
}

BusContext DiscoverBusContext(const motor_cli::StressBusAddress& address, encos::Bus* bus,
                              [[maybe_unused]] const StressOptions& options) {
  BusContext bus_context;
  bus_context.slave_id = address.slave_id;
  bus_context.bus_idx = address.bus_id;

  auto sorted_motors = SortMotors(bus->ScanMotors());
  for (const auto& [motor_idx, motor] : sorted_motors) {
    auto motor_context = std::make_shared<MotorContext>();
    motor_context->motor_idx = motor_idx;
    motor_context->motor = motor;
    bus_context.motors.push_back(std::move(motor_context));
  }

  return bus_context;
}

AdapterContext DiscoverAdapterContext(const PreparedAdapter& prepared, const StressOptions& options) {
  AdapterContext adapter_context;
  adapter_context.label = prepared.label;
  adapter_context.adapter = prepared.adapter;

  auto sorted_buses = SortBuses(prepared.adapter->GetBuses());

  std::vector<std::future<BusContext>> bus_futures;
  bus_futures.reserve(sorted_buses.size());
  for (const auto& bus_pair : sorted_buses) {
    encos::Bus* bus = bus_pair.second;
    const motor_cli::StressBusAddress address = motor_cli::DecodeStressBusAddress(bus_pair.first);
    bus_futures.push_back(std::async(std::launch::async,
                                     [address, bus, &options]() { return DiscoverBusContext(address, bus, options); }));
  }

  adapter_context.buses.reserve(bus_futures.size());
  for (auto& future : bus_futures) {
    adapter_context.buses.push_back(future.get());
  }

  std::sort(adapter_context.buses.begin(), adapter_context.buses.end(),
            [](const BusContext& lhs, const BusContext& rhs) {
              if (lhs.slave_id.value_or(-1) != rhs.slave_id.value_or(-1)) {
                return lhs.slave_id.value_or(-1) < rhs.slave_id.value_or(-1);
              }
              return lhs.bus_idx < rhs.bus_idx;
            });
  return adapter_context;
}

std::vector<AdapterContext> BuildContexts(const std::vector<PreparedAdapter>& prepared_adapters,
                                          const StressOptions& options) {
  std::vector<std::future<AdapterContext>> adapter_futures;
  adapter_futures.reserve(prepared_adapters.size());

  for (const auto& prepared : prepared_adapters) {
    adapter_futures.push_back(
        std::async(std::launch::async, [&prepared, &options]() { return DiscoverAdapterContext(prepared, options); }));
  }

  std::vector<AdapterContext> contexts;
  contexts.reserve(adapter_futures.size());
  for (auto& future : adapter_futures) {
    contexts.push_back(future.get());
  }

  std::sort(contexts.begin(), contexts.end(),
            [](const AdapterContext& lhs, const AdapterContext& rhs) { return lhs.label < rhs.label; });

  return contexts;
}

void PrintDiscovery(const std::vector<AdapterContext>& contexts) {
  for (const AdapterContext& adapter : contexts) {
    std::cout << "Adapter " << adapter.label << " buses: " << adapter.buses.size() << std::endl;
    for (const BusContext& bus : adapter.buses) {
      const motor_cli::StressBusAddress address{bus.slave_id, bus.bus_idx};
      std::cout << "  " << motor_cli::FormatStressBusLabel(address) << " motors: " << bus.motors.size() << std::endl;
      for (const auto& motor : bus.motors) {
        std::cout << "    Motor " << motor->motor_idx << " CanFD: " << std::boolalpha << motor->motor->IsCanFdEnabled()
                  << " CanEFF: " << motor->motor->IsCanEffEnabled() << std::noboolalpha << std::endl;
      }
    }
  }
}

bool HasAnyMotor(const std::vector<AdapterContext>& contexts) {
  for (const auto& adapter : contexts) {
    for (const auto& bus : adapter.buses) {
      if (!bus.motors.empty()) {
        return true;
      }
    }
  }
  return false;
}

void RegisterCallbacks(const std::vector<AdapterContext>& contexts, const std::atomic<bool>& measurement_active) {
  for (const auto& adapter : contexts) {
    for (const auto& bus : adapter.buses) {
      for (const auto& motor : bus.motors) {
        motor->motor->SetOnStatus([motor, &measurement_active](const encos::MotorStatus&) {
          if (measurement_active.load(std::memory_order_relaxed)) {
            motor->received.fetch_add(1, std::memory_order_relaxed);
          }
        });
      }
    }
  }
}

void UnregisterCallbacks(const std::vector<AdapterContext>& contexts) {
  for (const auto& adapter : contexts) {
    for (const auto& bus : adapter.buses) {
      for (const auto& motor : bus.motors) {
        motor->motor->SetOnStatus(nullptr);
      }
    }
  }
}

void ResetCounters(const std::vector<AdapterContext>& contexts) {
  for (const auto& adapter : contexts) {
    for (const auto& bus : adapter.buses) {
      for (const auto& motor : bus.motors) {
        motor->sent.store(0, std::memory_order_relaxed);
        motor->received.store(0, std::memory_order_relaxed);
      }
    }
  }
}

Totals AggregateMotors(const std::vector<std::shared_ptr<MotorContext>>& motors) {
  Totals totals;
  for (const auto& motor : motors) {
    totals.sent += motor->sent.load(std::memory_order_relaxed);
    totals.received += motor->received.load(std::memory_order_relaxed);
  }
  return totals;
}

Totals AggregateBus(const BusContext& bus) { return AggregateMotors(bus.motors); }

Totals AggregateAdapter(const AdapterContext& adapter) {
  Totals totals;
  for (const auto& bus : adapter.buses) {
    auto bus_totals = AggregateBus(bus);
    totals.sent += bus_totals.sent;
    totals.received += bus_totals.received;
  }
  return totals;
}

Totals AggregateAll(const std::vector<AdapterContext>& contexts) {
  Totals totals;
  for (const auto& adapter : contexts) {
    auto adapter_totals = AggregateAdapter(adapter);
    totals.sent += adapter_totals.sent;
    totals.received += adapter_totals.received;
  }
  return totals;
}

std::uint64_t DropCount(const Totals& totals) {
  return totals.sent > totals.received ? (totals.sent - totals.received) : 0;
}

double DropRate(const Totals& totals) {
  return totals.sent == 0 ? 0.0 : static_cast<double>(DropCount(totals)) / totals.sent;
}

double ActualFps(const Totals& totals, double measurement_seconds) {
  return measurement_seconds <= 0.0 ? 0.0 : static_cast<double>(totals.received) / measurement_seconds;
}

void AppendStatsLine(std::ostringstream& output, const std::string& label, const Totals& totals,
                     double measurement_seconds, int indent_level) {
  const std::string indent(static_cast<std::size_t>(indent_level) * 2, ' ');
  output << indent << label << ": drop_rate=" << std::fixed << std::setprecision(2) << DropRate(totals) * 100.0
         << "% drop=" << DropCount(totals) << "/" << totals.sent << " actual_fps=" << std::setprecision(2)
         << ActualFps(totals, measurement_seconds) << '\n';
}

std::string RenderReportText(const std::string& title, const std::vector<AdapterContext>& contexts,
                             double measurement_seconds, motor_cli::StressLiveDetailLevel detail_level) {
  const auto overall = AggregateAll(contexts);
  std::ostringstream output;

  if (detail_level == motor_cli::StressLiveDetailLevel::Overview) {
    AppendStatsLine(output, "Overview", overall, measurement_seconds, 0);
    auto text = output.str();
    text.pop_back();
    return text;
  }

  output << title << '\n';
  output << "Measurement seconds: " << std::fixed << std::setprecision(3) << measurement_seconds << '\n';
  AppendStatsLine(output, "Overview", overall, measurement_seconds, 0);

  for (const auto& adapter : contexts) {
    const auto adapter_totals = AggregateAdapter(adapter);
    AppendStatsLine(output, "Adapter " + adapter.label, adapter_totals, measurement_seconds, 1);

    if (detail_level == motor_cli::StressLiveDetailLevel::Adapter) {
      continue;
    }
    for (const auto& bus : adapter.buses) {
      const auto bus_totals = AggregateBus(bus);
      AppendStatsLine(output, motor_cli::FormatStressBusLabel({bus.slave_id, bus.bus_idx}), bus_totals,
                      measurement_seconds, 2);

      if (detail_level == motor_cli::StressLiveDetailLevel::Bus) {
        continue;
      }
      for (const auto& motor : bus.motors) {
        const Totals motor_totals{
            motor->sent.load(std::memory_order_relaxed),
            motor->received.load(std::memory_order_relaxed),
        };
        AppendStatsLine(output, "Motor " + std::to_string(motor->motor_idx), motor_totals, measurement_seconds, 3);
      }
    }
  }

  auto text = output.str();
  if (!text.empty() && text.back() == '\n') {
    text.pop_back();
  }
  return text;
}

std::optional<TerminalSize> GetTerminalSize() {
  struct winsize size {};
  if (ioctl(STDOUT_FILENO, TIOCGWINSZ, &size) != 0 || size.ws_col == 0 || size.ws_row == 0) {
    return std::nullopt;
  }
  return TerminalSize{size.ws_col, size.ws_row};
}

RenderedReport RenderLiveReport(const std::vector<AdapterContext>& contexts, double measurement_seconds,
                                const TerminalSize& terminal_size) {
  constexpr const char* kTitle = "===== LIVE STATUS (Press Ctrl+C to stop) =====";
  const auto full = RenderReportText(kTitle, contexts, measurement_seconds, motor_cli::StressLiveDetailLevel::Full);
  const auto bus = RenderReportText(kTitle, contexts, measurement_seconds, motor_cli::StressLiveDetailLevel::Bus);
  const auto adapter =
      RenderReportText(kTitle, contexts, measurement_seconds, motor_cli::StressLiveDetailLevel::Adapter);
  const auto overview =
      RenderReportText(kTitle, contexts, measurement_seconds, motor_cli::StressLiveDetailLevel::Overview);

  const motor_cli::StressLiveReportRows rows{
      motor_cli::CountStressTerminalRows(full, terminal_size.columns),
      motor_cli::CountStressTerminalRows(bus, terminal_size.columns),
      motor_cli::CountStressTerminalRows(adapter, terminal_size.columns),
      motor_cli::CountStressTerminalRows(overview, terminal_size.columns),
  };

  if (rows.overview >= terminal_size.rows) {
    return {};
  }

  switch (motor_cli::SelectStressLiveDetailLevel(terminal_size.rows, rows)) {
    case motor_cli::StressLiveDetailLevel::Full:
      return {full, rows.full};
    case motor_cli::StressLiveDetailLevel::Bus:
      return {bus, rows.bus};
    case motor_cli::StressLiveDetailLevel::Adapter:
      return {adapter, rows.adapter};
    case motor_cli::StressLiveDetailLevel::Overview:
      return {overview, rows.overview};
  }
  return {overview, rows.overview};
}

bool SupportsInPlaceRefresh() {
  if (isatty(STDOUT_FILENO) == 0) {
    return false;
  }

  const char* term = std::getenv("TERM");
  return term != nullptr && std::string(term) != "dumb" && GetTerminalSize().has_value();
}

class AlternateScreenGuard {
public:
  explicit AlternateScreenGuard(bool enabled) : active_(enabled) {
    if (active_) {
      std::cout << motor_cli::StressAlternateScreenEnterSequence() << std::flush;
    }
  }

  ~AlternateScreenGuard() { Leave(); }

  void Leave() {
    if (!active_) {
      return;
    }
    std::cout << motor_cli::StressAlternateScreenLeaveSequence() << std::flush;
    active_ = false;
  }

private:
  bool active_ = false;
};

void PrintReportSnapshot(const RenderedReport& report, bool in_place_refresh, bool* has_appended_report) {
  if (in_place_refresh) {
    std::cout << motor_cli::BuildStressInPlaceRefreshPrefix() << report.text << std::flush;
    return;
  }

  if (*has_appended_report) {
    std::cout << '\n';
  }
  std::cout << report.text << std::flush;
  *has_appended_report = !report.text.empty();
}

void SenderLoop(const AdapterContext& adapter, const StressOptions& options, const std::atomic<bool>& stop_requested,
                std::size_t sender_index) {
  ConfigureSenderThreadHints(sender_index);
  auto next_tick = Clock::now();
  const auto loop_period = std::chrono::milliseconds(options.loop_period_ms);
  while (!stop_requested.load(std::memory_order_relaxed)) {
    for (const auto& bus : adapter.buses) {
      for (const auto& motor : bus.motors) {
        motor->motor->PVTControl<0>(0.0f, 1.0f, 0.0f, 0.0f, 0.0f);
        motor->sent.fetch_add(1, std::memory_order_relaxed);
      }
    }
    adapter.adapter->Commit();

    next_tick += loop_period;
    const auto now = Clock::now();
    if (next_tick > now) {
      std::this_thread::sleep_until(next_tick);
    } else {
      next_tick = now;
    }
  }
}

}  // namespace

namespace motor_cli {

std::size_t CountStressTerminalRows(const std::string& text, std::size_t terminal_columns) {
  if (text.empty() || terminal_columns == 0) {
    return 0;
  }

  std::size_t rows = 0;
  std::size_t line_length = 0;
  for (const char character : text) {
    if (character == '\n') {
      rows += std::max<std::size_t>(1, (line_length + terminal_columns - 1) / terminal_columns);
      line_length = 0;
      continue;
    }
    ++line_length;
  }
  rows += std::max<std::size_t>(1, (line_length + terminal_columns - 1) / terminal_columns);
  return rows;
}

StressBusAddress DecodeStressBusAddress(int adapter_bus_id) {
  if (adapter_bus_id > 0xFFFF) {
    return {adapter_bus_id >> 16, adapter_bus_id & 0xFFFF};
  }
  return {std::nullopt, adapter_bus_id};
}

std::string FormatStressBusLabel(const StressBusAddress& address) {
  if (address.slave_id.has_value()) {
    return "Slave " + std::to_string(*address.slave_id) + " Bus " + std::to_string(address.bus_id);
  }
  return "Bus " + std::to_string(address.bus_id);
}

std::string StressAlternateScreenEnterSequence() { return "\033[?1049h"; }

std::string BuildStressInPlaceRefreshPrefix() { return "\033[H\033[2J"; }

std::string StressAlternateScreenLeaveSequence() { return "\033[?1049l"; }

StressLiveDetailLevel SelectStressLiveDetailLevel(std::size_t terminal_rows, const StressLiveReportRows& report_rows) {
  if (report_rows.full < terminal_rows) {
    return StressLiveDetailLevel::Full;
  }
  if (report_rows.bus < terminal_rows) {
    return StressLiveDetailLevel::Bus;
  }
  if (report_rows.adapter < terminal_rows) {
    return StressLiveDetailLevel::Adapter;
  }
  return StressLiveDetailLevel::Overview;
}

}  // namespace motor_cli

void ConfigureStressCommand(argparse::ArgumentParser& parser) {
  parser.add_description("Stress test one or more adapters");
  AddAdapterArgument(parser);
  parser.add_argument("--plugin-path").help("Override plugin directory path").metavar("PATH");
  parser.add_argument("--loop-period-ms")
      .help("Sender loop period in milliseconds")
      .default_value(std::string("1"))
      .metavar("MS");
  parser.add_argument("--warmup-delay-ms")
      .help("Warmup delay before counters reset")
      .default_value(std::string("100"))
      .metavar("MS");
  parser.add_argument("--drain-delay-ms")
      .help("Drain delay after sender threads stop")
      .default_value(std::string("200"))
      .metavar("MS");
  parser.add_argument("--no-inplace-refresh")
      .help("Disable in-place live refresh and append status snapshots instead")
      .flag();
}

int RunStressCommand(const argparse::ArgumentParser& parser) {
  const auto options = ParseStressOptions(parser);

  ConfigureMemoryLockHints();

  auto prepared_adapters = LoadAdaptersFromArgs(parser, encos::LogLevel::Warn);
  if (prepared_adapters.empty()) {
    std::cerr << "No adapters resolved from link." << std::endl;
    return 1;
  }

  std::this_thread::sleep_for(std::chrono::seconds(1));

  std::vector<AdapterContext> contexts;
  try {
    contexts = BuildContexts(prepared_adapters, options);
  } catch (const std::exception& ex) {
    std::cerr << "Failed to discover buses or motors: " << ex.what() << std::endl;
    return 1;
  }

  PrintDiscovery(contexts);

  if (!HasAnyMotor(contexts)) {
    std::cerr << "No motors found across all adapters." << std::endl;
    return 1;
  }

  std::atomic<bool> measurement_active{false};
  std::atomic<bool> stop_requested{false};
  RegisterCallbacks(contexts, measurement_active);

  std::cout << std::endl;

  std::this_thread::sleep_for(std::chrono::milliseconds(options.warmup_delay_ms));
  ResetCounters(contexts);

  if (std::signal(SIGINT, HandleSigInt) == SIG_ERR) {
    std::cerr << "Failed to register SIGINT handler." << std::endl;
    UnregisterCallbacks(contexts);
    return 1;
  }

  g_stop_requested = 0;
  const bool in_place_refresh = !options.no_inplace_refresh && SupportsInPlaceRefresh();
  AlternateScreenGuard alternate_screen(in_place_refresh);
  bool has_appended_report = false;
  const auto measurement_start = Clock::now();
  measurement_active.store(true, std::memory_order_relaxed);

  std::vector<std::thread> sender_threads;
  sender_threads.reserve(contexts.size());
  for (std::size_t index = 0; index < contexts.size(); ++index) {
    const auto& adapter = contexts[index];
    const AdapterContext* adapter_ptr = &adapter;
    sender_threads.emplace_back([adapter_ptr, &options, &stop_requested, index]() {
      SenderLoop(*adapter_ptr, options, stop_requested, index);
    });
  }

  auto last_report_time = measurement_start - kStatusRefreshInterval;
  while (g_stop_requested == 0) {
    const auto now = Clock::now();
    if (now - last_report_time >= kStatusRefreshInterval) {
      const double measurement_seconds =
          std::chrono::duration_cast<std::chrono::duration<double>>(now - measurement_start).count();
      if (in_place_refresh) {
        const auto terminal_size = GetTerminalSize();
        if (terminal_size.has_value()) {
          PrintReportSnapshot(RenderLiveReport(contexts, measurement_seconds, *terminal_size), true,
                              &has_appended_report);
        }
      } else {
        const auto text = RenderReportText("===== LIVE STATUS (Press Ctrl+C to stop) =====", contexts,
                                           measurement_seconds, motor_cli::StressLiveDetailLevel::Full);
        PrintReportSnapshot({text, 0}, false, &has_appended_report);
      }
      last_report_time = now;
    }

    std::this_thread::sleep_for(kStopPollInterval);
  }

  stop_requested.store(true, std::memory_order_relaxed);
  for (auto& thread : sender_threads) {
    thread.join();
  }

  const auto measurement_end = Clock::now();
  const double measurement_seconds =
      std::chrono::duration_cast<std::chrono::duration<double>>(measurement_end - measurement_start).count();

  const auto before_drain = AggregateAll(contexts);
  std::this_thread::sleep_for(std::chrono::milliseconds(options.drain_delay_ms));
  measurement_active.store(false, std::memory_order_relaxed);
  UnregisterCallbacks(contexts);

  alternate_screen.Leave();
  const auto after_drain = AggregateAll(contexts);
  std::cout << "\nDrain wait: " << options.drain_delay_ms
            << " ms; additional replies: " << (after_drain.received - before_drain.received)
            << "; outstanding before/after: " << DropCount(before_drain) << "/" << DropCount(after_drain) << '\n';
  const auto final_text = RenderReportText("================ FINAL RESULT ================", contexts,
                                           measurement_seconds, motor_cli::StressLiveDetailLevel::Full);
  PrintReportSnapshot({final_text, 0}, false, &has_appended_report);
  return 0;
}
