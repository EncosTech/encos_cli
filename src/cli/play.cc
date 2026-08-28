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
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "src/calibration_config.h"
#include "src/trajectory_csv_parser.h"

namespace {

constexpr int kDefaultControlFrequencyHz = 1000;
constexpr int kMaximumControlFrequencyHz = 1000000000;
constexpr auto kControlPeriod = std::chrono::microseconds(1000);
constexpr auto kStatusPollPeriod = std::chrono::milliseconds(500);
constexpr auto kStartupTransitionDuration = std::chrono::seconds(2);
constexpr auto kReturnTransitionDuration = std::chrono::seconds(2);
constexpr auto kStressDrainDelay = std::chrono::milliseconds(500);
constexpr float kDefaultMaxSpeedRadS = 20.0f;
constexpr float kDefaultMaxCurrentA = 10.0f;
constexpr double kDegreesToRadians = M_PI / 180.0;
constexpr double kRadiansToDegrees = 180.0 / M_PI;
constexpr const char* kStressLogDirectory = "logs";

std::atomic<int> g_play_stop_requests{0};

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

class AlternateScreenGuard {
public:
  explicit AlternateScreenGuard(bool enabled) : active_(enabled) {
    if (active_) {
      std::cout << "\033[?1049h" << std::flush;
    }
  }
  ~AlternateScreenGuard() { Leave(); }

  void Leave() {
    if (!active_) {
      return;
    }
    std::cout << "\033[?1049l" << std::flush;
    active_ = false;
  }

private:
  bool active_;
};

float DegreesToRadians(float value_deg) { return static_cast<float>(value_deg * kDegreesToRadians); }

std::string FormatTime(double value_s) {
  std::ostringstream stream;
  stream << std::fixed << std::setprecision(3) << value_s;
  return stream.str();
}

std::string FormatAngle(float value_deg) {
  std::ostringstream stream;
  stream << std::fixed << std::setprecision(6) << value_deg;
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
  std::atomic<std::uint64_t> sent{0};
  std::atomic<std::uint64_t> received{0};
};

struct BusScanResult {
  encos::Bus* bus{nullptr};
  std::unordered_map<int, encos::Motor*> motors;
};

struct HoldingMotorContext {
  std::shared_ptr<MotorContext> context;
  float position_rad{0.0f};
};

class TrajectoryRunner {
public:
  TrajectoryRunner(bool dry_run, float max_speed_rad_s, float max_current_a, std::optional<float> kp = std::nullopt,
                   std::optional<float> kd = std::nullopt, std::optional<float> vel = std::nullopt,
                   std::optional<float> tor = std::nullopt, bool stress = false,
                   int control_frequency_hz = kDefaultControlFrequencyHz)
      : dry_run_(dry_run),
        max_speed_rad_s_(max_speed_rad_s),
        max_current_a_(max_current_a),
        kp_(kp),
        kd_(kd),
        vel_(vel),
        tor_(tor),
        stress_(stress),
        control_period_(std::chrono::duration_cast<std::chrono::steady_clock::duration>(
            std::chrono::duration<double>(1.0 / static_cast<double>(control_frequency_hz)))) {}

  ~TrajectoryRunner() {
    DisableStressCallbacks();
    DisableStressLogs();
  }

