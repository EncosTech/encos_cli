#include "src/cli/play.h"

#include <encos/adapter/fake_adapter_control.h>
#include <encos/encos_motor.h>
#include <unistd.h>

#include <algorithm>
#include <argparse/argparse.hpp>
#include <atomic>
#include <cctype>
#include <chrono>
#include <cmath>
#include <csignal>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <future>
#include <iomanip>
#include <iostream>
#include <limits>
#include <memory>
#include <mutex>
#include <optional>
#include <sstream>
#include <string_view>
#include <thread>
#include <tuple>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "ftxui/component/component.hpp"
#include "ftxui/component/event.hpp"
#include "ftxui/component/mouse.hpp"
#include "ftxui/component/screen_interactive.hpp"
#include "ftxui/dom/elements.hpp"
#include "ftxui/dom/table.hpp"
#include "ftxui/screen/box.hpp"
#include "ftxui/screen/color.hpp"
#include "ftxui/screen/screen.hpp"
#include "src/calibration_config.h"
#include "src/trajectory_csv_parser.h"

namespace {

constexpr int kDefaultControlFrequencyHz = 1000;
constexpr int kMaximumControlFrequencyHz = 1000000000;
constexpr auto kControlPeriod = std::chrono::microseconds(1000);
constexpr auto kStatusPollPeriod = std::chrono::milliseconds(500);
constexpr auto kTuiRefreshPeriod = std::chrono::milliseconds(50);
constexpr auto kStartupTransitionDuration = std::chrono::seconds(2);
constexpr auto kReturnTransitionDuration = std::chrono::seconds(2);
constexpr auto kStressDrainDelay = std::chrono::milliseconds(500);
constexpr float kDefaultMaxSpeedRadS = 20.0f;
constexpr float kDefaultMaxCurrentA = 10.0f;
constexpr double kDegreesToRadians = M_PI / 180.0;
constexpr double kRadiansToDegrees = 180.0 / M_PI;
std::atomic<int> g_play_stop_requests{0};

void ClampPlayTuiScroll(PlayTuiState& state) {
  const int max_x = std::max(0, state.content_width - state.viewport_width);
  const int max_y = std::max(0, state.content_height - state.viewport_height);
  state.scroll_x = std::clamp(state.scroll_x, 0, max_x);
  state.scroll_y = std::clamp(state.scroll_y, 0, max_y);
}

int BoxWidth(const ftxui::Box& box) { return box.x_max >= box.x_min ? box.x_max - box.x_min + 1 : 0; }

int BoxHeight(const ftxui::Box& box) { return box.y_max >= box.y_min ? box.y_max - box.y_min + 1 : 0; }

void HandlePlayInterrupt(int) { g_play_stop_requests.fetch_add(1); }

void HandlePlayTerminate(int) { g_play_stop_requests.store(2); }

class SignalGuard {
public:
  SignalGuard(int signal, void (*handler)(int)) : signal_(signal), previous_handler_(std::signal(signal, handler)) {}
  ~SignalGuard() { std::signal(signal_, previous_handler_); }

  SignalGuard(const SignalGuard&) = delete;
  SignalGuard& operator=(const SignalGuard&) = delete;

private:
  int signal_;
  void (*previous_handler_)(int);
};

float DegreesToRadians(float value_deg) { return static_cast<float>(value_deg * kDegreesToRadians); }

std::string FormatTime(double value_s) {
  std::ostringstream stream;
  stream << std::fixed << std::setprecision(3) << value_s;
  return stream.str();
}

std::string SanitizeLogName(const std::string& value) {
  std::string result;
  result.reserve(value.size());
  for (const unsigned char character : value) {
    result += std::isalnum(character) != 0 ? static_cast<char>(character) : '_';
  }
  return result;
}

std::string FormatMotorTargetPrefix(const std::string& adapter_type, const std::string& adapter_id,
                                    std::optional<int32_t> slave_id, int32_t bus_id) {
  std::ostringstream output;
  output << adapter_type << ':' << adapter_id << ':';
  if (slave_id.has_value()) {
    output << *slave_id << ':';
  }
  output << bus_id;
  return output.str();
}

std::string FormatMotorTargetPrefix(const emzero::MotorConnection& connection) {
  return FormatMotorTargetPrefix(connection.adapter_type, connection.adapter_id, connection.slave_id,
                                 connection.bus_id);
}

std::string FormatMotorTargetPrefix(const emzero::AdapterKey& key, int adapter_bus_id) {
  if (adapter_bus_id > 0xFFFF) {
    return FormatMotorTargetPrefix(key.type, key.id, adapter_bus_id >> 16, adapter_bus_id & 0xFFFF);
  }
  return FormatMotorTargetPrefix(key.type, key.id, std::nullopt, adapter_bus_id);
}

struct MotorContext {
  encos::Motor* motor{nullptr};
  std::string name;
  std::string adapter_type;
  std::string adapter_id;
  std::optional<int32_t> slave_id;
  int32_t bus_id{0};
  int32_t motor_id{0};
  float kt{std::numeric_limits<float>::quiet_NaN()};
  std::atomic<std::uint64_t> sent{0};
  std::atomic<std::uint64_t> received{0};
  PlayLossWindow loss_window;
};

struct BusScanResult {
  encos::Bus* bus{nullptr};
  std::unordered_map<int, encos::Motor*> motors;
};

struct HoldingMotorContext {
  std::shared_ptr<MotorContext> context;
  float position_rad{0.0f};
};

struct MotorLocation {
  std::string adapter_type;
  std::string adapter_id;
  std::optional<int32_t> slave_id;
  int32_t bus_id{0};
};

class TrajectoryRunner {
public:
  TrajectoryRunner(bool dry_run, float max_speed_rad_s, float max_current_a, std::optional<float> kp = std::nullopt,
                   std::optional<float> kd = std::nullopt, std::optional<float> vel = std::nullopt,
                   std::optional<float> tor = std::nullopt, int control_frequency_hz = kDefaultControlFrequencyHz,
                   bool tui = false, std::optional<std::string> log_directory = std::nullopt)
      : dry_run_(dry_run),
        max_speed_rad_s_(max_speed_rad_s),
        max_current_a_(max_current_a),
        kp_(kp),
        kd_(kd),
        vel_(vel),
        tor_(tor),
        tui_(tui),
        log_directory_(std::move(log_directory)),
        control_period_(std::chrono::duration_cast<std::chrono::steady_clock::duration>(
            std::chrono::duration<double>(1.0 / static_cast<double>(control_frequency_hz)))) {}

  ~TrajectoryRunner() {
    DisableStressCallbacks();
    static_cast<void>(DisableLogs());
  }

