#pragma once

#include <cstddef>
#include <string>

namespace motor_cli {

std::string BuildGloveInPlaceRefreshPrefix(std::size_t report_line_count);

}  // namespace motor_cli

int RunGloveCommand(int argc, char** argv);
