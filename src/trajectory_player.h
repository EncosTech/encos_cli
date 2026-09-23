// SPDX-License-Identifier: MIT

#pragma once

#include <chrono>
#include <cstddef>
#include <string>
#include <vector>

#include "csv_parser.h"

namespace emplay {

struct TrajectorySample {
  double time_s{0.0};
  std::vector<float> positions_deg;
};

struct Trajectory {
  std::vector<std::string> motor_names;
  std::vector<emzero::MotorConnection> motor_connections;
  std::vector<TrajectorySample> samples;
};

struct PlaybackState {
  std::size_t segment_start_index{0};
  std::size_t segment_end_index{0};
  std::vector<float> positions_deg;
  bool finished{false};
};

PlaybackState EvaluateTrajectory(const Trajectory& trajectory, double elapsed_s, bool endless);

class FeedbackPrinterSchedule {
public:
  explicit FeedbackPrinterSchedule(double interval_s);

  bool ShouldPrint(double elapsed_s);

private:
  double interval_s_{0.5};
  double next_print_time_s_{0.0};
};

std::chrono::microseconds GetControlLoopOverrun(std::chrono::steady_clock::time_point expected_tick,
                                                std::chrono::steady_clock::time_point actual_time);

}  // namespace emplay