  bool Initialize(const emplay::Trajectory& trajectory) {
    std::vector<encos::Bus*> trajectory_buses;
    std::unordered_map<encos::Bus*, std::string> bus_prefixes;
    std::unordered_map<encos::Bus*, MotorLocation> bus_locations;
    trajectory_buses.reserve(trajectory.motor_connections.size());
    for (std::size_t index = 0; index < trajectory.motor_connections.size(); ++index) {
      const emzero::MotorConnection& connection = trajectory.motor_connections[index];
      const emzero::AdapterKey key{connection.adapter_type, connection.adapter_id};
      auto adapter_it = adapters_.find(key);
      if (adapter_it == adapters_.end()) {
        encos::BaseAdapterPtr adapter =
            encos::MakeAdapter(dry_run_ ? "Fake" : key.type, key.id, key.id, encos::LogLevel::Off);
        if (!adapter) {
          std::cerr << "Failed to create adapter for " << trajectory.motor_names[index] << "\n";
          return false;
        }
        if (dry_run_) {
          encos::FakeAdapterControl* fake_control = adapter->GetFakeAdapterControl();
          if (fake_control) {
            fake_control->EnableAutoCreateMotor();
            fake_control->EnablePositionError(false);
          }
        }
        adapter_it = adapters_.emplace(key, std::move(adapter)).first;
      }

      try {
        encos::Bus* bus = nullptr;
        if (connection.slave_id.has_value()) {
          bus = adapter_it->second->GetBus(*connection.slave_id, connection.bus_id);
        } else {
          bus = adapter_it->second->GetBus(connection.bus_id);
        }
        if (!bus) {
          std::cerr << "Failed to get bus for " << trajectory.motor_names[index] << "\n";
          return false;
        }

        trajectory_buses.push_back(bus);
        bus_prefixes.emplace(bus, FormatMotorTargetPrefix(connection));
        bus_locations.emplace(
            bus, MotorLocation{connection.adapter_type, connection.adapter_id, connection.slave_id, connection.bus_id});
      } catch (const std::exception& error) {
        std::cerr << "Failed to initialize " << trajectory.motor_names[index] << ": " << error.what() << "\n";
        return false;
      }
    }

    for (const auto& [key, adapter] : adapters_) {
      for (const auto& [adapter_bus_id, bus] : adapter->GetBuses()) {
        if (bus != nullptr) {
          bus_prefixes.emplace(bus, FormatMotorTargetPrefix(key, adapter_bus_id));
          const std::optional<int32_t> slave_id =
              adapter_bus_id > 0xFFFF ? std::optional<int32_t>{adapter_bus_id >> 16} : std::nullopt;
          const int32_t bus_id = adapter_bus_id > 0xFFFF ? adapter_bus_id & 0xFFFF : adapter_bus_id;
          bus_locations.emplace(bus, MotorLocation{key.type, key.id, slave_id, bus_id});
        }
      }
    }

    const auto discovered_motors = ScanMotors(trajectory, trajectory_buses);
    std::unordered_set<encos::Motor*> trajectory_motors;
    for (std::size_t index = 0; index < trajectory.motor_connections.size(); ++index) {
      const emzero::MotorConnection& connection = trajectory.motor_connections[index];
      const auto bus_iterator = discovered_motors.find(trajectory_buses[index]);
      if (bus_iterator == discovered_motors.end()) {
        throw std::runtime_error("Required motor '" + trajectory.motor_names[index] + "' was not found during scan");
      }

      const auto motor_iterator = bus_iterator->second.find(trajectory.motor_connections[index].motor_id);
      if (motor_iterator == bus_iterator->second.end() || motor_iterator->second == nullptr) {
        throw std::runtime_error("Required motor '" + trajectory.motor_names[index] + "' was not found during scan");
      }

      encos::Motor* motor = motor_iterator->second;
      trajectory_motors.insert(motor);
      auto motor_context = std::make_shared<MotorContext>();
      motor_context->motor = motor;
      motor_context->name = trajectory.motor_names[index];
      motor_context->adapter_type = connection.adapter_type;
      motor_context->adapter_id = connection.adapter_id;
      motor_context->slave_id = connection.slave_id;
      motor_context->bus_id = connection.bus_id;
      motor_context->motor_id = connection.motor_id;
      PopulateKt(*motor_context);
      motor->SetOnStatus([motor_context](const encos::MotorStatus&) {
        motor_context->received.fetch_add(1, std::memory_order_relaxed);
      });
      motors_.push_back(std::move(motor_context));
      monitored_motors_.push_back(motors_.back());
    }

    for (const auto& [bus, motors] : discovered_motors) {
      static_cast<void>(bus);
      for (const auto& [motor_id, motor] : motors) {
        static_cast<void>(motor_id);
        if (motor != nullptr && trajectory_motors.find(motor) == trajectory_motors.end()) {
          auto motor_context = std::make_shared<MotorContext>();
          motor_context->motor = motor;
          motor_context->name = bus_prefixes.at(bus) + ":" + std::to_string(motor_id);
          const MotorLocation& location = bus_locations.at(bus);
          motor_context->adapter_type = location.adapter_type;
          motor_context->adapter_id = location.adapter_id;
          motor_context->slave_id = location.slave_id;
          motor_context->bus_id = location.bus_id;
          motor_context->motor_id = motor_id;
          PopulateKt(*motor_context);
          motor->SetOnStatus([motor_context](const encos::MotorStatus&) {
            motor_context->received.fetch_add(1, std::memory_order_relaxed);
          });
          holding_motors_.push_back(HoldingMotorContext{
              motor_context,
              motor->GetParameter<encos::MotorParameter::Position>(),
          });
          monitored_motors_.push_back(std::move(motor_context));
        }
      }
    }

    if (log_directory_.has_value() && !EnableLogs()) {
      DisableStressCallbacks();
      return false;
    }
    return true;
  }

  int Run(const emplay::Trajectory& trajectory, bool endless) {
    if (motors_.size() != trajectory.motor_names.size()) {
      std::cerr << "Motor initialization mismatch\n";
      return 1;
    }

    SignalGuard sigint_guard(SIGINT, HandlePlayInterrupt);
    SignalGuard sigterm_guard(SIGTERM, HandlePlayTerminate);
    g_play_stop_requests.store(0);
    if (!ReadCurrentPositions(&initial_positions_rad_, "starting")) {
      return 1;
    }
    ResetStressCounters();
    playback_paused_.store(false);
    displayed_elapsed_us_.store(0);

    enum class PlaybackPhase { Startup, Playback, Returning };
    PlaybackPhase phase = PlaybackPhase::Startup;
    auto next_tick = std::chrono::steady_clock::now();
    const auto start_time = next_tick;
    auto phase_start_time = start_time;
    auto trajectory_start_time = start_time;
    PlayPauseClock pause_clock;
    std::vector<float> return_start_positions_rad;
    std::thread status_thread;
    if (tui_) {
      status_thread = std::thread(&TrajectoryRunner::RunTuiLoop, this, std::cref(start_time));
    } else {
      status_thread = std::thread(&TrajectoryRunner::StatusLoop, this, std::cref(start_time));
    }
    while (g_play_stop_requests.load() < 2) {
      const auto loop_now = std::chrono::steady_clock::now();
      if (g_play_stop_requests.load() >= 1) {
        playback_paused_.store(false);
      }
      auto now = UpdatePlayPauseClock(pause_clock, playback_paused_.load(), loop_now);
      displayed_elapsed_us_.store(std::chrono::duration_cast<std::chrono::microseconds>(now - start_time).count(),
                                  std::memory_order_relaxed);
      if (g_play_stop_requests.load() >= 1 && phase != PlaybackPhase::Returning) {
        if (!ReadCurrentPositions(&return_start_positions_rad, "stopping")) {
          g_play_stop_requests.store(2);
          break;
        }
        if (g_play_stop_requests.load() >= 2) {
          break;
        }
        phase = PlaybackPhase::Returning;
        phase_start_time = now;
      }

      if (g_play_stop_requests.load() >= 2) {
        break;
      }
      const double phase_elapsed_s = std::chrono::duration<double>(now - phase_start_time).count();
      if (phase == PlaybackPhase::Startup) {
        SendPositions(InterpolateDegreesToRadians(initial_positions_rad_, trajectory.samples.front().positions_deg,
                                                  phase_elapsed_s / kStartupTransitionDuration.count()));
        if (phase_elapsed_s >= kStartupTransitionDuration.count()) {
          phase = PlaybackPhase::Playback;
          trajectory_start_time = now;
        }
      } else if (phase == PlaybackPhase::Returning) {
        SendPositions(InterpolatePositions(return_start_positions_rad, initial_positions_rad_,
                                           phase_elapsed_s / kReturnTransitionDuration.count()));
        if (phase_elapsed_s >= kReturnTransitionDuration.count()) {
          break;
        }
      } else {
        const double trajectory_elapsed_s = std::chrono::duration<double>(now - trajectory_start_time).count();
        const emplay::PlaybackState state = emplay::EvaluateTrajectory(trajectory, trajectory_elapsed_s, endless);
        SendInterpolatedPositions(trajectory, state);
        if (ShouldReturnToInitialPosition(state.finished, endless)) {
          return_start_positions_rad.clear();
          return_start_positions_rad.reserve(state.positions_deg.size());
          for (const float position_deg : state.positions_deg) {
            return_start_positions_rad.push_back(DegreesToRadians(position_deg));
          }
          phase = PlaybackPhase::Returning;
          phase_start_time = now;
        }
      }

      const auto loop_end = std::chrono::steady_clock::now();
      const auto overrun = emplay::GetControlLoopOverrun(next_tick + control_period_, loop_end);
      if (overrun > std::chrono::microseconds(0)) {
        PrintControlLoopWarning(std::chrono::duration<double>(loop_end - start_time).count(), overrun);
      }
      next_tick = NextPlayControlTick(next_tick, control_period_, loop_end);
      if (next_tick > loop_end) {
        std::this_thread::sleep_until(next_tick);
      }
    }

    g_play_stop_requests.store(2);
    if (status_thread.joinable()) {
      status_thread.join();
    }

    if (tui_failed_) {
      std::cerr << "TUI failed: " << tui_error_ << '\n';
    }

    std::this_thread::sleep_for(kStressDrainDelay);
    const double elapsed_s = tui_
                                 ? DisplayedElapsedSeconds()
                                 : std::chrono::duration<double>(std::chrono::steady_clock::now() - start_time).count();
    bool final_output_succeeded = true;
    if (tui_) {
      final_output_succeeded = PrintFinalTuiTable(elapsed_s);
    } else {
      PrintStressReport(elapsed_s);
    }
    DisableStressCallbacks();
    const bool logs_closed = DisableLogs();
    return !tui_failed_ && final_output_succeeded && logs_closed ? 0 : 1;
  }

private:
  bool UsePvtControl() const { return kp_.has_value() && kd_.has_value() && vel_.has_value() && tor_.has_value(); }

