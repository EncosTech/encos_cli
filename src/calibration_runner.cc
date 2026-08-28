#include "calibration_runner.h"

#include <cmath>
#include <iostream>
#include <thread>

#include "csv_parser.h"

namespace emzero {

CalibrationRunner::CalibrationRunner(bool dry_run, bool canfd) : dry_run_(dry_run), canfd_(canfd) {}

bool CalibrationRunner::Initialize(const std::vector<CalibrationPoint>& points) {
  // Collect unique adapters
  std::unordered_map<AdapterKey, std::vector<MotorConnection>, AdapterKeyHash> adapter_points;
  for (const auto& point : points) {
    AdapterKey key{point.connection.adapter_type, point.connection.adapter_id};
    adapter_points[key].push_back(point.connection);
  }

  // Create adapters
  for (const auto& [key, _] : adapter_points) {
    encos::BaseAdapterPtr adapter = encos::MakeAdapter(key.type, key.id, key.id, encos::LogLevel::Warn);
    if (!adapter) {
      std::cerr << "Failed to create adapter: '" << key.type << ":" << key.id << "'\n";
      return false;
    }
    adapters_[key] = adapter;
  }

  // Get motors (direct GetMotor, no scanning)
  for (const auto& point : points) {
    AdapterKey key{point.connection.adapter_type, point.connection.adapter_id};
    auto adapter_it = adapters_.find(key);
    if (adapter_it == adapters_.end()) {
      std::cerr << "Adapter not found for " << FormatConnection(point.connection) << "\n";
      continue;
    }

    try {
      encos::Bus* bus = nullptr;
      if (point.connection.slave_id.has_value()) {
        bus = adapter_it->second->GetBus(*point.connection.slave_id, point.connection.bus_id);
      } else {
        bus = adapter_it->second->GetBus(point.connection.bus_id);
      }
      if (!bus) {
        std::cerr << "Failed to get bus for " << FormatConnection(point.connection) << "\n";
        continue;
      }

      encos::Motor* motor = bus->GetMotor(point.connection.motor_id);
      if (!motor) {
        std::cerr << "Failed to get motor " << FormatConnection(point.connection) << "\n";
        continue;
      }
      if (canfd_) {
        motor->EnableCanFd();
      }

      motors_[FormatConnection(point.connection)] = motor;
    } catch (const std::exception& e) {
      std::cerr << "Error initializing " << FormatConnection(point.connection) << ": " << e.what() << "\n";
      continue;
    }
  }

  return true;
}

bool CalibrationRunner::RunCalibration(const std::vector<CalibrationPoint>& points) {
  bool any_success = false;

  for (const auto& point : points) {
    if (dry_run_) {
      std::cout << FormatConnection(point.connection) << " [DRY-RUN] current=" << point.current
                << "A set_position=" << point.set_position_deg << "°\n";
      any_success = true;
      continue;
    }

    auto motor_it = motors_.find(FormatConnection(point.connection));
    if (motor_it == motors_.end() || !motor_it->second) {
      std::cerr << FormatConnection(point.connection) << " FAILED (motor not found)\n";
      continue;
    }

    CalibrateSingleMotor(point, *motor_it->second);
    any_success = true;
  }

  return any_success;
}

void CalibrationRunner::CalibrateSingleMotor(const CalibrationPoint& point, encos::Motor& motor) {
  const std::string conn_str = FormatConnection(point.connection);
  const double pos_rad = static_cast<double>(point.set_position_deg * M_PI / 180.0f);
  constexpr auto kPeriod = std::chrono::milliseconds(20);  // 50Hz
  constexpr int kStopThresholdCount = 10;
  constexpr float kStopSpeedThreshold = 0.1f;  // rad/s
  constexpr int kMaxCycles = 100;              // 100 * 20ms = 2s timeout

  const float speed = (point.current >= 0.0f ? 1.0f : -1.0f);  // ±1 rad/s
  const float max_current = std::abs(point.current);

  std::cout << conn_str;
  std::cout.flush();

  try {
    // === Phase 1: 50Hz speed control until speed is below threshold ===
    int stop_count = 0;
    int cycle_count = 0;
    float last_pos_rad = 0.0f;

    auto next_time = std::chrono::steady_clock::now();
    while (stop_count < kStopThresholdCount) {
      if (++cycle_count > kMaxCycles) {
        throw std::runtime_error("speed control timeout (2s)");
      }
      auto feedback = motor.SpdControl<1>(speed, max_current);

      last_pos_rad = feedback.position;
      float spd = std::abs(feedback.speed);

      if (spd < kStopSpeedThreshold) {
        ++stop_count;
      } else {
        stop_count = 0;
      }

      next_time += kPeriod;
      std::this_thread::sleep_until(next_time);
    }

    // === Phase 2: SetPos or ResetZero ===
    if (point.set_position_deg == 0.0f) {
      if (!motor.ResetZeroPos(true)) {
        throw std::runtime_error("ResetZeroPos returned false");
      }
    } else {
      if (!motor.SetPos(pos_rad)) {
        throw std::runtime_error("SetPos returned false");
      }
    }

    // === Phase 3: Get new position and print result ===
    float new_pos_rad = 0.0f;
    try {
      new_pos_rad = motor.GetParameter<encos::MotorParameter::Position>();
    } catch (...) {
      new_pos_rad = 0.0f;
    }

    const float old_deg = last_pos_rad * 180.0f / M_PI;
    const float new_deg = new_pos_rad * 180.0f / M_PI;
    std::cout << " OK (" << old_deg << "° -> " << new_deg << "°)\n";
  } catch (const std::exception& e) {
    std::cout << " FAILED (" << e.what() << ")\n";
  }

  std::this_thread::sleep_for(std::chrono::milliseconds(100));
}

}  // namespace emzero
