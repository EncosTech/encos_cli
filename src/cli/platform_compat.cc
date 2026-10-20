#include "src/cli/platform_compat.h"

#include <cstdlib>
#include <string>
#include <thread>

#if defined(_WIN32)

// clang-format off
#include <winsock2.h>
#include <windows.h>
#include <conio.h>
#include <io.h>
// clang-format on

namespace motor_cli::platform {

namespace {

HANDLE InputStream() { return GetStdHandle(STD_INPUT_HANDLE); }

}  // namespace

bool StdinIsInteractive() { return _isatty(_fileno(stdin)) != 0; }

bool StdoutIsInteractive() { return _isatty(_fileno(stdout)) != 0; }

bool SupportsInPlaceRefresh() { return StdoutIsInteractive(); }

bool QuitKeyPressed() {
  if (!StdinIsInteractive() || !_kbhit()) {
    return false;
  }
  const int input = _getch();
  return input == 'q' || input == 'Q';
}

std::optional<TerminalDimensions> GetTerminalDimensions() {
  CONSOLE_SCREEN_BUFFER_INFO info{};
  if (GetConsoleScreenBufferInfo(GetStdHandle(STD_OUTPUT_HANDLE), &info) == 0) {
    return std::nullopt;
  }
  const int columns = info.srWindow.Right - info.srWindow.Left + 1;
  const int rows = info.srWindow.Bottom - info.srWindow.Top + 1;
  if (columns <= 0 || rows <= 0) {
    return std::nullopt;
  }
  return TerminalDimensions{columns, rows};
}

class TerminalRawMode::Impl {
public:
  Impl() {
    if (!StdinIsInteractive()) {
      return;
    }
    if (GetConsoleMode(InputStream(), &original_mode) == 0) {
      return;
    }
    DWORD mode = original_mode;
    mode &= ~(ENABLE_LINE_INPUT | ENABLE_ECHO_INPUT);
    if (SetConsoleMode(InputStream(), mode) != 0) {
      active = true;
    }
  }

  ~Impl() {
    if (active) {
      SetConsoleMode(InputStream(), original_mode);
    }
  }

  DWORD original_mode = 0;
  bool active = false;
};

TerminalRawMode::TerminalRawMode() : impl_(std::make_unique<Impl>()) {}
TerminalRawMode::~TerminalRawMode() = default;

bool TryLockMemoryPages() { return true; }

bool SetCurrentThreadAffinity(int cpu_index) {
  if (cpu_index < 0 || cpu_index >= 64) {
    return false;
  }
  return SetThreadAffinityMask(GetCurrentThread(), DWORD_PTR{1} << cpu_index) != 0;
}

int CpuCount() {
  const unsigned count = std::thread::hardware_concurrency();
  return count == 0 ? 1 : static_cast<int>(count);
}

}  // namespace motor_cli::platform

#else

#include <pthread.h>
#include <sched.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/select.h>
#include <termios.h>
#include <unistd.h>

namespace motor_cli::platform {

namespace {

std::string TermEnvironment() {
  const char* term = std::getenv("TERM");
  return term == nullptr ? std::string() : std::string(term);
}

}  // namespace

bool StdinIsInteractive() { return isatty(STDIN_FILENO) != 0; }

bool StdoutIsInteractive() { return isatty(STDOUT_FILENO) != 0; }

bool SupportsInPlaceRefresh() { return StdoutIsInteractive() && TermEnvironment() != "dumb"; }

bool QuitKeyPressed() {
  if (!StdinIsInteractive()) {
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

std::optional<TerminalDimensions> GetTerminalDimensions() {
  winsize size{};
  if (ioctl(STDOUT_FILENO, TIOCGWINSZ, &size) != 0 || size.ws_col == 0 || size.ws_row == 0) {
    return std::nullopt;
  }
  return TerminalDimensions{size.ws_col, size.ws_row};
}

class TerminalRawMode::Impl {
public:
  Impl() {
    if (!StdinIsInteractive()) {
      return;
    }
    if (tcgetattr(STDIN_FILENO, &original) != 0) {
      return;
    }
    termios raw = original;
    raw.c_lflag = static_cast<tcflag_t>(raw.c_lflag & ~(ICANON | ECHO));
    raw.c_cc[VMIN] = 0;
    raw.c_cc[VTIME] = 0;
    if (tcsetattr(STDIN_FILENO, TCSANOW, &raw) == 0) {
      active = true;
    }
  }

  ~Impl() {
    if (active) {
      tcsetattr(STDIN_FILENO, TCSANOW, &original);
    }
  }

  termios original{};
  bool active = false;
};

TerminalRawMode::TerminalRawMode() : impl_(std::make_unique<Impl>()) {}
TerminalRawMode::~TerminalRawMode() = default;

bool TryLockMemoryPages() { return mlockall(MCL_CURRENT | MCL_FUTURE) == 0; }

bool SetCurrentThreadAffinity(int cpu_index) {
  if (cpu_index < 0) {
    return false;
  }
  cpu_set_t cpuset;
  CPU_ZERO(&cpuset);
  CPU_SET(cpu_index, &cpuset);
  return pthread_setaffinity_np(pthread_self(), sizeof(cpu_set_t), &cpuset) == 0;
}

int CpuCount() {
  const long count = sysconf(_SC_NPROCESSORS_ONLN);
  return count <= 0 ? 1 : static_cast<int>(count);
}

}  // namespace motor_cli::platform

#endif