  double DisplayedElapsedSeconds() const {
    return static_cast<double>(displayed_elapsed_us_.load(std::memory_order_relaxed)) / 1000000.0;
  }

  void PopulateKt(MotorContext& motor) const {
    if (!tui_) {
      return;
    }
    try {
      motor.kt = motor.motor->GetParameter<encos::MotorParameter::Kt>();
    } catch (...) {
      motor.kt = std::numeric_limits<float>::quiet_NaN();
    }
  }

  std::unordered_map<encos::Bus*, std::unordered_map<int, encos::Motor*>> ScanMotors(
      const emplay::Trajectory& trajectory, const std::vector<encos::Bus*>& trajectory_buses) {
    std::vector<encos::Bus*> buses;
    std::unordered_set<encos::Bus*> unique_buses;
    for (encos::Bus* bus : trajectory_buses) {
      if (bus != nullptr && unique_buses.insert(bus).second) {
        buses.push_back(bus);
      }
    }
    for (const auto& [adapter_key, adapter] : adapters_) {
      static_cast<void>(adapter_key);
      for (const auto& [bus_id, bus] : adapter->GetBuses()) {
        static_cast<void>(bus_id);
        if (bus != nullptr && unique_buses.insert(bus).second) {
          buses.push_back(bus);
        }
      }
    }

    std::unordered_map<encos::Bus*, std::unordered_map<int, encos::Motor*>> discovered_motors;
    if (dry_run_) {
      for (std::size_t index = 0; index < trajectory.motor_connections.size(); ++index) {
        encos::Motor* motor = trajectory_buses[index]->GetMotor(trajectory.motor_connections[index].motor_id);
        if (motor != nullptr) {
          discovered_motors[trajectory_buses[index]].emplace(trajectory.motor_connections[index].motor_id, motor);
        }
      }
      return discovered_motors;
    }

    std::vector<std::future<BusScanResult>> scan_futures;
    scan_futures.reserve(buses.size());
    for (encos::Bus* bus : buses) {
      scan_futures.push_back(std::async(std::launch::async, [bus] { return BusScanResult{bus, bus->ScanMotors()}; }));
    }
    for (std::future<BusScanResult>& scan_future : scan_futures) {
      BusScanResult result = scan_future.get();
      discovered_motors.emplace(result.bus, std::move(result.motors));
    }
    return discovered_motors;
  }

  void SendHoldingPositions() {
    for (const HoldingMotorContext& holding_motor : holding_motors_) {
      holding_motor.context->motor->PosControl<0>(holding_motor.position_rad, max_speed_rad_s_, max_current_a_, 1);
      CountSent(holding_motor.context);
    }
  }

  void CommitAdapters() const {
    for (const auto& [adapter_key, adapter] : adapters_) {
      static_cast<void>(adapter_key);
      adapter->Commit();
    }
  }

  void SendPositions(const std::vector<float>& positions_rad) {
    if (UsePvtControl()) {
      for (std::size_t index = 0; index < motors_.size(); ++index) {
        motors_[index]->motor->PVTControl<0>(*kp_, *kd_, positions_rad[index], *vel_, *tor_);
        CountSent(index);
      }
    } else {
      for (std::size_t index = 0; index < motors_.size(); ++index) {
        motors_[index]->motor->PosControl<0>(positions_rad[index], max_speed_rad_s_, max_current_a_, 1);
        CountSent(index);
      }
    }
    SendHoldingPositions();
    CommitAdapters();
  }

  std::vector<float> InterpolateDegreesToRadians(const std::vector<float>& start_positions_rad,
                                                 const std::vector<float>& end_positions_deg, double progress) const {
    std::vector<float> result;
    result.reserve(start_positions_rad.size());
    const double clamped_progress = std::clamp(progress, 0.0, 1.0);
    for (std::size_t index = 0; index < start_positions_rad.size(); ++index) {
      const float end_position_rad = DegreesToRadians(end_positions_deg[index]);
      result.push_back(start_positions_rad[index] +
                       static_cast<float>((end_position_rad - start_positions_rad[index]) * clamped_progress));
    }
    return result;
  }

  std::vector<float> InterpolatePositions(const std::vector<float>& start_positions_rad,
                                          const std::vector<float>& end_positions_rad, double progress) const {
    std::vector<float> result;
    result.reserve(start_positions_rad.size());
    const double clamped_progress = std::clamp(progress, 0.0, 1.0);
    for (std::size_t index = 0; index < start_positions_rad.size(); ++index) {
      result.push_back(start_positions_rad[index] +
                       static_cast<float>((end_positions_rad[index] - start_positions_rad[index]) * clamped_progress));
    }
    return result;
  }

  bool ReadCurrentPositions(std::vector<float>* positions_rad, const char* action) const {
    positions_rad->clear();
    positions_rad->reserve(motors_.size());
    try {
      for (const auto& motor : motors_) {
        positions_rad->push_back(motor->motor->GetParameter<encos::MotorParameter::Position>());
      }
    } catch (const std::exception& error) {
      const std::string message = "Failed to read motor positions while " + std::string(action) + ": " + error.what();
      if (tui_) {
        std::lock_guard<std::mutex> lock(output_mutex_);
        tui_warning_ = message;
      } else {
        std::cerr << message << '\n';
      }
      return false;
    }
    return true;
  }

  void SendInterpolatedPositions(const emplay::Trajectory&, const emplay::PlaybackState& state) {
    if (UsePvtControl()) {
      for (std::size_t index = 0; index < motors_.size(); ++index) {
        motors_[index]->motor->PVTControl<0>(*kp_, *kd_, DegreesToRadians(state.positions_deg[index]), *vel_, *tor_);
        CountSent(index);
      }
    } else {
      for (std::size_t index = 0; index < motors_.size(); ++index) {
        motors_[index]->motor->PosControl<0>(DegreesToRadians(state.positions_deg[index]), max_speed_rad_s_,
                                             max_current_a_, 1);
        CountSent(index);
      }
    }
    SendHoldingPositions();
    CommitAdapters();
  }

