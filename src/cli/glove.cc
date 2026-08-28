#include "src/cli/glove.h"

#include <encos/encos_motor.h>
#include <encos/glove/glove.h>
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
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#include "cli_command.h"
#include "components/math_constants.h"
#include "src/cli/interface_name.h"

namespace {

constexpr std::size_t kGloveReportLineCount = 12;
constexpr std::size_t kGloveFingerCount = 5;
constexpr std::size_t kGloveEncodersPerFinger = 10;

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

encos::Glove* OpenGlove(const motor_cli::GloveTarget& target) {
  encos::BaseAdapterPtr adapter =
      encos::MakeAdapter(target.adapter_type, target.adapter_id,
                         motor_cli::GetLoggerName(target.adapter_type, target.adapter_id), encos::LogLevel::Warn);
  if (!adapter) {
    throw std::runtime_error("Failed to create adapter: '" + target.adapter_type + ":" + target.adapter_id + "'");
  }
  encos::Glove* glove = adapter->GetGlove(target.slave_id);
  if (!glove) {
    throw std::runtime_error("Failed to get target glove");
  }
  return glove;
}

std::string FormatAngleCell(const encos::GloveEncoderStatus& encoder) {
  std::ostringstream output;
  output << std::right << std::setw(9);
  if (!encoder.has_value()) {
    output << "OFF";
  } else {
    output << std::fixed << std::setprecision(2) << *encoder * motor_cli::kRadiansToDegrees;
  }
  return output.str();
}

std::string BuildGloveReport(const encos::GloveStatus& status) {
  std::ostringstream output;
  std::size_t online_count = 0;
  for (const auto& finger : status) {
    for (const auto& encoder : finger) {
      if (encoder.has_value()) {
        ++online_count;
      }
    }
  }
  output << "online: " << online_count << "/50\n";

  output << std::left << std::setw(4) << "enc";
  for (std::size_t finger = 0; finger < kGloveFingerCount; ++finger) {
    output << std::right << std::setw(9) << ("F" + std::to_string(finger));
  }
  output << '\n';

  for (std::size_t encoder = 0; encoder < kGloveEncodersPerFinger; ++encoder) {
    output << std::left << std::setw(4) << ("E" + std::to_string(encoder));
    for (std::size_t finger = 0; finger < kGloveFingerCount; ++finger) {
      output << FormatAngleCell(status[finger][encoder]);
    }
    output << '\n';
  }
  return output.str();
}

std::string FormatCalibrationResult(encos::GloveCalibrationStatus status) {
  switch (status) {
    case encos::GloveCalibrationStatus::Success:
      return "Calibration succeeded";
    case encos::GloveCalibrationStatus::Failed:
      return "Calibration failed";
    case encos::GloveCalibrationStatus::Limited:
      return "Calibration failed: current limited";
    case encos::GloveCalibrationStatus::Timeout:
      return "Calibration timed out";
  }
  return "Calibration returned unknown status";
}

int RunGloveCalibrate(encos::Glove* glove, const motor_cli::GloveCommand& command) {
  // 等待数据通道就绪（从站进 OP 且固件开始上报）后再发送校准命令，
  // 否则命令脉冲会在从站完成状态转换前丢失。
  constexpr auto kReadyTimeout = std::chrono::seconds(5);
  const auto ready_deadline = std::chrono::steady_clock::now() + kReadyTimeout;
  while (true) {
    const auto status = glove->GetStatus();
    bool has_any_data = false;
    for (const auto& finger : status) {
      for (const auto& encoder : finger) {
        if (encoder.has_value()) {
          has_any_data = true;
          break;
        }
      }
      if (has_any_data) break;
    }
    if (has_any_data) break;
    if (std::chrono::steady_clock::now() >= ready_deadline) {
      std::cerr << "Warning: glove status not ready, sending calibration anyway\n";
      break;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
  }

  // 校准为同步调用：All 模式由驱动按手指 0-4 依次校准并聚合结果；单指/掩码
  // 模式校准目标手指上掩码选中的编码器。手指无响应时驱动返回 Timeout。
  encos::GloveCalibrationStatus calibration_status;
  switch (command.calibration_mode) {
    case motor_cli::GloveCalibrationMode::All:
      calibration_status = glove->CalibrateAll();
      break;
    case motor_cli::GloveCalibrationMode::Single:
      calibration_status = glove->CalibrateByMask(command.finger_idx, ENCOS_GLOVE_CALI_E(command.encoder_idx));
      break;
    case motor_cli::GloveCalibrationMode::Mask:
      calibration_status = glove->CalibrateByMask(command.finger_idx, command.encoder_mask);
      break;
    default:
      throw std::runtime_error("Unsupported glove calibration mode");
  }

  if (command.calibration_mode != motor_cli::GloveCalibrationMode::All) {
    std::cout << 'F' << static_cast<int>(command.finger_idx) << ": ";
  }
  std::cout << FormatCalibrationResult(calibration_status) << '\n';
  return calibration_status == encos::GloveCalibrationStatus::Success ? 0 : 1;
}

}  // namespace

namespace motor_cli {

std::string BuildGloveInPlaceRefreshPrefix(std::size_t report_line_count) {
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

int RunGloveCommand(int argc, char** argv) {
  if (argc >= 3 && (std::string(argv[2]) == "-h" || std::string(argv[2]) == "--help")) {
    std::cout << motor_cli::BuildGloveHelp();
    return 0;
  }

  std::vector<std::string> arguments;
  for (int index = 1; index < argc; ++index) {
    arguments.emplace_back(argv[index]);
  }

  motor_cli::GloveCommand command;
  try {
    command = motor_cli::ParseGloveCommand(arguments);
  } catch (const std::exception& error) {
    std::cerr << "Error: " << error.what() << '\n' << motor_cli::BuildGloveHelp();
    return 1;
  }

  try {
    encos::Glove* glove = OpenGlove(command.target);
    if (command.action == motor_cli::GloveCommandAction::Calibrate) {
      return RunGloveCalibrate(glove, command);
    }

    g_stop_requested.store(false);
    SignalGuard sigint_guard(SIGINT);
    TerminalRawMode terminal_raw_mode;
    const char* term = std::getenv("TERM");
    const bool in_place_refresh = isatty(STDOUT_FILENO) != 0 && term != nullptr && std::string(term) != "dumb";
    std::size_t previous_line_count = 0;
    while (!g_stop_requested.load()) {
      if (QuitKeyPressed()) {
        break;
      }
      const std::string report = BuildGloveReport(glove->GetStatus());
      if (in_place_refresh) {
        std::cout << motor_cli::BuildGloveInPlaceRefreshPrefix(previous_line_count);
      } else if (previous_line_count != 0) {
        std::cout << '\n';
      }
      std::cout << report << std::flush;
      previous_line_count = kGloveReportLineCount;
      std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "Error: " << error.what() << '\n';
    return 1;
  }
}
