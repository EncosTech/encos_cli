#include <argparse/argparse.hpp>
#include <chrono>
#include <doctest.hpp>
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
  CHECK(help.find("--stress") != std::string::npos);
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

TEST_CASE("Play stress refresh uses in-place output only for interactive terminals") {
  CHECK(SupportsPlayStressInPlaceRefresh(true, "xterm-256color"));
  CHECK_FALSE(SupportsPlayStressInPlaceRefresh(false, "xterm-256color"));
  CHECK_FALSE(SupportsPlayStressInPlaceRefresh(true, "dumb"));
}

TEST_CASE("Play stress log names are stored beneath the working-directory logs folder") {
  CHECK(BuildPlayStressMotorLogBaseName("left hip", 0) == "logs/left_hip_0");
  CHECK(BuildPlayStressMotorLogBaseName("motor/2", 3) == "logs/motor_2_3");
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

}  // namespace
}  // namespace motor_cli
