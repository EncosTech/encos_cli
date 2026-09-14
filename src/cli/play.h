#pragma once

#include <encos/encos_motor.h>

#include <argparse/argparse.hpp>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <optional>
#include <string>
#include <vector>

enum class PlaySortColumn {
  Adapter,
  Slave,
  Bus,
  Id,
  Position,
  Speed,
  Current,
  Torque,
  MotorTemperature,
  MosTemperature,
  Sent,
  Received,
  Loss,
  Loss3s,
  Error,
};

enum class PlayTuiAction {
  ScrollLeft,
  ScrollRight,
  ScrollUp,
  ScrollDown,
  PageUp,
  PageDown,
  PreviousSortColumn,
  NextSortColumn,
  ToggleSortDirection,
};

struct PlayTuiState {
  int scroll_x{0};
  int scroll_y{0};
  int content_width{0};
  int content_height{0};
  int viewport_width{0};
  int viewport_height{0};
  std::size_t sort_column_count{static_cast<std::size_t>(PlaySortColumn::Error) + 1U};
  PlaySortColumn sort_column{PlaySortColumn::Id};
  bool sort_ascending{true};
};

struct PlayMotorSnapshot {
  std::string name;
  std::string adapter_type;
  std::string adapter_id;
  std::optional<int32_t> slave_id;
  int32_t bus_id{0};
  int32_t motor_id{0};
  float position_rad{0.0f};
  float speed_rad_s{0.0f};
  float current_a{0.0f};
  float torque_nm{0.0f};
  float motor_temperature_c{0.0f};
  float mos_temperature_c{0.0f};
  encos::MotorError error{encos::MotorError::NoResponse};
  std::uint64_t sent{0};
  std::uint64_t received{0};
  std::uint64_t window_sent{0};
  std::uint64_t window_received{0};
};

struct PlayPacketCounts {
  std::uint64_t sent{0};
  std::uint64_t received{0};
};

// Sampled on the TUI thread; the window boundary has refresh-period resolution.
class PlayLossWindow {
public:
  PlayPacketCounts Update(std::chrono::steady_clock::time_point now, std::uint64_t sent, std::uint64_t received);

private:
  struct Sample {
    std::chrono::steady_clock::time_point time;
    PlayPacketCounts counts;
  };
  std::deque<Sample> samples_;
};

struct PlayPauseClock {
  bool paused{false};
  std::chrono::steady_clock::time_point pause_started{};
  std::chrono::steady_clock::duration paused_duration{};
};

std::chrono::steady_clock::time_point NextPlayControlTick(std::chrono::steady_clock::time_point previous_tick,
                                                          std::chrono::steady_clock::duration control_period,
                                                          std::chrono::steady_clock::time_point now);
std::chrono::steady_clock::time_point NextPlayRefreshTick(std::chrono::steady_clock::time_point previous_tick,
                                                          std::chrono::steady_clock::duration refresh_period,
                                                          std::chrono::steady_clock::time_point now);
bool IsPlayEndless(bool endless, bool stress);
bool ShouldReturnToInitialPosition(bool playback_finished, bool endless);
bool ShouldUsePlayTui(bool stdin_is_tty, bool stdout_is_tty, const std::string& terminal, bool no_inplace_refresh);
std::chrono::steady_clock::time_point UpdatePlayPauseClock(PlayPauseClock& state, bool pause_requested,
                                                           std::chrono::steady_clock::time_point now);
std::string BuildPlayMotorLogBaseName(const std::string& log_directory, const std::string& motor_name,
                                      std::size_t motor_index);
std::string PlayMotorErrorName(encos::MotorError error);
std::string PlayMotorLossText(std::uint64_t sent, std::uint64_t received);
std::string PlaySlaveText(const std::optional<int32_t>& slave_id);
std::vector<PlayMotorSnapshot> SortPlayMotorSnapshots(std::vector<PlayMotorSnapshot> snapshots, PlaySortColumn column,
                                                      bool ascending);
std::vector<std::string> NormalizePlayLogArguments(const std::vector<std::string>& arguments);
void ApplyPlayTuiAction(PlayTuiState& state, PlayTuiAction action);

void ConfigurePlayCommand(argparse::ArgumentParser& parser);
int RunPlayCommand(const argparse::ArgumentParser& parser);
