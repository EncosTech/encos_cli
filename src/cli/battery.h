// SPDX-License-Identifier: MIT

#pragma once

#include <cstddef>
#include <string>

namespace encos {
struct BatteryStatus;
}

namespace motor_cli {

std::string BuildBatteryReport(const encos::BatteryStatus& status);
std::string BuildBatteryInPlaceRefreshPrefix(std::size_t report_line_count);

}  // namespace motor_cli

int RunBatteryCommand(int argc, char** argv);