  bool Initialize(const emplay::Trajectory& trajectory) {
    std::vector<encos::Bus*> trajectory_buses;
    std::unordered_map<encos::Bus*, std::string> bus_prefixes;
    trajectory_buses.reserve(trajectory.motor_connections.size());
    for (std::size_t index = 0; index < trajectory.motor_connections.size(); ++index) {
      const emzero::MotorConnection& connection = trajectory.motor_connections[index];
      const emzero::AdapterKey key{connection.adapter_type, connection.adapter_id};
      auto adapter_it = adapters_.find(key);
      if (adapter_it == adapters_.end()) {
        encos::BaseAdapterPtr adapter =
            encos::MakeAdapter(dry_run_ ? "Fake" : key.type, key.id, key.id, encos::LogLevel::Warn);
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
      } catch (const std::exception& error) {
        std::cerr << "Failed to initialize " << trajectory.motor_names[index] << ": " << error.what() << "\n";
        return false;
      }
    }

    for (const auto& [key, adapter] : adapters_) {
      for (const auto& [adapter_bus_id, bus] : adapter->GetBuses()) {
        if (bus != nullptr) {
          bus_prefixes.emplace(bus, FormatMotorTargetPrefix(key, adapter_bus_id));
        }
      }
    }

    const auto discovered_motors = ScanMotors(trajectory, trajectory_buses);
    std::unordered_set<encos::Motor*> trajectory_motors;
    for (std::size_t index = 0; index < trajectory.motor_connections.size(); ++index) {
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
      if (stress_) {
        motor->SetOnStatus([motor_context](const encos::MotorStatus&) {
          motor_context->received.fetch_add(1, std::memory_order_relaxed);
        });
      }
      motors_.push_back(std::move(motor_context));
      stress_motors_.push_back(motors_.back());
    }

    for (const auto& [bus, motors] : discovered_motors) {
      static_cast<void>(bus);
      for (const auto& [motor_id, motor] : motors) {
        static_cast<void>(motor_id);
        if (motor != nullptr && trajectory_motors.find(motor) == trajectory_motors.end()) {
          auto motor_context = std::make_shared<MotorContext>();
          motor_context->motor = motor;
          motor_context->name = bus_prefixes.at(bus) + ":" + std::to_string(motor_id);
          if (stress_) {
            motor->SetOnStatus([motor_context](const encos::MotorStatus&) {
              motor_context->received.fetch_add(1, std::memory_order_relaxed);
            });
          }
          holding_motors_.push_back(HoldingMotorContext{
              motor_context,
              motor->GetParameter<encos::MotorParameter::Position>(),
          });
          stress_motors_.push_back(std::move(motor_context));
        }
      }
    }

    if (stress_ && !dry_run_ && !EnableStressLogs()) {
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

    if (!stress_) {
      PrintHeader(trajectory.motor_names);
    }

    SignalGuard sigint_guard(SIGINT, HandlePlayInterrupt);
    SignalGuard sigterm_guard(SIGTERM, HandlePlayTerminate);
    g_play_stop_requests.store(0);
    if (!ReadCurrentPositions(&initial_positions_rad_, "starting")) {
      return 1;
    }
    if (stress_) {
      ResetStressCounters();
    }
    const char* terminal = std::getenv("TERM");
    in_place_refresh_ =
        stress_ && SupportsPlayStressInPlaceRefresh(isatty(STDOUT_FILENO) != 0, terminal == nullptr ? "" : terminal);
    AlternateScreenGuard alternate_screen(in_place_refresh_);

    enum class PlaybackPhase { Startup, Playback, Returning };
    PlaybackPhase phase = PlaybackPhase::Startup;
    auto next_tick = std::chrono::steady_clock::now();
    const auto start_time = next_tick;
    auto phase_start_time = start_time;
    auto trajectory_start_time = start_time;
    std::vector<float> return_start_positions_rad;
    std::thread status_thread(&TrajectoryRunner::StatusLoop, this, std::cref(start_time));
    while (g_play_stop_requests.load() < 2) {
      auto now = std::chrono::steady_clock::now();
      if (g_play_stop_requests.load() >= 1 && phase != PlaybackPhase::Returning) {
        if (!ReadCurrentPositions(&return_start_positions_rad, "stopping")) {
          g_play_stop_requests.store(2);
          break;
        }
        if (g_play_stop_requests.load() >= 2) {
          break;
        }
        phase = PlaybackPhase::Returning;
        phase_start_time = std::chrono::steady_clock::now();
        now = phase_start_time;
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
          phase_start_time = std::chrono::steady_clock::now();
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

    if (stress_) {
      std::this_thread::sleep_for(kStressDrainDelay);
      alternate_screen.Leave();
      in_place_refresh_ = false;
      PrintStressReport(std::chrono::duration<double>(std::chrono::steady_clock::now() - start_time).count());
      DisableStressCallbacks();
      DisableStressLogs();
    }

    return 0;
  }

private:
  bool UsePvtControl() const { return kp_.has_value() && kd_.has_value() && vel_.has_value() && tor_.has_value(); }

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
      std::cerr << "Failed to read motor positions while " << action << ": " << error.what() << '\n';
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

  void PrintHeader(const std::vector<std::string>& motor_names) const {
    std::cout << "time";
    for (const auto& motor_name : motor_names) {
      std::cout << '\t' << motor_name;
    }
    std::cout << '\n';
  }

  void PrintFeedbackLine(double elapsed_s) const {
    std::lock_guard<std::mutex> lock(output_mutex_);
    std::cout << FormatTime(elapsed_s);
    for (const auto& motor : motors_) {
      const std::optional<encos::MotorStatus> status = motor->motor->GetStatus(0);
      const float position_rad = status ? status->position : std::numeric_limits<float>::quiet_NaN();
      std::cout << '\t' << FormatAngle(position_rad * static_cast<float>(kRadiansToDegrees));
    }
    std::cout << '\n';
  }

  void CountSent(std::size_t index) {
    if (stress_) {
      motors_[index]->sent.fetch_add(1, std::memory_order_relaxed);
    }
  }

  void CountSent(const std::shared_ptr<MotorContext>& motor) {
    if (stress_) {
      motor->sent.fetch_add(1, std::memory_order_relaxed);
    }
  }

  void ResetStressCounters() {
    for (const auto& motor : stress_motors_) {
      motor->sent.store(0, std::memory_order_relaxed);
      motor->received.store(0, std::memory_order_relaxed);
    }
  }

  bool EnableStressLogs() {
    std::error_code error;
    std::filesystem::create_directories(kStressLogDirectory, error);
    if (error) {
      std::cerr << "Failed to create play log directory '" << kStressLogDirectory << "': " << error.message() << '\n';
      return false;
    }
    for (std::size_t index = 0; index < stress_motors_.size(); ++index) {
      const std::string log_path = BuildPlayStressMotorLogBaseName(stress_motors_[index]->name, index);
      stress_motors_[index]->motor->EnableLog(log_path);
      if (!stress_motors_[index]->motor->IsLogged()) {
        std::cerr << "Failed to enable log for " << stress_motors_[index]->name << '\n';
        DisableStressLogs();
        return false;
      }
      stress_logs_enabled_ = true;
    }
    return true;
  }

  void DisableStressLogs() {
    if (dry_run_ || !stress_logs_enabled_) {
      return;
    }
    for (const auto& motor : stress_motors_) {
      if (motor->motor->IsLogged()) {
        motor->motor->DisableLog();
      }
    }
    stress_logs_enabled_ = false;
  }

  void DisableStressCallbacks() const {
    if (!stress_) {
      return;
    }
    for (const auto& motor : stress_motors_) {
      motor->motor->SetOnStatus(nullptr);
    }
  }

  void PrintStressReport(double elapsed_s) const {
    std::lock_guard<std::mutex> lock(output_mutex_);
    if (in_place_refresh_) {
      std::cout << "\033[H\033[2J";
    }
    std::cout << "===== PLAY STRESS STATUS (Press Ctrl+C to stop) =====\n";
    std::cout << "Measurement seconds: " << FormatTime(elapsed_s) << '\n';
    for (const auto& motor : stress_motors_) {
      const std::uint64_t sent = motor->sent.load(std::memory_order_relaxed);
      const std::uint64_t received = motor->received.load(std::memory_order_relaxed);
      const std::uint64_t lost = sent > received ? sent - received : 0;
      const double loss_percent = sent == 0 ? 0.0 : static_cast<double>(lost) * 100.0 / static_cast<double>(sent);
      std::cout << "Motor " << motor->name << ": sent=" << sent << " received=" << received << " lost=" << lost
                << " loss=" << std::fixed << std::setprecision(2) << loss_percent << "%\n";
    }
    std::cout << std::flush;
  }

  void PrintControlLoopWarning(double elapsed_s, std::chrono::microseconds overrun) const {
    std::lock_guard<std::mutex> lock(output_mutex_);
    std::cerr << "warning: play control loop overrun by " << overrun.count() << " us at t=" << FormatTime(elapsed_s)
              << " s\n";
  }

  void StatusLoop(const std::chrono::steady_clock::time_point& start_time) const {
    auto next_status_tick = start_time + kStatusPollPeriod;
    while (g_play_stop_requests.load() < 2) {
      std::this_thread::sleep_until(next_status_tick);
      if (g_play_stop_requests.load() >= 2) {
        break;
      }
      const double elapsed_s = std::chrono::duration<double>(std::chrono::steady_clock::now() - start_time).count();
      if (stress_) {
        PrintStressReport(elapsed_s);
      } else {
        PrintFeedbackLine(elapsed_s);
      }
      next_status_tick += kStatusPollPeriod;
    }
  }

  bool dry_run_{false};
  float max_speed_rad_s_{kDefaultMaxSpeedRadS};
  float max_current_a_{kDefaultMaxCurrentA};
  std::optional<float> kp_;
  std::optional<float> kd_;
  std::optional<float> vel_;
  std::optional<float> tor_;
  bool stress_{false};
  bool in_place_refresh_{false};
  bool stress_logs_enabled_{false};
  std::chrono::steady_clock::duration control_period_{kControlPeriod};
  std::vector<float> initial_positions_rad_;
  mutable std::mutex output_mutex_;
  std::unordered_map<emzero::AdapterKey, encos::BaseAdapterPtr, emzero::AdapterKeyHash> adapters_;
  std::vector<std::shared_ptr<MotorContext>> motors_;
  std::vector<std::shared_ptr<MotorContext>> stress_motors_;
  std::vector<HoldingMotorContext> holding_motors_;
};

}  // namespace

std::chrono::steady_clock::time_point NextPlayControlTick(std::chrono::steady_clock::time_point previous_tick,
                                                          std::chrono::steady_clock::duration control_period,
                                                          std::chrono::steady_clock::time_point now) {
  const auto next_tick = previous_tick + control_period;
  return next_tick > now ? next_tick : now;
}

bool IsPlayEndless(bool endless, bool) { return endless; }

bool ShouldReturnToInitialPosition(bool playback_finished, bool endless) { return playback_finished && !endless; }

bool SupportsPlayStressInPlaceRefresh(bool stdout_is_tty, const std::string& terminal) {
  return stdout_is_tty && terminal != "dumb";
}

std::string BuildPlayStressMotorLogBaseName(const std::string& motor_name, std::size_t motor_index) {
  return std::string(kStressLogDirectory) + "/" + SanitizeLogName(motor_name) + "_" + std::to_string(motor_index);
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
  parser.add_argument("--stress")
      .default_value(false)
      .implicit_value(true)
      .help("Show per-motor packet loss in place and enable logs");
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
  const bool stress = parser.get<bool>("--stress");
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

  emplay::Trajectory trajectory;
  try {
    trajectory = emplay::ParseTrajectoryCsv(config_path);
  } catch (const std::exception& error) {
    std::cerr << "Failed to parse trajectory: " << error.what() << "\n";
    return 1;
  }

  TrajectoryRunner runner(dry_run, max_speed, max_current, kp, kd, vel, tor, stress, control_frequency_hz);
  try {
    if (!runner.Initialize(trajectory)) {
      return 1;
    }
  } catch (const std::exception& error) {
    std::cerr << "Failed to initialize trajectory motors: " << error.what() << '\n';
    return 1;
  }

  return runner.Run(trajectory, IsPlayEndless(endless, stress));
}
