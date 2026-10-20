// SPDX-License-Identifier: MIT

#include "src/cli/imu.h"

#include <encos/device/imu/imu.h>
#include <encos/encos_motor.h>

#include <atomic>
#include <chrono>
#include <csignal>
#include <cstdint>
#include <cstdlib>
#include <iomanip>
#include <iostream>
#include <memory>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#include "cli_command.h"
#include "src/cli/adapter_cli_utils.h"
#include "src/cli/help_text.h"
#include "src/cli/interface_name.h"
#include "src/cli/platform_compat.h"

namespace {

std::atomic<bool> g_stop_requested{false};

void HandleSignal(int) { g_stop_requested.store(true); }

class SignalGuard {
public:
  explicit SignalGuard(int signal) : signal_(signal), previous_handler_(std::signal(signal, HandleSignal)) {}
  ~SignalGuard() { std::signal(signal_, previous_handler_); }

private:
  int signal_;
  void (*previous_handler_)(int);
};

bool SupportsInPlaceRefresh() { return motor_cli::platform::SupportsInPlaceRefresh(); }

encos::Bus* OpenBus(const motor_cli::SensorTarget& target, const AdapterTimingOptions& timing) {
  encos::BaseAdapterPtr adapter = MakeAdapterWithTiming(
      target.adapter_type, target.adapter_id, motor_cli::GetLoggerName(target.adapter_type, target.adapter_id),
      encos::LogLevel::Warn, timing);
  if (!adapter) {
    throw std::runtime_error("Failed to create adapter: '" + target.adapter_type + ":" + target.adapter_id + "'");
  }

  encos::Bus* bus =
      target.slave_id.has_value() ? adapter->GetBus(*target.slave_id, target.bus_id) : adapter->GetBus(target.bus_id);
  if (!bus) {
    throw std::runtime_error("Failed to get target bus");
  }
  return bus;
}

std::string FormatCell(const std::optional<float>& value) {
  if (!value.has_value()) {
    return "";
  }
  std::ostringstream output;
  output << std::fixed << std::setprecision(6) << *value;
  return output.str();
}

std::string BuildImuReport(const encos::ImuStatus& status) {
  std::ostringstream output;
  output << std::left << std::setw(8) << "group" << std::right << std::setw(14) << "x" << std::setw(14) << "y"
         << std::setw(14) << "z" << '\n';

  const auto append_row = [&](const std::string& name, const std::optional<float>& x, const std::optional<float>& y,
                              const std::optional<float>& z) {
    output << std::left << std::setw(8) << name << std::right << std::setw(14) << FormatCell(x) << std::setw(14)
           << FormatCell(y) << std::setw(14) << FormatCell(z) << '\n';
  };

  append_row("accel", status.acceleration ? std::optional<float>(status.acceleration->x) : std::nullopt,
             status.acceleration ? std::optional<float>(status.acceleration->y) : std::nullopt,
             status.acceleration ? std::optional<float>(status.acceleration->z) : std::nullopt);
  append_row("gyro", status.angular_velocity ? std::optional<float>(status.angular_velocity->x) : std::nullopt,
             status.angular_velocity ? std::optional<float>(status.angular_velocity->y) : std::nullopt,
             status.angular_velocity ? std::optional<float>(status.angular_velocity->z) : std::nullopt);
  append_row("euler", status.euler_angle ? std::optional<float>(status.euler_angle->pitch) : std::nullopt,
             status.euler_angle ? std::optional<float>(status.euler_angle->roll) : std::nullopt,
             status.euler_angle ? std::optional<float>(status.euler_angle->heading) : std::nullopt);

  return output.str();
}

}  // namespace

namespace motor_cli {

std::string BuildImuInPlaceRefreshPrefix(std::size_t report_line_count) {
  if (report_line_count == 0) {
    return "";
  }

  std::ostringstream output;
  output << "\r\033[2K";
  for (std::size_t line = 0; line < report_line_count; ++line) {
    output << "\033[1A\r\033[2K";
  }
  return output.str();
}

}  // namespace motor_cli

int RunImuCommand(int argc, char** argv) {
  if (argc >= 3 && (std::string(argv[2]) == "-h" || std::string(argv[2]) == "--help")) {
    std::cout << motor_cli::BuildImuHelp();
    return 0;
  }

  std::vector<std::string> arguments;
  for (int index = 1; index < argc; ++index) {
    arguments.emplace_back(argv[index]);
  }

  motor_cli::SensorCommand command;
  AdapterTimingOptions timing;
  try {
    timing = StripAdapterTimingFlags(arguments);
    command = motor_cli::ParseImuCommand(arguments);
  } catch (const std::exception& error) {
    std::cerr << "Error: " << error.what() << '\n';
    std::cerr << motor_cli::BuildImuHelp();
    return 1;
  }

  try {
    encos::Bus* bus = OpenBus(command.target, timing);
    if (command.action == motor_cli::SensorCommandAction::Start ||
        command.action == motor_cli::SensorCommandAction::Stop) {
      const bool submitted = command.action == motor_cli::SensorCommandAction::Start ? bus->StartImu() : bus->StopImu();
      if (!submitted) {
        throw std::runtime_error("Failed to submit IMU control command");
      }
      std::cout << "IMU " << (command.action == motor_cli::SensorCommandAction::Start ? "start" : "stop")
                << " command submitted\n";
      return 0;
    }

    encos::Imu* imu = bus->GetImu(command.target.device_idx);
    if (!imu) {
      throw std::runtime_error("Failed to get target IMU");
    }

    g_stop_requested.store(false);
    SignalGuard sigint_guard(SIGINT);
    motor_cli::platform::TerminalRawMode terminal_raw_mode;

    using namespace std::chrono_literals;
    const bool in_place_refresh = SupportsInPlaceRefresh();
    std::size_t previous_line_count = 0;

    while (!g_stop_requested.load()) {
      if (motor_cli::platform::QuitKeyPressed()) {
        break;
      }

      const std::string report = BuildImuReport(imu->GetStatus());
      if (in_place_refresh) {
        std::cout << motor_cli::BuildImuInPlaceRefreshPrefix(previous_line_count);
      } else if (previous_line_count != 0) {
        std::cout << '\n';
      }
      std::cout << report << std::flush;
      previous_line_count = 4;

      std::this_thread::sleep_for(20ms);
    }
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "Error: " << error.what() << '\n';
    return 1;
  }
}