  void CountSent(std::size_t index) { motors_[index]->sent.fetch_add(1, std::memory_order_relaxed); }

  void CountSent(const std::shared_ptr<MotorContext>& motor) { motor->sent.fetch_add(1, std::memory_order_relaxed); }

  void ResetStressCounters() {
    for (const auto& motor : monitored_motors_) {
      motor->sent.store(0, std::memory_order_relaxed);
      motor->received.store(0, std::memory_order_relaxed);
      motor->loss_window = PlayLossWindow{};
      motor->loss_window.Update(std::chrono::steady_clock::now(), 0, 0);
    }
  }

  bool EnableLogs() {
    if (!logging_motors_.empty()) {
      logs_enabled_ = true;
      ReportLogError("Cannot enable logs while previous motor logs are still closing");
      return false;
    }
    std::error_code error;
    std::filesystem::create_directories(*log_directory_, error);
    if (error) {
      ReportLogError("Failed to create play log directory '" + *log_directory_ + "': " + error.message());
      return false;
    }
    try {
      for (std::size_t index = 0; index < monitored_motors_.size(); ++index) {
        logging_motors_.push_back(monitored_motors_[index]);
        const std::string log_path = BuildPlayMotorLogBaseName(*log_directory_, monitored_motors_[index]->name, index);
        monitored_motors_[index]->motor->EnableLog(log_path);
        if (!monitored_motors_[index]->motor->IsLogged()) {
          ReportLogError("Failed to enable log for " + monitored_motors_[index]->name);
          DisableLogs();
          return false;
        }
      }
      logs_enabled_ = true;
    } catch (const std::exception& exception) {
      ReportLogError("Failed to enable play logs: " + std::string(exception.what()));
      DisableLogs();
      return false;
    }
    return true;
  }

  bool DisableLogs() noexcept {
    if (logging_motors_.empty()) {
      logs_enabled_ = false;
      return true;
    }
    bool success = true;
    auto motor = logging_motors_.begin();
    while (motor != logging_motors_.end()) {
      try {
        (*motor)->motor->DisableLog();
        motor = logging_motors_.erase(motor);
      } catch (const std::exception& exception) {
        try {
          ReportLogError("Failed to close log for " + (*motor)->name + ": " + exception.what());
        } catch (...) {
        }
        ++motor;
        success = false;
      } catch (...) {
        try {
          ReportLogError("Failed to close log for " + (*motor)->name + ": unknown error");
        } catch (...) {
        }
        ++motor;
        success = false;
      }
    }
    logs_enabled_ = !logging_motors_.empty();
    return success;
  }

  void ReportLogError(const std::string& message) const noexcept {
    try {
      if (tui_screen_active_.load(std::memory_order_relaxed)) {
        std::lock_guard<std::mutex> lock(output_mutex_);
        tui_warning_ = message;
        return;
      }
      std::cerr << message << '\n';
    } catch (...) {
    }
  }

  void ToggleLogsFromTui() {
    bool success = false;
    std::string message;
    if (logs_enabled_) {
      success = DisableLogs();
      message = success ? "Logging disabled" : "Failed to disable all motor logs";
    } else {
      if (!log_directory_.has_value()) {
        log_directory_ = "./logs";
      }
      success = EnableLogs();
      message = success ? "Logging enabled: " + *log_directory_ : "Failed to enable all motor logs";
    }
    if (success) {
      std::lock_guard<std::mutex> lock(output_mutex_);
      tui_warning_ = std::move(message);
    }
  }

  void DisableStressCallbacks() const {
    for (const auto& motor : monitored_motors_) {
      motor->motor->SetOnStatus(nullptr);
    }
  }

  void PrintStressReport(double elapsed_s) const {
    std::lock_guard<std::mutex> lock(output_mutex_);
    std::cout << "===== PLAY STRESS STATUS (Press Ctrl+C to stop) =====\n";
    std::cout << "Measurement seconds: " << FormatTime(elapsed_s) << '\n';
    for (const auto& motor : monitored_motors_) {
      const std::uint64_t sent = motor->sent.load(std::memory_order_relaxed);
      const std::uint64_t received = motor->received.load(std::memory_order_relaxed);
      const std::uint64_t lost = sent > received ? sent - received : 0;
      const double loss_percent = sent == 0 ? 0.0 : static_cast<double>(lost) * 100.0 / static_cast<double>(sent);
      std::cout << "Motor " << motor->name << ": sent=" << sent << " received=" << received << " lost=" << lost
                << " loss=" << std::fixed << std::setprecision(2) << loss_percent << "%\n";
    }
    std::cout << std::flush;
  }

  std::vector<PlayMotorSnapshot> CaptureSnapshots() const {
    std::vector<PlayMotorSnapshot> snapshots;
    snapshots.reserve(monitored_motors_.size());
    const auto now = std::chrono::steady_clock::now();
    for (const auto& motor : monitored_motors_) {
      PlayMotorSnapshot snapshot;
      snapshot.name = motor->name;
      snapshot.adapter_type = motor->adapter_type;
      snapshot.adapter_id = motor->adapter_id;
      snapshot.slave_id = motor->slave_id;
      snapshot.bus_id = motor->bus_id;
      snapshot.motor_id = motor->motor_id;
      snapshot.sent = motor->sent.load(std::memory_order_relaxed);
      snapshot.received = motor->received.load(std::memory_order_relaxed);
      const auto window = motor->loss_window.Update(now, snapshot.sent, snapshot.received);
      snapshot.window_sent = window.sent;
      snapshot.window_received = window.received;
      const std::optional<encos::MotorStatus> status = motor->motor->GetStatus(0);
      if (status.has_value()) {
        snapshot.position_rad = status->position;
        snapshot.speed_rad_s = status->speed;
        snapshot.current_a = status->current;
        snapshot.torque_nm = status->current * motor->kt;
        snapshot.motor_temperature_c = status->motor_temperature;
        snapshot.mos_temperature_c = status->mos_temperature;
        snapshot.error = status->error;
      } else {
        const float nan = std::numeric_limits<float>::quiet_NaN();
        snapshot.position_rad = nan;
        snapshot.speed_rad_s = nan;
        snapshot.current_a = nan;
        snapshot.torque_nm = nan;
        snapshot.motor_temperature_c = nan;
        snapshot.mos_temperature_c = nan;
        snapshot.error = encos::MotorError::NoResponse;
      }
      snapshots.push_back(std::move(snapshot));
    }
    return snapshots;
  }

  static std::string FormatTuiFloat(float value, int precision = 2) {
    if (!std::isfinite(value)) {
      return "--";
    }
    std::ostringstream output;
    output << std::fixed << std::setprecision(precision) << value;
    return output.str();
  }

