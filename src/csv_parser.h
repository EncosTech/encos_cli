// SPDX-License-Identifier: MIT

#pragma once

#include <string>

#include "calibration_config.h"

namespace emzero {

MotorConnection ParseMotorConnection(const std::string& target_str);
std::string FormatConnection(const MotorConnection& conn);

}  // namespace emzero
