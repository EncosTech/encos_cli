// SPDX-License-Identifier: MIT

#pragma once

#include <unordered_map>
#include <vector>

#include "components/app_state.h"
#include "ftxui/component/component.hpp"

namespace motor_cli {

ftxui::Component CreateAddAdapterDialog(AppState& app_state);
ftxui::Component CreateLeftPanel(AppState& app_state);
ftxui::Component CreateMotorScanDialog(AppState& app_state);
void ClearMotorsForRescan(AppState& app_state, const std::vector<encos::Bus*>& buses);
std::vector<int> SortMotorIdsForDisplay(const std::unordered_map<int, encos::Motor*>& motors);
std::vector<int32_t> SortBusIdsForDisplay(const std::unordered_map<int, encos::Bus*>& buses);
bool ShouldShowMotorScanDialog(bool scan_active, bool dialog_has_rendered);
bool IsSelectedMotor(const std::shared_ptr<SelectedMotor>& selected_motor, std::size_t adapter_index, int32_t bus_id,
                     int32_t motor_id);

}  // namespace motor_cli