  ftxui::Element RenderTuiReport(double elapsed_s, PlayTuiState& tui_state, ftxui::Box& table_viewport,
                                 ftxui::Box& body_viewport) const {
    using namespace ftxui;
    const std::vector<PlayMotorSnapshot> snapshots =
        SortPlayMotorSnapshots(CaptureSnapshots(), tui_state.sort_column, tui_state.sort_ascending);
    std::vector<std::string> column_names = {"ADAPTER",    "SLAVE",    "BUS",     "ID",       "POS(deg)",
                                             "VEL(rad/s)", "CUR(A)",   "TOR(Nm)", "MOTOR(C)", "MOS(C)",
                                             "SENT",       "RECEIVED", "LOSS",    "LOSS(3s)", "ERROR"};
    std::vector<int> column_widths = {30, 7, 5, 5, 11, 12, 9, 10, 11, 9, 12, 12, 18, 18, 24};
    column_names[static_cast<std::size_t>(tui_state.sort_column)] += tui_state.sort_ascending ? " ^" : " v";

    const auto cells = [&column_widths](const std::vector<std::string>& values) {
      std::vector<Element> result;
      result.reserve(values.size());
      for (std::size_t index = 0; index < values.size(); ++index) {
        result.push_back(text(values[index]) | size(WIDTH, EQUAL, column_widths[index]));
      }
      return result;
    };

    Table header({cells(column_names)});
    header.SelectAll().Border(LIGHT);
    header.SelectAll().DecorateCells(bold);
    header.SelectColumn(static_cast<int>(tui_state.sort_column)).DecorateCells(color(Color::Yellow) | inverted);

    std::vector<std::vector<Element>> body_rows;
    body_rows.reserve(std::max<std::size_t>(snapshots.size(), 1U));
    std::vector<int> error_rows;
    for (std::size_t index = 0; index < snapshots.size(); ++index) {
      const PlayMotorSnapshot& snapshot = snapshots[index];
      std::vector<std::string> values = {
          snapshot.adapter_type + ":" + snapshot.adapter_id,
          PlaySlaveText(snapshot.slave_id),
          std::to_string(snapshot.bus_id),
          std::to_string(snapshot.motor_id),
          FormatTuiFloat(snapshot.position_rad * static_cast<float>(kRadiansToDegrees)),
          FormatTuiFloat(snapshot.speed_rad_s),
          FormatTuiFloat(snapshot.current_a),
          FormatTuiFloat(snapshot.torque_nm),
          FormatTuiFloat(snapshot.motor_temperature_c),
          FormatTuiFloat(snapshot.mos_temperature_c),
          std::to_string(snapshot.sent),
          std::to_string(snapshot.received),
          PlayMotorLossText(snapshot.sent, snapshot.received),
          PlayMotorLossText(snapshot.window_sent, snapshot.window_received),
          PlayMotorErrorName(snapshot.error),
      };
      body_rows.push_back(cells(values));
      if (snapshot.error != encos::MotorError::NoError) {
        error_rows.push_back(static_cast<int>(index));
      }
    }
    if (body_rows.empty()) {
      std::vector<std::string> empty_row(column_names.size());
      empty_row.front() = "No motors";
      body_rows.push_back(cells(empty_row));
    }

    Table body(std::move(body_rows));
    body.SelectAll().Border(LIGHT);
    body.SelectAll().DecorateCellsAlternateRow(dim, 2, 1);
    for (const int row : error_rows) {
      body.SelectRow(row).DecorateCells(color(Color::RedLight));
    }

    std::string title = " emcli play  time=" + FormatTime(elapsed_s) + "s  motors=" + std::to_string(snapshots.size());
    if (playback_paused_.load()) {
      title += "  PAUSED";
    }
    if (logs_enabled_) {
      title += "  log=" + *log_directory_;
    }

    std::string warning;
    {
      std::lock_guard<std::mutex> lock(output_mutex_);
      warning = tui_warning_;
    }

    Element header_element = header.Render();
    Element body_element = body.Render();
    header_element->ComputeRequirement();
    body_element->ComputeRequirement();
    tui_state.content_width = std::max(header_element->requirement().min_x, body_element->requirement().min_x);
    tui_state.content_height = body_element->requirement().min_y;
    ClampPlayTuiScroll(tui_state);

    // FTXUI's frame centers its focus cell. Pointing it at offset + half of
    // the viewport therefore produces an exact, cell-based viewport offset.
    const int x_focus = tui_state.scroll_x + std::max(0, tui_state.viewport_width - 1) / 2;
    const int y_focus = tui_state.scroll_y + std::max(0, tui_state.viewport_height - 1) / 2;
    body_element = std::move(body_element) | focusPosition(0, y_focus) | yframe | reflect(body_viewport) | flex;
    Element table_element = vbox({std::move(header_element), std::move(body_element)}) | focusPosition(x_focus, 0) |
                            xframe | reflect(table_viewport) | flex;
    Elements layout = {
        text(title) | bold,
        std::move(table_element),
        separator(),
        text("Space: pause/resume  l: log on/off  Arrows/Wheel: scroll  PageUp/PageDown: page  Tab/Shift+Tab: sort  "
             "Enter: direction  q/Ctrl+C: stop") |
            dim,
    };
    if (!warning.empty()) {
      layout.push_back(text(warning) | color(Color::Yellow));
    }
    return vbox(std::move(layout)) | border | flex;
  }

  void PrintFinalTuiTableOrThrow(double elapsed_s) const {
    using namespace ftxui;
    const std::vector<PlayMotorSnapshot> snapshots = CaptureSnapshots();
    const std::vector<int> column_widths = {30, 7, 5, 5, 11, 12, 9, 10, 11, 9, 12, 12, 18, 18, 24};
    const auto cells = [&column_widths](const std::vector<std::string>& values) {
      std::vector<Element> result;
      result.reserve(values.size());
      for (std::size_t index = 0; index < values.size(); ++index) {
        result.push_back(text(values[index]) | size(WIDTH, EQUAL, column_widths[index]));
      }
      return result;
    };

    std::vector<std::vector<Element>> rows;
    rows.push_back(cells({"ADAPTER", "SLAVE", "BUS", "ID", "POS(deg)", "VEL(rad/s)", "CUR(A)", "TOR(Nm)", "MOTOR(C)",
                          "MOS(C)", "SENT", "RECEIVED", "LOSS", "LOSS(3s)", "ERROR"}));
    std::vector<int> error_rows;
    for (const PlayMotorSnapshot& snapshot : snapshots) {
      rows.push_back(cells({snapshot.adapter_type + ":" + snapshot.adapter_id, PlaySlaveText(snapshot.slave_id),
                            std::to_string(snapshot.bus_id), std::to_string(snapshot.motor_id),
                            FormatTuiFloat(snapshot.position_rad * static_cast<float>(kRadiansToDegrees)),
                            FormatTuiFloat(snapshot.speed_rad_s), FormatTuiFloat(snapshot.current_a),
                            FormatTuiFloat(snapshot.torque_nm), FormatTuiFloat(snapshot.motor_temperature_c),
                            FormatTuiFloat(snapshot.mos_temperature_c), std::to_string(snapshot.sent),
                            std::to_string(snapshot.received), PlayMotorLossText(snapshot.sent, snapshot.received),
                            PlayMotorLossText(snapshot.window_sent, snapshot.window_received),
                            PlayMotorErrorName(snapshot.error)}));
      if (snapshot.error != encos::MotorError::NoError) {
        error_rows.push_back(static_cast<int>(rows.size() - 1U));
      }
    }

    Table table(std::move(rows));
    table.SelectAll().Border(LIGHT);
    table.SelectRow(0).DecorateCells(bold);
    table.SelectAll().DecorateCellsAlternateRow(dim, 2, 0);
    for (const int row : error_rows) {
      table.SelectRow(row).DecorateCells(color(Color::RedLight));
    }
    Element document = vbox({text("emcli play final status  time=" + FormatTime(elapsed_s) +
                                  "s  motors=" + std::to_string(snapshots.size())) |
                                 bold,
                             table.Render()});
    document->ComputeRequirement();
    const auto requirement = document->requirement();
    Screen screen(std::max(1, requirement.min_x), std::max(1, requirement.min_y));
    Render(screen, document);
    std::cout << screen.ToString() << '\n' << std::flush;
  }

  bool PrintFinalTuiTable(double elapsed_s) const noexcept {
    try {
      PrintFinalTuiTableOrThrow(elapsed_s);
      return true;
    } catch (const std::exception& error) {
      std::cerr << "Failed to print final TUI table: " << error.what() << '\n';
    } catch (...) {
      std::cerr << "Failed to print final TUI table: unknown error\n";
    }
    return false;
  }

