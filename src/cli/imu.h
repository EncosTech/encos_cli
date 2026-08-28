#pragma once

#include <cstddef>
#include <string>

namespace motor_cli {

std::string BuildImuInPlaceRefreshPrefix(std::size_t report_line_count);

}  // namespace motor_cli

int RunImuCommand(int argc, char** argv);
