#include "src/cli/battery.h"

#include <encos/battery/battery.h>
#include <encos/encos_motor.h>
#include <sys/select.h>
#include <termios.h>
#include <unistd.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <csignal>
#include <iomanip>
#include <iostream>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#include "cli_command.h"
#include "src/cli/interface_name.h"

namespace {

std::atomic<bool> g_stop_requested{false};

class TerminalRawMode {
public:
  TerminalRawMode() {
    if (!isatty(STDIN_FILENO)) {
      return;
    }
    if (tcgetattr(STDIN_FILENO, &original_) != 0) {
      return;
    }
    termios raw = original_;
    raw.c_lflag = static_cast<tcflag_t>(raw.c_lflag & ~(ICANON | ECHO));
    raw.c_cc[VMIN] = 0;
    raw.c_cc[VTIME] = 0;
    if (tcsetattr(STDIN_FILENO, TCSANOW, &raw) == 0) {
      active_ = true;
    }
  }

  ~TerminalRawMode() {
    if (active_) {
      tcsetattr(STDIN_FILENO, TCSANOW, &original_);
    }
  }

private:
  termios original_{};
  bool active_{false};
};

void HandleSignal(int) { g_stop_requested.store(true); }

class SignalGuard {
public:
  explicit SignalGuard(int signal) : signal_(signal), previous_handler_(std::signal(signal, HandleSignal)) {}
  ~SignalGuard() { std::signal(signal_, previous_handler_); }

private:
  int signal_;
  void (*previous_handler_)(int);
};

bool QuitKeyPressed() {
  if (!isatty(STDIN_FILENO)) {
    return false;
  }

  fd_set read_fds;
  FD_ZERO(&read_fds);
  FD_SET(STDIN_FILENO, &read_fds);
  timeval timeout{0, 0};
  if (select(STDIN_FILENO + 1, &read_fds, nullptr, nullptr, &timeout) <= 0) {
    return false;
  }

  char input = '\0';
  if (read(STDIN_FILENO, &input, 1) != 1) {
    return false;
  }
  return input == 'q' || input == 'Q';
}

encos::Bus* OpenBus(const motor_cli::SensorTarget& target) {
  encos::BaseAdapterPtr adapter =
      encos::MakeAdapter(target.adapter_type, target.adapter_id,
                         motor_cli::GetLoggerName(target.adapter_type, target.adapter_id), encos::LogLevel::Warn);
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

std::string FormatValueLine(const std::string& key, const std::optional<float>& value) {
  std::ostringstream output;
  output << std::left << std::setw(22) << key;
  if (value.has_value()) {
    output << std::fixed << std::setprecision(6) << *value;
  }
  return output.str();
}

std::string FormatTextLine(const std::string& key, const std::string& value) {
  std::ostringstream output;
  output << std::left << std::setw(22) << key << value;
  return output.str();
}

std::vector<std::string> FormatErrorLines(const encos::BatteryError& error) {
  std::vector<std::string> lines;
  const std::vector<std::pair<bool, std::string>> errors{
      {error.could_not_charge, "could not charge"},
      {error.could_not_discharge, "could not discharge"},
      {error.low_battery, "low battery"},
      {error.over_current_steady, "over current steady"},
      {error.over_current_peak, "over current peak"},
      {error.over_current_charge, "over current charge"},
      {error.battery_over_temp, "battery over temp"},
      {error.mos_over_temp, "mos over temp"},
      {error.could_not_communicate, "could not communicate"},
      {error.stopped_emergency, "emergency stop"},
      {error.charger_fault, "charger fault"},
      {error.comm_timeout, "communication timeout"},
  };
  lines.reserve(errors.size());
  for (const auto& [active, description] : errors) {
    if (active) {
      lines.push_back(description);
    }
  }
  if (!error.AnyError()) {
    lines.push_back("none");
  }
  return lines;
}

}  // namespace

namespace motor_cli {

std::string BuildBatteryReport(const encos::BatteryStatus& status) {
  std::ostringstream output;
  output << std::left << std::setw(22) << "item" << "value\n";
  output << FormatValueLine("soc", status.state ? std::optional<float>(status.state->soc) : std::nullopt) << '\n';
  output << FormatValueLine("battery_temp_c", status.temp ? std::optional<float>(status.temp->battery) : std::nullopt)
         << '\n';
  output << FormatValueLine("mos_temp_c", status.temp ? std::optional<float>(status.temp->mos) : std::nullopt) << '\n';
  output << FormatValueLine("voltage_v", status.state ? std::optional<float>(status.state->voltage) : std::nullopt)
         << '\n';
  output << FormatValueLine("discharge_current_a",
                            status.temp ? std::optional<float>(status.temp->discharge_current) : std::nullopt)
         << '\n';
  for (const std::string& line : FormatErrorLines(status.error)) {
    output << FormatTextLine("error", line) << '\n';
  }
  return output.str();
}

std::string BuildBatteryInPlaceRefreshPrefix(std::size_t report_line_count) {
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

int RunBatteryCommand(int argc, char** argv) {
  if (argc >= 3 && (std::string(argv[2]) == "-h" || std::string(argv[2]) == "--help")) {
    std::cout << motor_cli::BuildBatteryHelp();
    return 0;
  }

  std::vector<std::string> arguments;
  for (int index = 1; index < argc; ++index) {
    arguments.emplace_back(argv[index]);
  }

  motor_cli::SensorCommand command;
  try {
    command = motor_cli::ParseBatteryCommand(arguments);
  } catch (const std::exception& error) {
    std::cerr << "Error: " << error.what() << '\n';
    std::cerr << motor_cli::BuildBatteryHelp();
    return 1;
  }

  try {
    encos::Bus* bus = OpenBus(command.target);
    encos::Battery* battery = bus->GetBattery(command.target.device_idx);
    if (!battery) {
      throw std::runtime_error("Failed to get target battery");
    }

    if (command.action == motor_cli::SensorCommandAction::Clear) {
      battery->ClearFault();
      std::cout << "success\n";
      return 0;
    }

    g_stop_requested.store(false);
    SignalGuard sigint_guard(SIGINT);
    TerminalRawMode terminal_raw_mode;

    using namespace std::chrono_literals;
    const bool in_place_refresh =
        isatty(STDOUT_FILENO) != 0 && std::getenv("TERM") != nullptr && std::string(std::getenv("TERM")) != "dumb";
    std::size_t previous_line_count = 0;
    while (!g_stop_requested.load()) {
      if (QuitKeyPressed()) {
        break;
      }

      const encos::BatteryStatus status = battery->GetStatus();
      const std::string report = motor_cli::BuildBatteryReport(status);
      if (in_place_refresh) {
        std::cout << motor_cli::BuildBatteryInPlaceRefreshPrefix(previous_line_count);
      } else if (previous_line_count != 0) {
        std::cout << '\n';
      }
      std::cout << report << std::flush;
      previous_line_count = static_cast<std::size_t>(std::count(report.begin(), report.end(), '\n'));
      std::this_thread::sleep_for(20ms);
    }
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "Error: " << error.what() << '\n';
    return 1;
  }
}