  void PrintControlLoopWarning(double elapsed_s, std::chrono::microseconds overrun) const {
    std::lock_guard<std::mutex> lock(output_mutex_);
    if (tui_) {
      tui_warning_ =
          "Control loop overrun: " + std::to_string(overrun.count()) + " us at t=" + FormatTime(elapsed_s) + " s";
      return;
    }
    std::cerr << "warning: play control loop overrun by " << overrun.count() << " us at t=" << FormatTime(elapsed_s)
              << " s\n";
  }

  void RunTuiLoop(const std::chrono::steady_clock::time_point&) {
    using namespace ftxui;
    PlayTuiState tui_state;
    Box table_viewport{0, -1, 0, -1};
    Box body_viewport{0, -1, 0, -1};
    auto screen = ScreenInteractive::Fullscreen();
    const auto exit_loop = screen.ExitLoopClosure();

    Component renderer = Renderer([&] {
      if (BoxWidth(table_viewport) > 0) {
        tui_state.viewport_width = BoxWidth(table_viewport);
      }
      if (BoxHeight(body_viewport) > 0) {
        tui_state.viewport_height = BoxHeight(body_viewport);
      }
      ClampPlayTuiScroll(tui_state);
      return RenderTuiReport(DisplayedElapsedSeconds(), tui_state, table_viewport, body_viewport);
    });

    const auto request_stop = [] {
      int current = g_play_stop_requests.load();
      while (current < 2 && !g_play_stop_requests.compare_exchange_weak(current, current + 1)) {
      }
    };
    renderer = CatchEvent(renderer, [&](Event event) {
      if (event == Event::Custom) {
        if (g_play_stop_requests.load() >= 2) {
          exit_loop();
        }
        return true;
      }
      std::optional<PlayTuiAction> action;
      if (event == Event::ArrowLeft) {
        action = PlayTuiAction::ScrollLeft;
      } else if (event == Event::ArrowRight) {
        action = PlayTuiAction::ScrollRight;
      } else if (event == Event::ArrowUp) {
        action = PlayTuiAction::ScrollUp;
      } else if (event == Event::ArrowDown) {
        action = PlayTuiAction::ScrollDown;
      } else if (event == Event::PageUp) {
        action = PlayTuiAction::PageUp;
      } else if (event == Event::PageDown) {
        action = PlayTuiAction::PageDown;
      } else if (event == Event::TabReverse) {
        action = PlayTuiAction::PreviousSortColumn;
      } else if (event == Event::Tab) {
        action = PlayTuiAction::NextSortColumn;
      } else if (event == Event::Return) {
        action = PlayTuiAction::ToggleSortDirection;
      } else if (event == Event::Character(' ')) {
        playback_paused_.store(!playback_paused_.load());
        return true;
      } else if (event == Event::l || event == Event::L) {
        ToggleLogsFromTui();
        return true;
      } else if (event == Event::q || event == Event::Q || event == Event::CtrlC) {
        playback_paused_.store(false);
        request_stop();
        return true;
      } else if (event.is_mouse()) {
        if (event.mouse().button == Mouse::WheelUp) {
          action = PlayTuiAction::ScrollUp;
        } else if (event.mouse().button == Mouse::WheelDown) {
          action = PlayTuiAction::ScrollDown;
        } else if (event.mouse().button == Mouse::WheelLeft) {
          action = PlayTuiAction::ScrollLeft;
        } else if (event.mouse().button == Mouse::WheelRight) {
          action = PlayTuiAction::ScrollRight;
        }
      }
      if (action.has_value()) {
        ApplyPlayTuiAction(tui_state, *action);
        return true;
      }
      return false;
    });

    std::atomic<bool> refresh_running{true};
    std::thread refresh_thread([&] {
      auto next_refresh = std::chrono::steady_clock::now();
      while (refresh_running.load()) {
        next_refresh = NextPlayRefreshTick(next_refresh, kTuiRefreshPeriod, std::chrono::steady_clock::now());
        std::this_thread::sleep_until(next_refresh);
        if (refresh_running.load()) {
          screen.PostEvent(Event::Custom);
        }
      }
    });

    tui_screen_active_.store(true, std::memory_order_relaxed);
    try {
      screen.Loop(renderer);
    } catch (const std::exception& error) {
      tui_failed_ = true;
      tui_error_ = error.what();
    } catch (...) {
      tui_failed_ = true;
      tui_error_ = "unknown error";
    }
    refresh_running.store(false);
    refresh_thread.join();
    tui_screen_active_.store(false, std::memory_order_relaxed);
    if (tui_failed_) {
      g_play_stop_requests.store(2);
      return;
    }
    if (g_play_stop_requests.load() == 0) {
      g_play_stop_requests.store(1);
    }
  }

  void StatusLoop(const std::chrono::steady_clock::time_point& start_time) {
    auto next_status_tick = start_time + kStatusPollPeriod;
    while (g_play_stop_requests.load() < 2) {
      std::this_thread::sleep_until(next_status_tick);
      if (g_play_stop_requests.load() >= 2) {
        break;
      }
      const double elapsed_s = std::chrono::duration<double>(std::chrono::steady_clock::now() - start_time).count();
      PrintStressReport(elapsed_s);
      next_status_tick = NextPlayRefreshTick(next_status_tick, kStatusPollPeriod, std::chrono::steady_clock::now());
    }
  }

  bool dry_run_{false};
  float max_speed_rad_s_{kDefaultMaxSpeedRadS};
  float max_current_a_{kDefaultMaxCurrentA};
  std::optional<float> kp_;
  std::optional<float> kd_;
  std::optional<float> vel_;
  std::optional<float> tor_;
  bool tui_{false};
  bool logs_enabled_{false};
  std::atomic<bool> playback_paused_{false};
  std::atomic<std::int64_t> displayed_elapsed_us_{0};
  std::atomic<bool> tui_screen_active_{false};
  bool tui_failed_{false};
  std::string tui_error_;
  std::optional<std::string> log_directory_;
  std::chrono::steady_clock::duration control_period_{kControlPeriod};
  std::vector<float> initial_positions_rad_;
  mutable std::mutex output_mutex_;
  mutable std::string tui_warning_;
  std::unordered_map<emzero::AdapterKey, encos::BaseAdapterPtr, emzero::AdapterKeyHash> adapters_;
  std::vector<std::shared_ptr<MotorContext>> motors_;
  std::vector<std::shared_ptr<MotorContext>> monitored_motors_;
  std::vector<std::shared_ptr<MotorContext>> logging_motors_;
  std::vector<HoldingMotorContext> holding_motors_;
};

}  // namespace

std::chrono::steady_clock::time_point NextPlayControlTick(std::chrono::steady_clock::time_point previous_tick,
                                                          std::chrono::steady_clock::duration control_period,
                                                          std::chrono::steady_clock::time_point now) {
  const auto next_tick = previous_tick + control_period;
  return next_tick > now ? next_tick : now;
}

std::chrono::steady_clock::time_point NextPlayRefreshTick(std::chrono::steady_clock::time_point previous_tick,
                                                          std::chrono::steady_clock::duration refresh_period,
                                                          std::chrono::steady_clock::time_point now) {
  const auto next_tick = previous_tick + refresh_period;
  return next_tick > now ? next_tick : now + refresh_period;
}

