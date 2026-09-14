#include <argparse/argparse.hpp>
#include <chrono>
#include <doctest.hpp>
#include <limits>
#include <sstream>
#include <string>

#include "src/cli/play.h"

namespace motor_cli {
namespace {

TEST_CASE("Play help output contains play description") {
  argparse::ArgumentParser play_parser("play");
  ConfigurePlayCommand(play_parser);
  std::ostringstream output;
  output << play_parser;
  const std::string help = output.str();
  CHECK(help.find("Play") != std::string::npos);
  CHECK(help.find("--canfd") == std::string::npos);
  CHECK(help.find("--dry-run") != std::string::npos);
  CHECK(help.find("--endless") != std::string::npos);
  CHECK(help.find("--stress") == std::string::npos);
  CHECK(help.find("--tui") != std::string::npos);
  CHECK(help.find("--no-inplace-refresh") != std::string::npos);
  CHECK(help.find("--log") != std::string::npos);
  CHECK(help.find("--control-frequency") != std::string::npos);
  CHECK(help.find("--max-speed") != std::string::npos);
  CHECK(help.find("--max-current") != std::string::npos);
  CHECK(help.find("--kp") != std::string::npos);
  CHECK(help.find("--kd") != std::string::npos);
  CHECK(help.find("--vel") != std::string::npos);
  CHECK(help.find("--tor") != std::string::npos);
  CHECK(help.find("config") != std::string::npos);
}

TEST_CASE("Play control scheduling waits until the next deadline or resets after an overrun") {
  using Clock = std::chrono::steady_clock;
  const Clock::time_point previous_tick{};
  const auto control_period = std::chrono::milliseconds(1);

  CHECK(NextPlayControlTick(previous_tick, control_period, previous_tick + std::chrono::microseconds(250)) ==
        previous_tick + control_period);
  const auto overrun_time = previous_tick + std::chrono::milliseconds(3);
  CHECK(NextPlayControlTick(previous_tick, control_period, overrun_time) == overrun_time);
}

TEST_CASE("Play TUI refresh scheduling skips missed frames after an overrun") {
  using Clock = std::chrono::steady_clock;
  const Clock::time_point previous_tick{};
  const auto refresh_period = std::chrono::milliseconds(50);

  CHECK(NextPlayRefreshTick(previous_tick, refresh_period, previous_tick + std::chrono::milliseconds(10)) ==
        previous_tick + refresh_period);
  const auto overrun_time = previous_tick + std::chrono::milliseconds(125);
  CHECK(NextPlayRefreshTick(previous_tick, refresh_period, overrun_time) == overrun_time + refresh_period);
}

TEST_CASE("Play stress mode does not enable endless playback") {
  argparse::ArgumentParser play_parser("play");
  ConfigurePlayCommand(play_parser);

  play_parser.parse_args({"play", "trajectory.csv", "--stress"});

  CHECK(play_parser.get<bool>("--stress"));
  CHECK(!play_parser.get<bool>("--endless"));
  CHECK_FALSE(IsPlayEndless(play_parser.get<bool>("--endless"), play_parser.get<bool>("--stress")));
}

TEST_CASE("Play endless option does not enable stress mode") {
  argparse::ArgumentParser play_parser("play");
  ConfigurePlayCommand(play_parser);

  play_parser.parse_args({"play", "trajectory.csv", "--endless"});

  CHECK(play_parser.get<bool>("--endless"));
  CHECK(!play_parser.get<bool>("--stress"));
  CHECK(IsPlayEndless(play_parser.get<bool>("--endless"), play_parser.get<bool>("--stress")));
}

TEST_CASE("Play returns smoothly to its initial position after one-shot playback") {
  CHECK(ShouldReturnToInitialPosition(true, false));
  CHECK_FALSE(ShouldReturnToInitialPosition(false, false));
  CHECK_FALSE(ShouldReturnToInitialPosition(true, true));
}

TEST_CASE("Play selects TUI automatically and supports forced plain output") {
  CHECK(ShouldUsePlayTui(true, true, "xterm-256color", false));
  CHECK_FALSE(ShouldUsePlayTui(false, true, "xterm-256color", false));
  CHECK_FALSE(ShouldUsePlayTui(true, false, "xterm-256color", false));
  CHECK_FALSE(ShouldUsePlayTui(true, true, "dumb", false));
  CHECK_FALSE(ShouldUsePlayTui(true, true, "xterm-256color", true));
}

TEST_CASE("Play pause clock freezes and resumes the trajectory timeline") {
  using Clock = std::chrono::steady_clock;
  const Clock::time_point start{};
  PlayPauseClock state;

  CHECK(UpdatePlayPauseClock(state, false, start + std::chrono::seconds(3)) == start + std::chrono::seconds(3));
  CHECK(UpdatePlayPauseClock(state, true, start + std::chrono::seconds(5)) == start + std::chrono::seconds(5));
  CHECK(UpdatePlayPauseClock(state, true, start + std::chrono::seconds(9)) == start + std::chrono::seconds(5));
  CHECK(UpdatePlayPauseClock(state, false, start + std::chrono::seconds(10)) == start + std::chrono::seconds(5));
  CHECK(UpdatePlayPauseClock(state, false, start + std::chrono::seconds(12)) == start + std::chrono::seconds(7));
}

TEST_CASE("Play rejects invalid arguments") {
  argparse::ArgumentParser play_parser("play");
  ConfigurePlayCommand(play_parser);

  CHECK_THROWS_AS(play_parser.parse_args({"play"}), std::runtime_error);
}

TEST_CASE("Play parses valid arguments in mixed order") {
  argparse::ArgumentParser play_parser("play");
  ConfigurePlayCommand(play_parser);

  play_parser.parse_args({"play", "--dry-run", "--endless", "--max-speed", "12", "--max-current", "8", "--kp", "20",
                          "--kd", "1", "--vel", "10", "--tor", "0.5", "trajectory.csv"});
  CHECK(play_parser.get<bool>("--dry-run"));
  CHECK(play_parser.get<bool>("--endless"));
  CHECK(play_parser.get<float>("--max-speed") == doctest::Approx(12.0f));
  CHECK(play_parser.get<float>("--max-current") == doctest::Approx(8.0f));
  CHECK(play_parser.present<float>("--kp").value() == doctest::Approx(20.0f));
  CHECK(play_parser.present<float>("--kd").value() == doctest::Approx(1.0f));
  CHECK(play_parser.present<float>("--vel").value() == doctest::Approx(10.0f));
  CHECK(play_parser.present<float>("--tor").value() == doctest::Approx(0.5f));
  CHECK(play_parser.get<std::string>("config") == "trajectory.csv");

  argparse::ArgumentParser play_parser2("play");
  ConfigurePlayCommand(play_parser2);
  play_parser2.parse_args({"play", "trajectory.csv"});
  CHECK(!play_parser2.get<bool>("--dry-run"));
  CHECK(!play_parser2.get<bool>("--endless"));
  CHECK(play_parser2.get<float>("--max-speed") == doctest::Approx(20.0f));
  CHECK(play_parser2.get<float>("--max-current") == doctest::Approx(10.0f));
  CHECK(!play_parser2.present<float>("--kp").has_value());
  CHECK(!play_parser2.present<float>("--kd").has_value());
  CHECK(!play_parser2.present<float>("--vel").has_value());
  CHECK(!play_parser2.present<float>("--tor").has_value());
  CHECK(play_parser2.get<int>("--control-frequency") == 1000);
  CHECK(play_parser2.get<std::string>("config") == "trajectory.csv");

  argparse::ArgumentParser play_parser3("play");
  ConfigurePlayCommand(play_parser3);
  CHECK_THROWS_AS(play_parser3.parse_args({"play", "trajectory.csv", "--canfd"}), std::runtime_error);
}

TEST_CASE("Play accepts a custom control frequency") {
  argparse::ArgumentParser play_parser("play");
  ConfigurePlayCommand(play_parser);

  play_parser.parse_args({"play", "trajectory.csv", "--control-frequency", "500"});

  CHECK(play_parser.get<int>("--control-frequency") == 500);
}

TEST_CASE("Play parses TUI and optional log directory") {
  argparse::ArgumentParser default_log_parser("play");
  ConfigurePlayCommand(default_log_parser);
  default_log_parser.parse_args({"play", "--log", "trajectory.csv", "--tui"});
  CHECK(default_log_parser.get<bool>("--tui"));
  CHECK(default_log_parser.is_used("--log"));
  CHECK(default_log_parser.get<bool>("--log"));

  argparse::ArgumentParser compatibility_parser("play");
  ConfigurePlayCommand(compatibility_parser);
  compatibility_parser.parse_args({"play", "trajectory.csv", "--stress", "--no-inplace-refresh"});
  CHECK(compatibility_parser.get<bool>("--stress"));
  CHECK(compatibility_parser.get<bool>("--no-inplace-refresh"));

  argparse::ArgumentParser custom_log_parser("play");
  ConfigurePlayCommand(custom_log_parser);
  custom_log_parser.parse_args(NormalizePlayLogArguments({"play", "trajectory.csv", "--log=./motor-logs"}));
  CHECK_FALSE(custom_log_parser.get<bool>("--tui"));
  CHECK(custom_log_parser.is_used("--log-directory"));
  CHECK(custom_log_parser.get<std::string>("--log-directory") == "./motor-logs");

  argparse::ArgumentParser no_log_parser("play");
  ConfigurePlayCommand(no_log_parser);
  no_log_parser.parse_args({"play", "trajectory.csv", "--stress"});
  CHECK_FALSE(no_log_parser.get<bool>("--log"));
}

TEST_CASE("Play log assignment normalization leaves unrelated arguments unchanged") {
  CHECK(NormalizePlayLogArguments({"emcli", "play", "--log=./capture", "trajectory.csv"}) ==
        std::vector<std::string>{"emcli", "play", "--log-directory", "./capture", "trajectory.csv"});
  CHECK(NormalizePlayLogArguments({"emcli", "play", "--stress", "trajectory.csv"}) ==
        std::vector<std::string>{"emcli", "play", "--stress", "trajectory.csv"});
}

TEST_CASE("Play TUI viewport supports bounded two-dimensional scrolling") {
  PlayTuiState state;
  state.content_width = 200;
  state.content_height = 100;
  state.viewport_width = 80;
  state.viewport_height = 20;
  ApplyPlayTuiAction(state, PlayTuiAction::ScrollRight);
  ApplyPlayTuiAction(state, PlayTuiAction::ScrollDown);
  CHECK(state.scroll_x == 4);
  CHECK(state.scroll_y == 1);

  ApplyPlayTuiAction(state, PlayTuiAction::PageDown);
  CHECK(state.scroll_y == 21);

  for (int index = 0; index < 30; ++index) {
    ApplyPlayTuiAction(state, PlayTuiAction::PageDown);
    ApplyPlayTuiAction(state, PlayTuiAction::ScrollRight);
  }
  CHECK(state.scroll_x == 120);
  CHECK(state.scroll_y == 80);

  for (int index = 0; index < 30; ++index) {
    ApplyPlayTuiAction(state, PlayTuiAction::PageUp);
    ApplyPlayTuiAction(state, PlayTuiAction::ScrollLeft);
  }
  CHECK(state.scroll_x == 0);
  CHECK(state.scroll_y == 0);
}

TEST_CASE("Play TUI sort selection wraps and toggles direction") {
  PlayTuiState state;
  CHECK(state.sort_column == PlaySortColumn::Id);
  CHECK(state.sort_ascending);

  ApplyPlayTuiAction(state, PlayTuiAction::NextSortColumn);
  CHECK(state.sort_column == PlaySortColumn::Position);
  ApplyPlayTuiAction(state, PlayTuiAction::PreviousSortColumn);
  CHECK(state.sort_column == PlaySortColumn::Id);
  ApplyPlayTuiAction(state, PlayTuiAction::ToggleSortDirection);
  CHECK_FALSE(state.sort_ascending);

  state.sort_column = PlaySortColumn::Adapter;
  ApplyPlayTuiAction(state, PlayTuiAction::PreviousSortColumn);
  CHECK(state.sort_column == PlaySortColumn::Error);

  state.sort_column_count = static_cast<std::size_t>(PlaySortColumn::Error) + 1U;
  state.sort_column = PlaySortColumn::MosTemperature;
  ApplyPlayTuiAction(state, PlayTuiAction::NextSortColumn);
  CHECK(state.sort_column == PlaySortColumn::Sent);
  ApplyPlayTuiAction(state, PlayTuiAction::PreviousSortColumn);
  CHECK(state.sort_column == PlaySortColumn::MosTemperature);

  state.sort_column = PlaySortColumn::Loss;
  ApplyPlayTuiAction(state, PlayTuiAction::NextSortColumn);
  CHECK(state.sort_column == PlaySortColumn::Loss3s);
  ApplyPlayTuiAction(state, PlayTuiAction::NextSortColumn);
  CHECK(state.sort_column == PlaySortColumn::Error);
  ApplyPlayTuiAction(state, PlayTuiAction::NextSortColumn);
  CHECK(state.sort_column == PlaySortColumn::Adapter);
}

TEST_CASE("Play stress counters and loss are sortable") {
  std::vector<PlayMotorSnapshot> snapshots(3);
  snapshots[0].motor_id = 1;
  snapshots[0].sent = 100;
  snapshots[0].received = 90;
  snapshots[1].motor_id = 2;
  snapshots[1].sent = 50;
  snapshots[1].received = 49;
  snapshots[2].motor_id = 3;
  snapshots[2].sent = 200;
  snapshots[2].received = 100;

  const auto by_sent = SortPlayMotorSnapshots(snapshots, PlaySortColumn::Sent, true);
  CHECK(by_sent[0].motor_id == 2);
  CHECK(by_sent[2].motor_id == 3);

  const auto by_received = SortPlayMotorSnapshots(snapshots, PlaySortColumn::Received, false);
  CHECK(by_received[0].motor_id == 3);
  CHECK(by_received[2].motor_id == 2);

  const auto by_loss = SortPlayMotorSnapshots(std::move(snapshots), PlaySortColumn::Loss, false);
  CHECK(by_loss[0].motor_id == 3);
  CHECK(by_loss[2].motor_id == 2);
}

TEST_CASE("Play motor snapshots default to motor id ascending") {
  std::vector<PlayMotorSnapshot> snapshots(3);
  snapshots[0].motor_id = 12;
  snapshots[1].motor_id = 2;
  snapshots[2].motor_id = 7;

  const auto sorted = SortPlayMotorSnapshots(std::move(snapshots), PlaySortColumn::Id, true);
  CHECK(sorted[0].motor_id == 2);
  CHECK(sorted[1].motor_id == 7);
  CHECK(sorted[2].motor_id == 12);
}

TEST_CASE("Play motor snapshots support numeric descending sorts with stable identity tie breaks") {
  std::vector<PlayMotorSnapshot> snapshots(3);
  snapshots[0].adapter_id = "eth1";
  snapshots[0].motor_id = 1;
  snapshots[0].speed_rad_s = 4.0f;
  snapshots[1].adapter_id = "eth0";
  snapshots[1].motor_id = 2;
  snapshots[1].speed_rad_s = 9.0f;
  snapshots[2].adapter_id = "eth0";
  snapshots[2].motor_id = 1;
  snapshots[2].speed_rad_s = 9.0f;

  const auto sorted = SortPlayMotorSnapshots(std::move(snapshots), PlaySortColumn::Speed, false);
  CHECK(sorted[0].adapter_id == "eth0");
  CHECK(sorted[0].motor_id == 1);
  CHECK(sorted[1].adapter_id == "eth0");
  CHECK(sorted[1].motor_id == 2);
  CHECK(sorted[2].adapter_id == "eth1");
}

TEST_CASE("Play motor snapshots keep unavailable telemetry last in either direction") {
  std::vector<PlayMotorSnapshot> snapshots(2);
  snapshots[0].motor_id = 1;
  snapshots[0].speed_rad_s = std::numeric_limits<float>::quiet_NaN();
  snapshots[1].motor_id = 2;
  snapshots[1].speed_rad_s = 5.0f;

  const auto ascending = SortPlayMotorSnapshots(snapshots, PlaySortColumn::Speed, true);
  const auto descending = SortPlayMotorSnapshots(std::move(snapshots), PlaySortColumn::Speed, false);
  CHECK(ascending[0].motor_id == 2);
  CHECK(ascending[1].motor_id == 1);
  CHECK(descending[0].motor_id == 2);
  CHECK(descending[1].motor_id == 1);
}

TEST_CASE("Play log paths and motor errors have readable representations") {
  CHECK(BuildPlayMotorLogBaseName("./capture", "left hip", 3) == "./capture/left_hip_3");
  CHECK(PlayMotorErrorName(encos::MotorError::NoError) == "NoError(0)");
  CHECK(PlayMotorErrorName(encos::MotorError::OverCurrent) == "OverCurrent(2)");
  CHECK(PlayMotorErrorName(static_cast<encos::MotorError>(42)) == "Unknown(42)");
}

TEST_CASE("Play table formats missing slaves and loss count with percentage") {
  CHECK(PlaySlaveText(std::nullopt) == "0");
  CHECK(PlaySlaveText(3) == "3");
  CHECK(PlayMotorLossText(10000, 9998) == "2 (0.02%)");
  CHECK(PlayMotorLossText(0, 0) == "0 (0.00%)");
  CHECK(PlayMotorLossText(10, 12) == "0 (0.00%)");
}

TEST_CASE("Play three second loss window expires old losses and idle traffic") {
  using namespace std::chrono;
  const steady_clock::time_point start{};
  PlayLossWindow window;
  window.Update(start, 0, 0);
  auto counts = window.Update(start + seconds(1), 100, 50);
  CHECK(PlayMotorLossText(counts.sent, counts.received) == "50 (50.00%)");
  counts = window.Update(start + seconds(3), 300, 250);
  CHECK(counts.sent == 300);
  CHECK(counts.received == 250);
  counts = window.Update(start + seconds(4), 400, 350);
  CHECK(PlayMotorLossText(counts.sent, counts.received) == "0 (0.00%)");
  counts = window.Update(start + seconds(8), 400, 350);
  CHECK(counts.sent == 0);
  CHECK(counts.received == 0);
}

TEST_CASE("Play three second loss window handles counter reset and excess replies") {
  using namespace std::chrono;
  const steady_clock::time_point start{};
  PlayLossWindow window;
  window.Update(start, 100, 90);
  auto counts = window.Update(start + seconds(1), 110, 102);
  CHECK(PlayMotorLossText(counts.sent, counts.received) == "0 (0.00%)");
  counts = window.Update(start + seconds(2), 0, 0);
  CHECK(counts.sent == 0);
  CHECK(counts.received == 0);
  counts = window.Update(start + seconds(3), 10, 5);
  CHECK(PlayMotorLossText(counts.sent, counts.received) == "5 (50.00%)");
}

TEST_CASE("Play three second loss sorting uses window counts") {
  std::vector<PlayMotorSnapshot> snapshots(2);
  snapshots[0].motor_id = 1;
  snapshots[0].sent = 1000;
  snapshots[0].received = 500;
  snapshots[0].window_sent = 100;
  snapshots[0].window_received = 100;
  snapshots[1].motor_id = 2;
  snapshots[1].sent = 1000;
  snapshots[1].received = 990;
  snapshots[1].window_sent = 100;
  snapshots[1].window_received = 90;
  CHECK(SortPlayMotorSnapshots(snapshots, PlaySortColumn::Loss3s, true)[0].motor_id == 1);
  CHECK(SortPlayMotorSnapshots(snapshots, PlaySortColumn::Loss3s, false)[0].motor_id == 2);
}

}  // namespace
}  // namespace motor_cli
