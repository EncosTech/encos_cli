#include "src/cli/pms.h"

#include <encos/encos_motor.h>
#include <encos/pms/pms.h>
#include <sys/select.h>
#include <termios.h>
#include <unistd.h>

#include <atomic>
#include <chrono>
#include <csignal>
#include <cstdint>
#include <cstdlib>
#include <iomanip>
#include <iostream>
#include <optional>
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
    if (!isatty(STDIN_FILENO) || tcgetattr(STDIN_FILENO, &original_) != 0) {
      return;
    }
    termios raw = original_;
    raw.c_lflag = static_cast<tcflag_t>(raw.c_lflag & ~(ICANON | ECHO));
    raw.c_cc[VMIN] = 0;
    raw.c_cc[VTIME] = 0;
    active_ = tcsetattr(STDIN_FILENO, TCSANOW, &raw) == 0;
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
  return read(STDIN_FILENO, &input, 1) == 1 && (input == 'q' || input == 'Q');
}

encos::Bus* OpenBus(const motor_cli::PmsTarget& target) {
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

std::string FormatPmsValue(const std::optional<float>& value) {
  if (!value.has_value()) {
    return "";
  }
  std::ostringstream output;
  output << std::fixed << std::setprecision(6) << *value;
  return output.str();
}

std::string FormatPmsLine(const std::string& name, const std::string& enabled, const std::optional<float>& value) {
  std::ostringstream output;
  output << std::left << std::setw(12) << name << std::setw(10) << enabled << FormatPmsValue(value);
  return output.str();
}

std::string FormatPmsTextLine(const std::string& name, const std::string& enabled, const std::string& value) {
  std::ostringstream output;
  output << std::left << std::setw(12) << name << std::setw(10) << enabled << value;
  return output.str();
}

std::string BuildPmsReport(const std::optional<encos::PmsStatus>& status) {
  std::ostringstream output;
  output << std::left << std::setw(12) << "item" << std::setw(10) << "enabled" << "value\n";
  for (std::size_t index = 0; index < 6; ++index) {
    const std::string name = "V48_" + std::to_string(index + 1);
    const std::string enabled = status.has_value() ? (status->v48_channel_enabled[index] ? "yes" : "no") : "";
    const std::optional<float> current =
        status.has_value() ? std::optional<float>(status->v48_currents[index]) : std::nullopt;
    output << FormatPmsLine(name, enabled, current) << '\n';
  }
  std::string v19_current;
  if (status.has_value()) {
    std::ostringstream value;
    value << std::fixed << std::setprecision(6) << status->v19_currents[0] << " / " << status->v19_currents[1];
    v19_current = value.str();
  }
  output << FormatPmsTextLine("V19", "", v19_current) << '\n';
  output << FormatPmsLine("V5", "", status ? std::optional<float>(status->v5_current) : std::nullopt) << '\n';
  output << FormatPmsLine("battery_soc", "", status ? std::optional<float>(status->battery_soc) : std::nullopt) << '\n';
  output << FormatPmsLine("battery_voltage", "", status ? std::optional<float>(status->battery_voltage) : std::nullopt)
         << '\n';
  output << FormatPmsLine("battery_current", "", status ? std::optional<float>(status->battery_current) : std::nullopt)
         << '\n';
  return output.str();
}

encos::PmsCommand ToDriverCommand(motor_cli::PmsCommandAction action, motor_cli::PmsChannel channel) {
  const std::uint16_t offset = static_cast<std::uint16_t>(channel);
  const std::uint16_t bit = static_cast<std::uint16_t>(1U << (action == motor_cli::PmsCommandAction::Enable ? 8U : 0U));
  return static_cast<encos::PmsCommand>(bit << offset);
}

}  // namespace

namespace motor_cli {

std::string BuildPmsInPlaceRefreshPrefix(std::size_t report_line_count) {
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

int RunPmsCommand(int argc, char** argv) {
  if (argc >= 3 && (std::string(argv[2]) == "-h" || std::string(argv[2]) == "--help")) {
    std::cout << motor_cli::BuildPmsHelp();
    return 0;
  }

  std::vector<std::string> arguments;
  for (int index = 1; index < argc; ++index) {
    arguments.emplace_back(argv[index]);
  }

  motor_cli::PmsCommand command;
  try {
    command = motor_cli::ParsePmsCommand(arguments);
  } catch (const std::exception& error) {
    std::cerr << "Error: " << error.what() << '\n' << motor_cli::BuildPmsHelp();
    return 1;
  }

  try {
    encos::Bus* bus = OpenBus(command.target);
    encos::Pms* pms = bus->GetPms();
    if (!pms) {
      throw std::runtime_error("Failed to get target PMS");
    }
    if (command.action != motor_cli::PmsCommandAction::Show) {
      encos::PmsCommand driver_command = encos::PmsCommand::None;
      for (const motor_cli::PmsChannel channel : command.channels) {
        driver_command = driver_command | ToDriverCommand(command.action, channel);
      }
      pms->SendCommand(driver_command);
      std::cout << "success\n";
      return 0;
    }

    g_stop_requested.store(false);
    SignalGuard sigint_guard(SIGINT);
    TerminalRawMode terminal_raw_mode;
    const bool in_place_refresh =
        isatty(STDOUT_FILENO) != 0 && std::getenv("TERM") != nullptr && std::string(std::getenv("TERM")) != "dumb";
    std::size_t previous_line_count = 0;
    while (!g_stop_requested.load()) {
      if (QuitKeyPressed()) {
        break;
      }
      const std::string report = BuildPmsReport(pms->GetStatus());
      if (in_place_refresh) {
        std::cout << motor_cli::BuildPmsInPlaceRefreshPrefix(previous_line_count);
      } else if (previous_line_count != 0) {
        std::cout << '\n';
      }
      std::cout << report << std::flush;
      previous_line_count = 12;
      std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "Error: " << error.what() << '\n';
    return 1;
  }
}