void ApplyPlayTuiAction(PlayTuiState& state, PlayTuiAction action) {
  constexpr int kHorizontalScrollStep = 4;
  constexpr int kVerticalScrollStep = 1;
  switch (action) {
    case PlayTuiAction::ScrollLeft:
      state.scroll_x -= kHorizontalScrollStep;
      break;
    case PlayTuiAction::ScrollRight:
      state.scroll_x += kHorizontalScrollStep;
      break;
    case PlayTuiAction::ScrollUp:
      state.scroll_y -= kVerticalScrollStep;
      break;
    case PlayTuiAction::ScrollDown:
      state.scroll_y += kVerticalScrollStep;
      break;
    case PlayTuiAction::PageUp:
      state.scroll_y -= std::max(1, state.viewport_height);
      break;
    case PlayTuiAction::PageDown:
      state.scroll_y += std::max(1, state.viewport_height);
      break;
    case PlayTuiAction::PreviousSortColumn:
      state.sort_column = static_cast<PlaySortColumn>(
          (static_cast<std::size_t>(state.sort_column) + state.sort_column_count - 1U) % state.sort_column_count);
      break;
    case PlayTuiAction::NextSortColumn:
      state.sort_column =
          static_cast<PlaySortColumn>((static_cast<std::size_t>(state.sort_column) + 1U) % state.sort_column_count);
      break;
    case PlayTuiAction::ToggleSortDirection:
      state.sort_ascending = !state.sort_ascending;
      break;
  }
  ClampPlayTuiScroll(state);
}

bool IsPlayEndless(bool endless, bool) { return endless; }

bool ShouldReturnToInitialPosition(bool playback_finished, bool endless) { return playback_finished && !endless; }

bool ShouldUsePlayTui(bool stdin_is_tty, bool stdout_is_tty, const std::string& terminal, bool no_inplace_refresh) {
  return !no_inplace_refresh && stdin_is_tty && stdout_is_tty && terminal != "dumb";
}

std::chrono::steady_clock::time_point UpdatePlayPauseClock(PlayPauseClock& state, bool pause_requested,
                                                           std::chrono::steady_clock::time_point now) {
  if (pause_requested && !state.paused) {
    state.paused = true;
    state.pause_started = now;
  } else if (!pause_requested && state.paused) {
    state.paused_duration += now - state.pause_started;
    state.paused = false;
  }
  return (state.paused ? state.pause_started : now) - state.paused_duration;
}

std::string BuildPlayMotorLogBaseName(const std::string& log_directory, const std::string& motor_name,
                                      std::size_t motor_index) {
  return (std::filesystem::path(log_directory) / (SanitizeLogName(motor_name) + "_" + std::to_string(motor_index)))
      .string();
}

std::string PlayMotorErrorName(encos::MotorError error) {
  const auto code = static_cast<unsigned int>(static_cast<std::uint8_t>(error));
  const char* name = "Unknown";
  switch (error) {
    case encos::MotorError::NoError:
      name = "NoError";
      break;
    case encos::MotorError::OverTemperature:
      name = "OverTemperature";
      break;
    case encos::MotorError::OverCurrent:
      name = "OverCurrent";
      break;
    case encos::MotorError::VoltageHigh:
      name = "VoltageHigh";
      break;
    case encos::MotorError::VoltageLow:
      name = "VoltageLow";
      break;
    case encos::MotorError::EncoderError:
      name = "EncoderError";
      break;
    case encos::MotorError::BrakeVoltageHigh:
      name = "BrakeVoltageHigh";
      break;
    case encos::MotorError::DriverError:
      name = "DriverError";
      break;
    case encos::MotorError::OverTemperatureWarning:
      name = "TemperatureWarning";
      break;
    case encos::MotorError::NoResponse:
      name = "NoResponse";
      break;
  }
  return std::string(name) + "(" + std::to_string(code) + ")";
}

PlayPacketCounts PlayLossWindow::Update(std::chrono::steady_clock::time_point now, std::uint64_t sent,
                                        std::uint64_t received) {
  if (!samples_.empty() && (sent < samples_.back().counts.sent || received < samples_.back().counts.received)) {
    samples_.clear();
  }
  samples_.push_back({now, {sent, received}});
  const auto cutoff = now - std::chrono::seconds(3);
  // Use the first sample inside the window, so expired traffic cannot linger.
  while (samples_.size() > 1 && samples_.front().time < cutoff) {
    samples_.pop_front();
  }
  return {sent - samples_.front().counts.sent, received - samples_.front().counts.received};
}

std::string PlayMotorLossText(std::uint64_t sent, std::uint64_t received) {
  const std::uint64_t lost = sent > received ? sent - received : 0;
  const double loss_percent = sent == 0 ? 0.0 : static_cast<double>(lost) * 100.0 / static_cast<double>(sent);
  std::ostringstream output;
  output << lost << " (" << std::fixed << std::setprecision(2) << loss_percent << "%)";
  return output.str();
}

std::string PlaySlaveText(const std::optional<int32_t>& slave_id) { return std::to_string(slave_id.value_or(0)); }

std::vector<PlayMotorSnapshot> SortPlayMotorSnapshots(std::vector<PlayMotorSnapshot> snapshots, PlaySortColumn column,
                                                      bool ascending) {
  const auto compare_float = [](float lhs, float rhs) {
    const bool lhs_nan = std::isnan(lhs);
    const bool rhs_nan = std::isnan(rhs);
    if (lhs_nan != rhs_nan) {
      return lhs_nan ? 1 : -1;
    }
    return lhs < rhs ? -1 : (rhs < lhs ? 1 : 0);
  };
  const auto compare_string = [](const std::string& lhs, const std::string& rhs) {
    return lhs < rhs ? -1 : (rhs < lhs ? 1 : 0);
  };
  const auto compare_primary = [&](const PlayMotorSnapshot& lhs, const PlayMotorSnapshot& rhs) {
    switch (column) {
      case PlaySortColumn::Adapter:
        return compare_string(lhs.adapter_type + ":" + lhs.adapter_id, rhs.adapter_type + ":" + rhs.adapter_id);
      case PlaySortColumn::Slave:
        return lhs.slave_id.value_or(0) < rhs.slave_id.value_or(0)
                   ? -1
                   : (rhs.slave_id.value_or(0) < lhs.slave_id.value_or(0) ? 1 : 0);
      case PlaySortColumn::Bus:
        return lhs.bus_id < rhs.bus_id ? -1 : (rhs.bus_id < lhs.bus_id ? 1 : 0);
      case PlaySortColumn::Id:
        return lhs.motor_id < rhs.motor_id ? -1 : (rhs.motor_id < lhs.motor_id ? 1 : 0);
      case PlaySortColumn::Position:
        return compare_float(lhs.position_rad, rhs.position_rad);
      case PlaySortColumn::Speed:
        return compare_float(lhs.speed_rad_s, rhs.speed_rad_s);
      case PlaySortColumn::Current:
        return compare_float(lhs.current_a, rhs.current_a);
      case PlaySortColumn::Torque:
        return compare_float(lhs.torque_nm, rhs.torque_nm);
      case PlaySortColumn::MotorTemperature:
        return compare_float(lhs.motor_temperature_c, rhs.motor_temperature_c);
      case PlaySortColumn::MosTemperature:
        return compare_float(lhs.mos_temperature_c, rhs.mos_temperature_c);
      case PlaySortColumn::Error:
        return static_cast<std::uint8_t>(lhs.error) < static_cast<std::uint8_t>(rhs.error)
                   ? -1
                   : (static_cast<std::uint8_t>(rhs.error) < static_cast<std::uint8_t>(lhs.error) ? 1 : 0);
      case PlaySortColumn::Sent:
        return lhs.sent < rhs.sent ? -1 : (rhs.sent < lhs.sent ? 1 : 0);
      case PlaySortColumn::Received:
        return lhs.received < rhs.received ? -1 : (rhs.received < lhs.received ? 1 : 0);
      case PlaySortColumn::Loss3s:
      case PlaySortColumn::Loss: {
        const auto lhs_sent = column == PlaySortColumn::Loss3s ? lhs.window_sent : lhs.sent;
        const auto lhs_received = column == PlaySortColumn::Loss3s ? lhs.window_received : lhs.received;
        const auto rhs_sent = column == PlaySortColumn::Loss3s ? rhs.window_sent : rhs.sent;
        const auto rhs_received = column == PlaySortColumn::Loss3s ? rhs.window_received : rhs.received;
        const double lhs_loss = lhs_sent == 0 ? 0.0
                                              : static_cast<double>(lhs_sent - std::min(lhs_sent, lhs_received)) /
                                                    static_cast<double>(lhs_sent);
        const double rhs_loss = rhs_sent == 0 ? 0.0
                                              : static_cast<double>(rhs_sent - std::min(rhs_sent, rhs_received)) /
                                                    static_cast<double>(rhs_sent);
        return lhs_loss < rhs_loss ? -1 : (rhs_loss < lhs_loss ? 1 : 0);
      }
    }
    return 0;
  };
  const auto identity = [](const PlayMotorSnapshot& value) {
    return std::tie(value.adapter_type, value.adapter_id, value.slave_id, value.bus_id, value.motor_id, value.name);
  };
  const auto float_value = [column](const PlayMotorSnapshot& value) -> std::optional<float> {
    switch (column) {
      case PlaySortColumn::Position:
        return value.position_rad;
      case PlaySortColumn::Speed:
        return value.speed_rad_s;
      case PlaySortColumn::Current:
        return value.current_a;
      case PlaySortColumn::Torque:
        return value.torque_nm;
      case PlaySortColumn::MotorTemperature:
        return value.motor_temperature_c;
      case PlaySortColumn::MosTemperature:
        return value.mos_temperature_c;
      default:
        return std::nullopt;
    }
  };
  std::sort(snapshots.begin(), snapshots.end(), [&](const PlayMotorSnapshot& lhs, const PlayMotorSnapshot& rhs) {
    const std::optional<float> lhs_float = float_value(lhs);
    const std::optional<float> rhs_float = float_value(rhs);
    if (lhs_float.has_value()) {
      const bool lhs_nan = std::isnan(*lhs_float);
      const bool rhs_nan = std::isnan(*rhs_float);
      if (lhs_nan != rhs_nan) {
        return !lhs_nan;
      }
    }
    const int primary = compare_primary(lhs, rhs);
    if (primary != 0) {
      return ascending ? primary < 0 : primary > 0;
    }
    return identity(lhs) < identity(rhs);
  });
  return snapshots;
}

