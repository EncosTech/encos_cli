// SPDX-License-Identifier: MIT

#include "components/control_panel.h"

#include <chrono>
#include <functional>
#include <thread>
#include <utility>
#include <vector>

#include "components/math_constants.h"
#include "components/panel_common.h"
#include "ftxui/component/component.hpp"
#include "ftxui/component/component_options.hpp"
#include "ftxui/dom/elements.hpp"

namespace motor_cli {
namespace {

void RefreshRangesIfNeeded(AppState& app_state) {
  if (!app_state.control_panel_state.needs_range_refresh) {
    return;
  }

  const std::shared_ptr<SelectedMotor> selected_motor = app_state.GetSelectedMotor();
  if (!selected_motor || !selected_motor->motor) {
    return;
  }

  try {
    const auto ranges = selected_motor->motor->GetPVTRanges();
    ControlPanelState& state = app_state.control_panel_state;
    state.kp_min = ranges.kp.min;
    state.kp_max = ranges.kp.max;
    state.kd_min = ranges.kd.min;
    state.kd_max = ranges.kd.max;
    state.position_min = ranges.position.min;
    state.position_max = ranges.position.max;
    state.speed_min = ranges.speed.min;
    state.speed_max = ranges.speed.max;
    state.torque_min = ranges.torque.min;
    state.torque_max = ranges.torque.max;
    state.current_min = ranges.current.min;
    state.current_max = ranges.current.max;
    state.needs_range_refresh = false;
  } catch (...) {
  }
}

float Interpolate(float min_value, float max_value, float slider_value) {
  return min_value + slider_value * (max_value - min_value);
}

ftxui::Component CreateSliderRow(const std::string& label, float* slider_value, std::function<float()> get_min_value,
                                 std::function<float()> get_max_value,
                                 const std::function<std::string(float)>& formatter) {
  ftxui::Component value_label = ftxui::Renderer([=] {
    const float value = Interpolate(get_min_value(), get_max_value(), *slider_value);
    return ftxui::hbox({
               ftxui::text(label),
               ftxui::text(formatter(value)) | ftxui::size(ftxui::WIDTH, ftxui::EQUAL, 7),
           }) |
           ftxui::flex;
  });

  ftxui::Component slider = ftxui::Slider("", slider_value, 0.0f, 1.0f, 0.01f) | ftxui::flex;
  return ftxui::Container::Horizontal({value_label, slider}) | ftxui::flex;
}

ftxui::Component CreateModeTitle(AppState& app_state, const std::string& title, ControlMode mode) {
  return ftxui::Renderer([&app_state, title, mode] {
    const ControlMode current_mode = app_state.GetControlCommand().mode;
    ftxui::Element element = ftxui::text(title);
    if (current_mode == mode) {
      return element | ftxui::bold | ftxui::inverted;
    }
    return element;
  });
}

ftxui::Component CreateDisableSection(AppState& app_state) {
  ftxui::Component title = CreateModeTitle(app_state, "Disable", ControlMode::None);
  ftxui::Component filler = ftxui::Renderer([] { return ftxui::text(" ") | ftxui::flex; });
  ftxui::Component button =
      ftxui::Button(
          "Apply",
          [&app_state] {
            app_state.UpdateControlCommand([](ControlCommandState& command) { command.mode = ControlMode::None; });
          },
          CreateCenteredButtonOption()) |
      ftxui::size(ftxui::WIDTH, ftxui::EQUAL, 11);
  return ftxui::Container::Vertical({ftxui::Container::Horizontal({title, filler, button})});
}

ftxui::Component CreatePvtSection(AppState& app_state) {
  ControlPanelState& state = app_state.control_panel_state;
  ftxui::Component kp_row = CreateSliderRow(
      "Kp:  ", &state.kp_slider, [&state] { return state.kp_min; }, [&state] { return state.kp_max; },
      [](float value) { return FormatFloat(value); });
  ftxui::Component kd_row = CreateSliderRow(
      "Kd:  ", &state.kd_slider, [&state] { return state.kd_min; }, [&state] { return state.kd_max; },
      [](float value) { return FormatFloat(value); });
  ftxui::Component position_row = CreateSliderRow(
      "Pos: ", &state.position_slider, [&state] { return state.position_min; }, [&state] { return state.position_max; },
      [](float value) { return FormatDegrees(value); });
  ftxui::Component speed_row = CreateSliderRow(
      "Spd: ", &state.speed_slider, [&state] { return state.speed_min; }, [&state] { return state.speed_max; },
      [](float value) { return FormatFloat(value); });
  ftxui::Component torque_row = CreateSliderRow(
      "Tor: ", &state.torque_slider, [&state] { return state.torque_min; }, [&state] { return state.torque_max; },
      [](float value) { return FormatFloat(value); });

  ftxui::Component title = CreateModeTitle(app_state, "PVT Control", ControlMode::Pvt);
  ftxui::Component gap = ftxui::Renderer([] { return ftxui::text(" "); });
  ftxui::Component filler = ftxui::Renderer([] { return ftxui::text(" ") | ftxui::flex; });
  ftxui::Component button =
      ftxui::Button(
          "Apply",
          [&app_state, &state] {
            app_state.UpdateControlCommand([&](ControlCommandState& command) {
              command.mode = ControlMode::Pvt;
              command.pvt_params.kp = Interpolate(state.kp_min, state.kp_max, state.kp_slider);
              command.pvt_params.kd = Interpolate(state.kd_min, state.kd_max, state.kd_slider);
              command.pvt_params.position = Interpolate(state.position_min, state.position_max, state.position_slider);
              command.pvt_params.speed = Interpolate(state.speed_min, state.speed_max, state.speed_slider);
              command.pvt_params.torque = Interpolate(state.torque_min, state.torque_max, state.torque_slider);
            });
          },
          CreateCenteredButtonOption()) |
      ftxui::size(ftxui::WIDTH, ftxui::EQUAL, 11);

  ftxui::Component row_one = ftxui::Container::Horizontal({kp_row, gap, kd_row, gap, position_row});
  ftxui::Component row_two = ftxui::Container::Horizontal({speed_row, gap, torque_row, gap, filler, button});
  return ftxui::Container::Vertical({title, row_one, row_two});
}

ftxui::Component CreatePositionSection(AppState& app_state) {
  ControlPanelState& state = app_state.control_panel_state;
  ftxui::Component position_row = CreateSliderRow(
      "Pos: ", &state.position_control_position_slider, [&state] { return state.position_min; },
      [&state] { return state.position_max; }, [](float value) { return FormatDegrees(value); });
  ftxui::Component speed_row = CreateSliderRow(
      "Spd: ", &state.position_control_speed_slider, [] { return 0.0f; }, [&state] { return state.speed_max; },
      [](float value) { return FormatFloat(value); });
  ftxui::Component current_row = CreateSliderRow(
      "Cur: ", &state.position_control_current_slider, [] { return 0.0f; }, [&state] { return state.current_max; },
      [](float value) { return FormatFloat(value); });

  ftxui::Component title = CreateModeTitle(app_state, "Position Control", ControlMode::Position);
  ftxui::Component gap = ftxui::Renderer([] { return ftxui::text(" "); });
  ftxui::Component filler = ftxui::Renderer([] { return ftxui::text(" ") | ftxui::flex; });
  ftxui::Component button =
      ftxui::Button(
          "Apply",
          [&app_state, &state] {
            app_state.UpdateControlCommand([&](ControlCommandState& command) {
              command.mode = ControlMode::Position;
              command.position_params.position =
                  Interpolate(state.position_min, state.position_max, state.position_control_position_slider);
              command.position_params.speed = Interpolate(0.0f, state.speed_max, state.position_control_speed_slider);
              command.position_params.current =
                  Interpolate(0.0f, state.current_max, state.position_control_current_slider);
            });
          },
          CreateCenteredButtonOption()) |
      ftxui::size(ftxui::WIDTH, ftxui::EQUAL, 11);

  ftxui::Component row_one = ftxui::Container::Horizontal({position_row, gap, speed_row, gap, current_row});
  ftxui::Component row_two = ftxui::Container::Horizontal({filler, button});
  return ftxui::Container::Vertical({title, row_one, row_two});
}

ftxui::Component CreateSpeedSection(AppState& app_state) {
  ControlPanelState& state = app_state.control_panel_state;
  ftxui::Component speed_row = CreateSliderRow(
      "Spd: ", &state.speed_control_speed_slider, [] { return 0.0f; }, [&state] { return state.speed_max; },
      [](float value) { return FormatFloat(value); });
  ftxui::Component current_row = CreateSliderRow(
      "Cur: ", &state.speed_control_current_slider, [] { return 0.0f; }, [&state] { return state.current_max; },
      [](float value) { return FormatFloat(value); });

  ftxui::Component title = CreateModeTitle(app_state, "Speed Control", ControlMode::Speed);
  ftxui::Component gap = ftxui::Renderer([] { return ftxui::text(" "); });
  ftxui::Component filler = ftxui::Renderer([] { return ftxui::text(" ") | ftxui::flex; });
  ftxui::Component button =
      ftxui::Button(
          "Apply",
          [&app_state, &state] {
            app_state.UpdateControlCommand([&](ControlCommandState& command) {
              command.mode = ControlMode::Speed;
              command.speed_params.speed = Interpolate(0.0f, state.speed_max, state.speed_control_speed_slider);
              command.speed_params.current = Interpolate(0.0f, state.current_max, state.speed_control_current_slider);
            });
          },
          CreateCenteredButtonOption()) |
      ftxui::size(ftxui::WIDTH, ftxui::EQUAL, 11);

  ftxui::Component row = ftxui::Container::Horizontal({speed_row, gap, current_row, gap, filler, button});
  return ftxui::Container::Vertical({title, row});
}

ftxui::Component CreateCurrentSection(AppState& app_state) {
  ControlPanelState& state = app_state.control_panel_state;
  ftxui::Component current_row = CreateSliderRow(
      "Cur: ", &state.current_slider, [&state] { return state.current_min; }, [&state] { return state.current_max; },
      [](float value) { return FormatFloat(value); });
  ftxui::Component title = CreateModeTitle(app_state, "Current Control", ControlMode::Current);
  ftxui::Component gap = ftxui::Renderer([] { return ftxui::text(" "); });
  ftxui::Component filler = ftxui::Renderer([] { return ftxui::text(" ") | ftxui::flex; });
  ftxui::Component button = ftxui::Button(
                                "Apply",
                                [&app_state, &state] {
                                  app_state.UpdateControlCommand([&](ControlCommandState& command) {
                                    command.mode = ControlMode::Current;
                                    command.current_params.current =
                                        Interpolate(state.current_min, state.current_max, state.current_slider);
                                  });
                                },
                                CreateCenteredButtonOption()) |
                            ftxui::size(ftxui::WIDTH, ftxui::EQUAL, 11);
  return ftxui::Container::Vertical({title, ftxui::Container::Horizontal({current_row, gap, filler, button})});
}

ftxui::Component CreateTorqueSection(AppState& app_state) {
  ControlPanelState& state = app_state.control_panel_state;
  ftxui::Component torque_row = CreateSliderRow(
      "Tor: ", &state.torque_control_slider, [&state] { return state.torque_min; },
      [&state] { return state.torque_max; }, [](float value) { return FormatFloat(value); });
  ftxui::Component title = CreateModeTitle(app_state, "Torque Control", ControlMode::Torque);
  ftxui::Component gap = ftxui::Renderer([] { return ftxui::text(" "); });
  ftxui::Component filler = ftxui::Renderer([] { return ftxui::text(" ") | ftxui::flex; });
  ftxui::Component button = ftxui::Button(
                                "Apply",
                                [&app_state, &state] {
                                  app_state.UpdateControlCommand([&](ControlCommandState& command) {
                                    command.mode = ControlMode::Torque;
                                    command.torque_params.torque =
                                        Interpolate(state.torque_min, state.torque_max, state.torque_control_slider);
                                  });
                                },
                                CreateCenteredButtonOption()) |
                            ftxui::size(ftxui::WIDTH, ftxui::EQUAL, 11);
  return ftxui::Container::Vertical({title, ftxui::Container::Horizontal({torque_row, gap, filler, button})});
}

enum class BrakeResultKind {
  Ready,
  Success,
  Error,
};

struct BrakeResult {
  std::string message{"Ready"};
  BrakeResultKind kind{BrakeResultKind::Ready};
};

ftxui::ButtonOption CreateBrakeButtonOption(ftxui::Color accent) {
  ftxui::ButtonOption option;
  option.transform = [accent](const ftxui::EntryState& state) {
    ftxui::Element element =
        ftxui::text(state.label) | ftxui::center | ftxui::bold | ftxui::borderRounded | ftxui::color(accent);
    if (state.focused) {
      element |= ftxui::inverted;
    }
    return element;
  };
  return option;
}

ftxui::Component CreateBrakeSection(AppState& app_state) {
  auto result = std::make_shared<BrakeResult>();
  auto apply = [&app_state, result](bool enabled) {
    const auto selected = app_state.GetSelectedMotor();
    if (!selected || !selected->motor) {
      result->message = "No motor";
      result->kind = BrakeResultKind::Error;
      return;
    }
    try {
      if (selected->motor->Brake(enabled)) {
        result->message = enabled ? "Engaged" : "Released";
        result->kind = BrakeResultKind::Success;
      } else {
        result->message = "No ACK";
        result->kind = BrakeResultKind::Error;
      }
    } catch (const std::exception& error) {
      result->message = std::string("Failed: ") + error.what();
      result->kind = BrakeResultKind::Error;
    }
  };

  ftxui::Component engage = ftxui::Button(
                                "Engage", [apply] { apply(true); }, CreateBrakeButtonOption(ftxui::Color::RedLight)) |
                            ftxui::size(ftxui::WIDTH, ftxui::EQUAL, 13);
  ftxui::Component release =
      ftxui::Button(
          "Release", [apply] { apply(false); }, CreateBrakeButtonOption(ftxui::Color::GreenLight)) |
      ftxui::size(ftxui::WIDTH, ftxui::EQUAL, 13);
  ftxui::Component action_gap = ftxui::Renderer([] { return ftxui::text(" "); });
  ftxui::Component status_gap = ftxui::Renderer([] { return ftxui::text(" "); });
  ftxui::Component status =
      ftxui::Renderer([result] {
        ftxui::Color status_color = ftxui::Color::GrayLight;
        if (result->kind == BrakeResultKind::Success) {
          status_color = ftxui::Color::GreenLight;
        } else if (result->kind == BrakeResultKind::Error) {
          status_color = ftxui::Color::RedLight;
        }
        return ftxui::hbox({ftxui::text("Status: ") | ftxui::dim, ftxui::paragraph(result->message) | ftxui::bold |
                                                                      ftxui::color(status_color) | ftxui::flex}) |
               ftxui::vcenter;
      }) |
      ftxui::flex;

  return ftxui::Container::Vertical({
      ftxui::Renderer([] { return ftxui::text("Brake (mechanical)"); }),
      ftxui::Container::Horizontal({engage, action_gap, release, status_gap, status}),
  });
}

ftxui::Component CreateStopSection(AppState& app_state) {
  static std::vector<std::string> kStopModes = {"Full Brake", "Dynamic Brake", "Regenerative Brake"};

  ControlPanelState& state = app_state.control_panel_state;
  ftxui::Component title = CreateModeTitle(app_state, "Stop (electronic)", ControlMode::Stop);
  ftxui::Component mode_label = ftxui::Renderer([] { return ftxui::text("Mode:      "); });
  ftxui::Component mode_toggle = ftxui::Toggle(&kStopModes, &state.stop_mode_index) | ftxui::flex;
  ftxui::Component mode_row = ftxui::Container::Horizontal({mode_label, mode_toggle}) | ftxui::flex;
  ftxui::Component current_row = CreateSliderRow(
      "Cur: ", &state.current_slider, [] { return 0.0f; }, [&state] { return state.current_max; },
      [](float value) { return FormatFloat(value); });
  ftxui::Component gap = ftxui::Renderer([] { return ftxui::text(" "); });
  ftxui::Component filler = ftxui::Renderer([] { return ftxui::text(" ") | ftxui::flex; });
  ftxui::Component button = ftxui::Button(
                                "Apply",
                                [&app_state, &state] {
                                  app_state.UpdateControlCommand([&](ControlCommandState& command) {
                                    command.mode = ControlMode::Stop;
                                    switch (state.stop_mode_index) {
                                      case 0:
                                        command.stop_params.mode = encos::MotorStopMode::FullBrake;
                                        break;
                                      case 1:
                                        command.stop_params.mode = encos::MotorStopMode::DynamicBrake;
                                        break;
                                      case 2:
                                        command.stop_params.mode = encos::MotorStopMode::RegenerativeBrake;
                                        break;
                                      default:
                                        command.stop_params.mode = encos::MotorStopMode::FullBrake;
                                        break;
                                    }
                                    command.stop_params.current =
                                        Interpolate(0.0f, state.current_max, state.current_slider);
                                  });
                                },
                                CreateCenteredButtonOption()) |
                            ftxui::size(ftxui::WIDTH, ftxui::EQUAL, 11);
  ftxui::Component row_two = ftxui::Container::Horizontal({current_row, gap, filler, button});
  return ftxui::Container::Vertical({title, mode_row, row_two});
}

}  // namespace

ControlRuntime::ControlRuntime(AppState& app_state) : app_state_(app_state) {}

ControlRuntime::~ControlRuntime() { Stop(); }

void ControlRuntime::Start() {
  if (running_.exchange(true)) {
    return;
  }
  worker_ = std::thread(&ControlRuntime::RunLoop, this);
}

void ControlRuntime::Stop() {
  if (!running_.exchange(false)) {
    return;
  }
  if (worker_.joinable()) {
    worker_.join();
  }
}

void ControlRuntime::RunLoop() {
  using namespace std::chrono_literals;

  std::shared_ptr<SelectedMotor> last_selected_motor;
  while (running_.load()) {
    const auto start = std::chrono::steady_clock::now();
    const std::shared_ptr<SelectedMotor> selected_motor = app_state_.GetSelectedMotor();
    const ControlCommandState command = app_state_.GetControlCommand();

    if (selected_motor != last_selected_motor) {
      if (selected_motor != nullptr) {
        app_state_.UpdateControlCommand(
            [](ControlCommandState& mutable_command) { mutable_command.mode = ControlMode::None; });
      }
      last_selected_motor = selected_motor;
    }

    if (selected_motor && selected_motor->motor) {
      try {
        switch (command.mode) {
          case ControlMode::Pvt:
            selected_motor->motor->PVTControl<0>(command.pvt_params.kp, command.pvt_params.kd,
                                                 command.pvt_params.position, command.pvt_params.speed,
                                                 command.pvt_params.torque);
            break;
          case ControlMode::Position:
            selected_motor->motor->PosControl<0>(command.position_params.position, command.position_params.speed,
                                                 command.position_params.current);
            break;
          case ControlMode::Speed:
            selected_motor->motor->SpdControl<0>(command.speed_params.speed, command.speed_params.current);
            break;
          case ControlMode::Current:
            selected_motor->motor->CurControl<0>(command.current_params.current);
            break;
          case ControlMode::Torque:
            selected_motor->motor->TorControl<0>(command.torque_params.torque);
            break;
          case ControlMode::Stop:
            selected_motor->motor->Stop<0>(command.stop_params.mode, command.stop_params.current);
            break;
          case ControlMode::None:
            break;
        }
      } catch (...) {
      }
    }

    const auto elapsed = std::chrono::steady_clock::now() - start;
    const auto remaining = 100ms - std::chrono::duration_cast<std::chrono::milliseconds>(elapsed);
    if (remaining > 0ms) {
      std::this_thread::sleep_for(remaining);
    }
  }
}

ftxui::Component CreateControlPanel(AppState& app_state) {
  RefreshRangesIfNeeded(app_state);

  ftxui::Component main_container = ftxui::Container::Vertical({
      CreateDisableSection(app_state),
      CreateSeparator(),
      CreatePvtSection(app_state),
      CreateSeparator(),
      CreatePositionSection(app_state),
      CreateSeparator(),
      CreateSpeedSection(app_state),
      CreateSeparator(),
      CreateCurrentSection(app_state),
      CreateSeparator(),
      CreateTorqueSection(app_state),
      CreateSeparator(),
      CreateStopSection(app_state),
      CreateSeparator(),
      CreateBrakeSection(app_state),
  });

  return ftxui::Renderer(main_container, [&app_state, main_container] {
    RefreshRangesIfNeeded(app_state);
    return main_container->Render() | ftxui::vscroll_indicator | ftxui::yframe | ftxui::borderRounded;
  });
}

}  // namespace motor_cli
