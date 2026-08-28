#include "trajectory_player.h"

#include <cmath>
#include <stdexcept>

namespace emplay {
namespace {

PlaybackState BuildTerminalState(const TrajectorySample& sample, std::size_t sample_index, bool finished) {
  return PlaybackState{sample_index, sample_index, sample.positions_deg, finished};
}

PlaybackState InterpolateSegment(const TrajectorySample& start, const TrajectorySample& end, std::size_t start_index,
                                 std::size_t end_index, double segment_elapsed_s, double segment_duration_s,
                                 bool finished) {
  if (start.positions_deg.size() != end.positions_deg.size()) {
    throw std::runtime_error("trajectory sample width mismatch");
  }

  const double ratio = segment_duration_s <= 0.0 ? 0.0 : segment_elapsed_s / segment_duration_s;

  PlaybackState state;
  state.segment_start_index = start_index;
  state.segment_end_index = end_index;
  state.finished = finished;
  state.positions_deg.reserve(start.positions_deg.size());
  for (std::size_t index = 0; index < start.positions_deg.size(); ++index) {
    const float value = static_cast<float>(start.positions_deg[index] +
                                           (end.positions_deg[index] - start.positions_deg[index]) * ratio);
    state.positions_deg.push_back(value);
  }
  return state;
}

PlaybackState EvaluateForward(const Trajectory& trajectory, double elapsed_s, bool finished_at_end) {
  const double total_duration_s = trajectory.samples.back().time_s - trajectory.samples.front().time_s;
  if (elapsed_s >= total_duration_s) {
    return BuildTerminalState(trajectory.samples.back(), trajectory.samples.size() - 1, finished_at_end);
  }

  for (std::size_t index = 0; index + 1 < trajectory.samples.size(); ++index) {
    const TrajectorySample& start = trajectory.samples[index];
    const TrajectorySample& end = trajectory.samples[index + 1];
    const double segment_duration_s = end.time_s - start.time_s;
    const double segment_start_offset_s = start.time_s - trajectory.samples.front().time_s;
    if (elapsed_s <= segment_start_offset_s + segment_duration_s) {
      return InterpolateSegment(start, end, index, index + 1, elapsed_s - segment_start_offset_s, segment_duration_s,
                                false);
    }
  }

  return BuildTerminalState(trajectory.samples.back(), trajectory.samples.size() - 1, finished_at_end);
}

PlaybackState EvaluateBackward(const Trajectory& trajectory, double elapsed_s) {
  for (std::size_t reverse_index = trajectory.samples.size() - 1; reverse_index > 0; --reverse_index) {
    const TrajectorySample& start = trajectory.samples[reverse_index];
    const TrajectorySample& end = trajectory.samples[reverse_index - 1];
    const double segment_duration_s = start.time_s - end.time_s;
    if (elapsed_s <= segment_duration_s) {
      return InterpolateSegment(start, end, reverse_index, reverse_index - 1, elapsed_s, segment_duration_s, false);
    }
    elapsed_s -= segment_duration_s;
  }

  return BuildTerminalState(trajectory.samples.front(), 0, false);
}

void ValidateTrajectory(const Trajectory& trajectory) {
  if (trajectory.samples.empty()) {
    throw std::runtime_error("trajectory must contain at least one sample");
  }
  if (trajectory.motor_names.size() != trajectory.motor_connections.size()) {
    throw std::runtime_error("trajectory motor metadata mismatch");
  }
  for (const auto& sample : trajectory.samples) {
    if (sample.positions_deg.size() != trajectory.motor_names.size()) {
      throw std::runtime_error("trajectory sample width mismatch");
    }
  }
}

}  // namespace

PlaybackState EvaluateTrajectory(const Trajectory& trajectory, double elapsed_s, bool endless) {
  ValidateTrajectory(trajectory);

  if (trajectory.samples.size() == 1U) {
    return BuildTerminalState(trajectory.samples.front(), 0, !endless);
  }

  const double clamped_elapsed_s = std::max(0.0, elapsed_s);
  const double total_duration_s = trajectory.samples.back().time_s - trajectory.samples.front().time_s;
  if (total_duration_s <= 0.0) {
    return BuildTerminalState(trajectory.samples.front(), 0, !endless);
  }

  if (!endless) {
    return EvaluateForward(trajectory, clamped_elapsed_s, true);
  }

  const double cycle_duration_s = total_duration_s * 2.0;
  const double cycle_elapsed_s = std::fmod(clamped_elapsed_s, cycle_duration_s);
  if (cycle_elapsed_s <= total_duration_s) {
    return EvaluateForward(trajectory, cycle_elapsed_s, false);
  }
  return EvaluateBackward(trajectory, cycle_elapsed_s - total_duration_s);
}

FeedbackPrinterSchedule::FeedbackPrinterSchedule(double interval_s)
    : interval_s_(interval_s), next_print_time_s_(0.0) {}

bool FeedbackPrinterSchedule::ShouldPrint(double elapsed_s) {
  if (elapsed_s + 1e-9 < next_print_time_s_) {
    return false;
  }
  next_print_time_s_ += interval_s_;
  return true;
}

std::chrono::microseconds GetControlLoopOverrun(std::chrono::steady_clock::time_point expected_tick,
                                                std::chrono::steady_clock::time_point actual_time) {
  if (actual_time <= expected_tick) {
    return std::chrono::microseconds(0);
  }
  return std::chrono::duration_cast<std::chrono::microseconds>(actual_time - expected_tick);
}

}  // namespace emplay
