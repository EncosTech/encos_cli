// SPDX-License-Identifier: MIT

#pragma once

#include "components/app_state.h"
#include "components/control_panel.h"
#include "components/graph_panel.h"
#include "ftxui/component/component.hpp"

namespace motor_cli {

ftxui::Component CreateMiddlePanel(AppState& app_state, ControlRuntime& control_runtime, GraphRuntime& graph_runtime);

}  // namespace motor_cli
