// SPDX-License-Identifier: MIT

#pragma once

#include <iomanip>
#include <sstream>
#include <string>

#include "components/math_constants.h"
#include "ftxui/component/component.hpp"
#include "ftxui/dom/elements.hpp"

namespace motor_cli {

inline ftxui::ButtonOption CreateCenteredButtonOption() {
  ftxui::ButtonOption option = ftxui::ButtonOption::Animated();
  option.transform = [](const ftxui::EntryState& state) {
    ftxui::Element element = ftxui::text(state.label) | ftxui::center;
    if (state.focused) {
      element |= ftxui::bold;
    }
    return element;
  };
  return option;
}

inline std::string FormatFloat(float value, int precision = 2) {
  std::ostringstream stream;
  stream << std::fixed << std::setprecision(precision) << value;
  return stream.str();
}

inline std::string FormatDegrees(float radians) { return FormatFloat(radians * kRadiansToDegrees, 1); }

inline ftxui::Component CreateSeparator() {
  return ftxui::Renderer([] { return ftxui::separator(); });
}

}  // namespace motor_cli
