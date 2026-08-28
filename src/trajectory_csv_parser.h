#pragma once

#include <string>

#include "trajectory_player.h"

namespace emplay {

Trajectory ParseTrajectoryCsv(const std::string& filepath);

}  // namespace emplay
