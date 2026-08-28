#pragma once

#include <cstddef>
#include <string>

namespace motor_cli {

std::string BuildPmsInPlaceRefreshPrefix(std::size_t report_line_count);

}  // namespace motor_cli

int RunPmsCommand(int argc, char** argv);
