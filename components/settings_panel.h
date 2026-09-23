// SPDX-License-Identifier: MIT

#pragma once

#include "components/app_state.h"
#include "ftxui/component/component.hpp"

namespace motor_cli {

ftxui::Component CreateSettingsPanel(AppState& app_state);

}  // namespace motor_cli
