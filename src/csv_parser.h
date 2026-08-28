#pragma once

#include <string>
#include <vector>

#include "calibration_config.h"

namespace emzero {

std::vector<CalibrationPoint> ParseCsvConfig(const std::string& filepath);

}  // namespace emzero