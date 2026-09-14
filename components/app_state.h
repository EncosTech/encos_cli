#pragma once

#include <encos_motor.h>

#include <atomic>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <vector>

namespace motor_cli {

struct SelectedMotor {
  std::size_t adapter_index{0};
  int32_t motor_id{0};
  int32_t bus_id{0};
  encos::Motor* motor{nullptr};
};

struct DialogState {
  int current_page{0};
  std::vector<std::string> adapter_types;
  std::vector<std::string> interfaces;     // Display names shown in the dropdown.
  std::vector<std::string> interface_ids;  // Original interface names passed to MakeAdapter.
  int selected_type_index{0};
  int selected_interface_index{0};
  int previous_type_index{-1};
  bool needs_adapter_list_rebuild{false};
  std::string interface_name_input;
  std::function<void()> exit_callback;
};

struct AdapterEntry {
  std::string type;
  encos::BaseAdapterPtr adapter;
};

struct RescanRequest {
  std::size_t adapter_index{0};
  int32_t bus_id{0};
};

struct AdapterState {
  std::vector<AdapterEntry> adapters;
  bool initial_scan_pending{false};
  std::optional<RescanRequest> rescan_request;
  std::optional<std::size_t> pending_adapter_scan_index;
  std::atomic<bool> global_scan_active{false};
  std::atomic<bool> global_scan_dialog_visible{false};
  std::atomic<bool> global_scan_dialog_has_rendered{false};
};

enum class ControlMode {
  None,
  Pvt,
  Position,
  Speed,
  Current,
  Torque,
  Stop,
};

struct PvtParams {
  float kp{1.0f};
  float kd{1.0f};
  float position{1.0f};
  float speed{1.0f};
  float torque{1.0f};
};

struct PositionParams {
  float position{0.0f};
  float speed{0.0f};
  float current{0.0f};
};

struct SpeedParams {
  float speed{0.0f};
  float current{0.0f};
};

struct CurrentParams {
  float current{0.0f};
};

struct TorqueParams {
  float torque{0.0f};
};

struct StopParams {
  encos::MotorStopMode mode{encos::MotorStopMode::FullBrake};
  float current{0.0f};
};

struct ControlCommandState {
  ControlMode mode{ControlMode::None};
  PvtParams pvt_params;
  PositionParams position_params;
  SpeedParams speed_params;
  CurrentParams current_params;
  TorqueParams torque_params;
  StopParams stop_params;
};

struct ControlPanelState {
  bool needs_range_refresh{true};

  float kp_min{0.0f};
  float kp_max{10.0f};
  float kd_min{0.0f};
  float kd_max{10.0f};
  float position_min{-3.1415927f};
  float position_max{3.1415927f};
  float speed_min{-100.0f};
  float speed_max{100.0f};
  float torque_min{-10.0f};
  float torque_max{10.0f};
  float current_min{-10.0f};
  float current_max{10.0f};

  float kp_slider{0.1f};
  float kd_slider{0.1f};
  float position_slider{0.5f};
  float speed_slider{0.5f};
  float torque_slider{0.5f};
  float current_slider{0.5f};

  float position_control_position_slider{0.5f};
  float position_control_speed_slider{0.0f};
  float position_control_current_slider{0.0f};

  float speed_control_speed_slider{0.0f};
  float speed_control_current_slider{0.0f};

  float torque_control_slider{0.5f};

  int stop_mode_index{0};
};

struct SettingsPanelState {
  std::string can_id_input;
  std::string position_text{"------"};
  std::string position_result_text;
  std::string calibrate_min_input{"0"};
  std::string calibrate_max_input{"0"};
  std::string calibrate_speed_input{"1"};
  std::string calibrate_current_input{"2"};
  std::string calibrate_result_text;
  std::string kt_input;
  std::string pvt_kp_min_input;
  std::string pvt_kp_max_input;
  std::string pvt_kd_min_input;
  std::string pvt_kd_max_input;
  std::string pvt_position_min_input;
  std::string pvt_position_max_input;
  std::string pvt_speed_min_input;
  std::string pvt_speed_max_input;
  std::string pvt_torque_min_input;
  std::string pvt_torque_max_input;
  std::string pvt_current_min_input;
  std::string pvt_current_max_input;
  std::string current_kp_input;
  std::string current_ki_input;
  std::string speed_kp_input;
  std::string speed_ki_input;
  std::string position_kp_input;
  std::string position_kd_input;
  std::string can_timeout_input;
};

enum class GraphType {
  None,
  Position,
  Speed,
  Current,
  Power,
};

struct GraphPanelState {
  int selected_graph_type{0};
  bool needs_range_refresh{true};
  float speed_min{-100.0f};
  float speed_max{100.0f};
  float current_min{-10.0f};
  float current_max{10.0f};
  float power_min{-100.0f};
  float power_max{100.0f};
};

struct MiddlePanelState {
  int selected_tab{0};
  int previous_tab{-1};
};

class AppState {
public:
  bool HasSelectedMotor() const {
    std::lock_guard<std::mutex> lock(selected_motor_mutex_);
    return selected_motor_ != nullptr;
  }

  std::shared_ptr<SelectedMotor> GetSelectedMotor() const {
    std::lock_guard<std::mutex> lock(selected_motor_mutex_);
    return selected_motor_;
  }

  void SetSelectedMotor(std::shared_ptr<SelectedMotor> selected_motor) {
    std::lock_guard<std::mutex> lock(selected_motor_mutex_);
    selected_motor_ = std::move(selected_motor);
    control_panel_state.needs_range_refresh = true;
    graph_panel_state.needs_range_refresh = true;
  }

  void ClearSelectedMotor() { SetSelectedMotor(nullptr); }

  ControlCommandState GetControlCommand() const {
    std::lock_guard<std::mutex> lock(control_command_mutex_);
    return control_command_;
  }

  void UpdateControlCommand(const std::function<void(ControlCommandState&)>& updater) {
    std::lock_guard<std::mutex> lock(control_command_mutex_);
    updater(control_command_);
  }

  DialogState dialog_state;
  AdapterState adapter_state;
  ControlPanelState control_panel_state;
  SettingsPanelState settings_panel_state;
  GraphPanelState graph_panel_state;
  MiddlePanelState middle_panel_state;

private:
  mutable std::mutex selected_motor_mutex_;
  std::shared_ptr<SelectedMotor> selected_motor_;

  mutable std::mutex control_command_mutex_;
  ControlCommandState control_command_;
};

}  // namespace motor_cli