std::vector<std::string> NormalizePlayLogArguments(const std::vector<std::string>& arguments) {
  std::vector<std::string> normalized;
  normalized.reserve(arguments.size() + 1U);
  for (const std::string& argument : arguments) {
    constexpr std::string_view kLogAssignmentPrefix = "--log=";
    if (argument.compare(0, kLogAssignmentPrefix.size(), kLogAssignmentPrefix) == 0) {
      normalized.push_back("--log-directory");
      normalized.push_back(argument.substr(kLogAssignmentPrefix.size()));
    } else {
      normalized.push_back(argument);
    }
  }
  return normalized;
}

void ConfigurePlayCommand(argparse::ArgumentParser& parser) {
  parser.add_description("Play motors from a trajectory CSV");
  parser.add_argument("config").help("Path to trajectory CSV file");
  parser.add_argument("--dry-run")
      .default_value(false)
      .implicit_value(true)
      .help("Use FakeAdapter but still run full trajectory playback");
  parser.add_argument("--endless")
      .default_value(false)
      .implicit_value(true)
      .help("Ping-pong playback between trajectory tail and head until Ctrl+C");
  parser.add_argument("--stress").default_value(false).implicit_value(true).hidden();
  parser.add_argument("--tui").default_value(false).implicit_value(true).help(
      "Use the interactive status table when a terminal is available (default)");
  parser.add_argument("--no-inplace-refresh")
      .default_value(false)
      .implicit_value(true)
      .help("Use line-oriented status output instead of the interactive table");
  parser.add_argument("--log").default_value(false).implicit_value(true).help(
      "Enable logs for all motors; use --log=DIR to override the default ./logs directory");
  parser.add_argument("--log-directory").hidden();
  parser.add_argument("--control-frequency")
      .scan<'d', int>()
      .default_value(kDefaultControlFrequencyHz)
      .help("Control loop frequency in Hz");
  parser.add_argument("--max-speed")
      .scan<'g', float>()
      .default_value(kDefaultMaxSpeedRadS)
      .help("Maximum speed used for all position control commands");
  parser.add_argument("--max-current")
      .scan<'g', float>()
      .default_value(kDefaultMaxCurrentA)
      .help("Maximum current used for all position control commands");
  parser.add_argument("--kp").scan<'g', float>().help("PVT kp gain (requires --kd, --vel, --tor)");
  parser.add_argument("--kd").scan<'g', float>().help("PVT kd gain (requires --kp, --vel, --tor)");
  parser.add_argument("--vel").scan<'g', float>().help(
      "PVT velocity feedforward in rad/s (requires --kp, --kd, --tor)");
  parser.add_argument("--tor").scan<'g', float>().help("PVT torque feedforward in Nm (requires --kp, --kd, --vel)");
}

int RunPlayCommand(const argparse::ArgumentParser& parser) {
  const std::string config_path = parser.get<std::string>("config");
  const bool dry_run = parser.get<bool>("--dry-run");
  const bool endless = parser.get<bool>("--endless");
  static_cast<void>(parser.get<bool>("--stress"));
  static_cast<void>(parser.get<bool>("--tui"));
  const bool no_inplace_refresh = parser.get<bool>("--no-inplace-refresh");
  std::optional<std::string> log_directory;
  if (parser.is_used("--log-directory")) {
    log_directory = parser.get<std::string>("--log-directory");
  } else if (parser.get<bool>("--log")) {
    log_directory = "./logs";
  }
  const int control_frequency_hz = parser.get<int>("--control-frequency");
  const float max_speed = parser.get<float>("--max-speed");
  const float max_current = parser.get<float>("--max-current");
  const auto kp = parser.present<float>("--kp");
  const auto kd = parser.present<float>("--kd");
  const auto vel = parser.present<float>("--vel");
  const auto tor = parser.present<float>("--tor");

  const bool has_any_pvt_param = kp.has_value() || kd.has_value() || vel.has_value() || tor.has_value();
  if (has_any_pvt_param && !(kp.has_value() && kd.has_value() && vel.has_value() && tor.has_value())) {
    std::cerr << "Error: --kp, --kd, --vel, and --tor must be provided together\n";
    return 1;
  }
  if (control_frequency_hz <= 0 || control_frequency_hz > kMaximumControlFrequencyHz) {
    std::cerr << "Error: --control-frequency must be between 1 and " << kMaximumControlFrequencyHz << "\n";
    return 1;
  }
  const char* terminal = std::getenv("TERM");
  const bool tui = ShouldUsePlayTui(isatty(STDIN_FILENO) != 0, isatty(STDOUT_FILENO) != 0,
                                    terminal == nullptr ? "" : terminal, no_inplace_refresh);
  if (log_directory.has_value() && log_directory->empty()) {
    std::cerr << "Error: --log directory must not be empty\n";
    return 1;
  }

  emplay::Trajectory trajectory;
  try {
    trajectory = emplay::ParseTrajectoryCsv(config_path);
  } catch (const std::exception& error) {
    std::cerr << "Failed to parse trajectory: " << error.what() << "\n";
    return 1;
  }

  TrajectoryRunner runner(dry_run, max_speed, max_current, kp, kd, vel, tor, control_frequency_hz, tui, log_directory);
  try {
    if (!runner.Initialize(trajectory)) {
      return 1;
    }
  } catch (const std::exception& error) {
    std::cerr << "Failed to initialize trajectory motors: " << error.what() << '\n';
    return 1;
  }

  return runner.Run(trajectory, IsPlayEndless(endless, false));
}
