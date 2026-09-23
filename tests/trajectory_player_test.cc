// SPDX-License-Identifier: MIT

#include "src/trajectory_player.h"

#include <doctest.hpp>
#include <vector>

namespace emplay {
namespace {

Trajectory BuildSimpleTrajectory() {
  Trajectory trajectory;
  trajectory.motor_names = {"Ethercat:eth0:0:1", "Ethercat:eth0:0:2"};
  trajectory.motor_connections = {
      emzero::ParseMotorConnection("Ethercat:eth0:0:1"),
      emzero::ParseMotorConnection("Ethercat:eth0:0:2"),
  };
  trajectory.samples = {
      TrajectorySample{0.0, {0.0f, 10.0f}},
      TrajectorySample{1.0, {10.0f, 30.0f}},
      TrajectorySample{2.0, {20.0f, 50.0f}},
  };
  return trajectory;
}

TEST_CASE("EvaluateTrajectory interpolates positions during forward playback") {
  const Trajectory trajectory = BuildSimpleTrajectory();

  const PlaybackState state = EvaluateTrajectory(trajectory, 0.5, false);
  REQUIRE(state.segment_start_index == 0U);
  REQUIRE(state.segment_end_index == 1U);
  REQUIRE(state.positions_deg.size() == 2U);
  CHECK(state.positions_deg[0] == doctest::Approx(5.0f));
  CHECK(state.positions_deg[1] == doctest::Approx(20.0f));
  CHECK(!state.finished);
}

TEST_CASE("EvaluateTrajectory clamps to final sample for one-shot playback") {
  const Trajectory trajectory = BuildSimpleTrajectory();

  const PlaybackState state = EvaluateTrajectory(trajectory, 5.0, false);
  REQUIRE(state.segment_start_index == 2U);
  REQUIRE(state.segment_end_index == 2U);
  CHECK(state.positions_deg[0] == doctest::Approx(20.0f));
  CHECK(state.positions_deg[1] == doctest::Approx(50.0f));
  CHECK(state.finished);
}

TEST_CASE("EvaluateTrajectory reverses after tail in endless playback") {
  const Trajectory trajectory = BuildSimpleTrajectory();

  const PlaybackState state = EvaluateTrajectory(trajectory, 2.5, true);
  REQUIRE(state.segment_start_index == 2U);
  REQUIRE(state.segment_end_index == 1U);
  CHECK(state.positions_deg[0] == doctest::Approx(15.0f));
  CHECK(state.positions_deg[1] == doctest::Approx(40.0f));
  CHECK(!state.finished);
}

TEST_CASE("FeedbackPrinterSchedule emits every half second") {
  FeedbackPrinterSchedule schedule(0.5);

  CHECK(schedule.ShouldPrint(0.0));
  CHECK(!schedule.ShouldPrint(0.1));
  CHECK(!schedule.ShouldPrint(0.49));
  CHECK(schedule.ShouldPrint(0.5));
  CHECK(!schedule.ShouldPrint(0.7));
  CHECK(schedule.ShouldPrint(1.0));
}

TEST_CASE("GetControlLoopOverrun returns zero when loop finishes on time") {
  const auto expected_tick = std::chrono::steady_clock::time_point{} + std::chrono::milliseconds(10);
  const auto actual_time = expected_tick;

  CHECK(GetControlLoopOverrun(expected_tick, actual_time) == std::chrono::microseconds(0));
}

TEST_CASE("GetControlLoopOverrun returns positive lateness when loop exceeds deadline") {
  const auto expected_tick = std::chrono::steady_clock::time_point{} + std::chrono::milliseconds(10);
  const auto actual_time = expected_tick + std::chrono::microseconds(750);

  CHECK(GetControlLoopOverrun(expected_tick, actual_time) == std::chrono::microseconds(750));
}

}  // namespace
}  // namespace emplay
