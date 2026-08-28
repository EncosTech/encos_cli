#include "components/settings_panel.h"

#include <chrono>
#include <cmath>
#include <cstdint>
#include <functional>
#include <memory>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>

#include "components/math_constants.h"
#include "components/panel_common.h"
#include "ftxui/component/component.hpp"
#include "ftxui/dom/elements.hpp"

namespace motor_cli {
namespace {

using RangeGetter = std::function<std::pair<std::string, std::string>(encos::Motor&)>;
using RangeSetter = std::function<bool(encos::Motor&, const std::string&, const std::string&)>;
using PairGetter = std::function<std::pair<std::string, std::string>(encos::Motor&)>;
using PairSetter = std::function<bool(encos::Motor&, const std::string&, const std::string&)>;
using SingleGetter = std::function<std::string(encos::Motor&)>;
using SingleSetter = std::function<bool(encos::Motor&, const std::string&)>;

std::shared_ptr<SelectedMotor> GetSelectedMotor(const AppState& app_state) { return app_state.GetSelectedMotor(); }

void SleepForDeviceUpdate() { std::this_thread::sleep_for(std::chrono::milliseconds(200)); }

ftxui::Component CreateLabeledInput(const std::string& label, std::string* value, const std::string& placeholder) {
  ftxui::Component text_label = ftxui::Renderer([label] { return ftxui::text(label); });
  ftxui::Component input = ftxui::Input(value, placeholder) | ftxui::size(ftxui::WIDTH, ftxui::EQUAL, 10);
  return ftxui::Container::Horizontal({text_label, input}) | ftxui::flex;
}

ftxui::Component CreateSingleValueEditor(AppState& app_state, const std::string& title, const std::string& label,
                                         std::string* value, const std::string& placeholder, const SingleGetter& getter,
                                         const SingleSetter& setter, int set_button_width = 11) {
  ftxui::Component title_component = ftxui::Renderer([title] { return ftxui::text(title); });
  ftxui::Component input = CreateLabeledInput(label, value, placeholder);
  ftxui::Component filler = ftxui::Renderer([] { return ftxui::text(" ") | ftxui::flex; });
  ftxui::Component gap = ftxui::Renderer([] { return ftxui::text(" "); });

  ftxui::Component get_button = ftxui::Button(
                                    "Get",
                                    [&app_state, value, getter] {
                                      const std::shared_ptr<SelectedMotor> selected_motor = GetSelectedMotor(app_state);
                                      if (!selected_motor || !selected_motor->motor) {
                                        return;
                                      }
                                      try {
                                        *value = getter(*selected_motor->motor);
                                      } catch (...) {
                                        *value = "Failed";
                                      }
                                    },
                                    CreateCenteredButtonOption()) |
                                ftxui::size(ftxui::WIDTH, ftxui::EQUAL, 11);

  ftxui::Component set_button = ftxui::Button(
                                    "Set",
                                    [&app_state, value, getter, setter] {
                                      const std::shared_ptr<SelectedMotor> selected_motor = GetSelectedMotor(app_state);
                                      if (!selected_motor || !selected_motor->motor) {
                                        return;
                                      }

                                      try {
                                        if (!setter(*selected_motor->motor, *value)) {
                                          *value = "Failed";
                                          return;
                                        }
                                        SleepForDeviceUpdate();
                                        *value = getter(*selected_motor->motor);
                                      } catch (const std::invalid_argument&) {
                                        *value = "Bad Convert";
                                      } catch (...) {
                                        *value = "Failed";
                                      }
                                    },
                                    CreateCenteredButtonOption()) |
                                ftxui::size(ftxui::WIDTH, ftxui::EQUAL, set_button_width);

  ftxui::Component row = ftxui::Container::Horizontal({input, gap, filler, get_button, gap, set_button});
  return ftxui::Container::Vertical({title_component, row});
}

ftxui::Component CreateReadonlyValueEditor(AppState& app_state, const std::string& title, const std::string& label,
                                           std::string* value, const std::string& placeholder,
                                           const SingleGetter& getter) {
  ftxui::Component title_component = ftxui::Renderer([title] { return ftxui::text(title); });
  ftxui::Component input = CreateLabeledInput(label, value, placeholder);
  ftxui::Component filler = ftxui::Renderer([] { return ftxui::text(" ") | ftxui::flex; });
  ftxui::Component gap = ftxui::Renderer([] { return ftxui::text(" "); });

  ftxui::Component get_button = ftxui::Button(
                                    "Get",
                                    [&app_state, value, getter] {
                                      const std::shared_ptr<SelectedMotor> selected_motor = GetSelectedMotor(app_state);
                                      if (!selected_motor || !selected_motor->motor) {
                                        return;
                                      }
                                      try {
                                        *value = getter(*selected_motor->motor);
                                      } catch (...) {
                                        *value = "Failed";
                                      }
                                    },
                                    CreateCenteredButtonOption()) |
                                ftxui::size(ftxui::WIDTH, ftxui::EQUAL, 11);

  ftxui::Component row = ftxui::Container::Horizontal({input, gap, filler, get_button});
  return ftxui::Container::Vertical({title_component, row});
}

ftxui::Component CreateRangeEditor(AppState& app_state, const std::string& title, std::string* min_value,
                                   std::string* max_value, const RangeGetter& getter, const RangeSetter& setter) {
  ftxui::Component title_component = ftxui::Renderer([title] { return ftxui::text(title); });
  ftxui::Component min_input = CreateLabeledInput("Min: ", min_value, "Min");
  ftxui::Component max_input = CreateLabeledInput("Max: ", max_value, "Max");
  ftxui::Component filler = ftxui::Renderer([] { return ftxui::text(" ") | ftxui::flex; });
  ftxui::Component gap = ftxui::Renderer([] { return ftxui::text(" "); });

  ftxui::Component get_button = ftxui::Button(
                                    "Get",
                                    [&app_state, min_value, max_value, getter] {
                                      const std::shared_ptr<SelectedMotor> selected_motor = GetSelectedMotor(app_state);
                                      if (!selected_motor || !selected_motor->motor) {
                                        return;
                                      }
                                      try {
                                        const auto [new_min, new_max] = getter(*selected_motor->motor);
                                        *min_value = new_min;
                                        *max_value = new_max;
                                      } catch (...) {
                                        *min_value = "Failed";
                                        *max_value = "Failed";
                                      }
                                    },
                                    CreateCenteredButtonOption()) |
                                ftxui::size(ftxui::WIDTH, ftxui::EQUAL, 11);

  ftxui::Component set_button = ftxui::Button(
                                    "Set",
                                    [&app_state, min_value, max_value, getter, setter] {
                                      const std::shared_ptr<SelectedMotor> selected_motor = GetSelectedMotor(app_state);
                                      if (!selected_motor || !selected_motor->motor) {
                                        return;
                                      }
                                      try {
                                        if (!setter(*selected_motor->motor, *min_value, *max_value)) {
                                          *min_value = "Failed";
                                          *max_value = "Failed";
                                          return;
                                        }
                                        SleepForDeviceUpdate();
                                        const auto [new_min, new_max] = getter(*selected_motor->motor);
                                        *min_value = new_min;
                                        *max_value = new_max;
                                      } catch (const std::invalid_argument&) {
                                        *min_value = "Bad Convert";
                                        *max_value = "Bad Convert";
                                      } catch (...) {
                                        *min_value = "Failed";
                                        *max_value = "Failed";
                                      }
                                    },
                                    CreateCenteredButtonOption()) |
                                ftxui::size(ftxui::WIDTH, ftxui::EQUAL, 11);

  ftxui::Component row = ftxui::Container::Horizontal({min_input, gap, max_input, filler, get_button, gap, set_button});
  return ftxui::Container::Vertical({title_component, row});
}

ftxui::Component CreatePairEditor(AppState& app_state, const std::string& title, const std::string& first_label,
                                  std::string* first_value, const std::string& second_label, std::string* second_value,
                                  const PairGetter& getter, const PairSetter& setter) {
  ftxui::Component title_component = ftxui::Renderer([title] { return ftxui::text(title); });
  ftxui::Component first_input = CreateLabeledInput(first_label, first_value, first_label);
  ftxui::Component second_input = CreateLabeledInput(second_label, second_value, second_label);
  ftxui::Component filler = ftxui::Renderer([] { return ftxui::text(" ") | ftxui::flex; });
  ftxui::Component gap = ftxui::Renderer([] { return ftxui::text(" "); });

  ftxui::Component get_button = ftxui::Button(
                                    "Get",
                                    [&app_state, first_value, second_value, getter] {
                                      const std::shared_ptr<SelectedMotor> selected_motor = GetSelectedMotor(app_state);
                                      if (!selected_motor || !selected_motor->motor) {
                                        return;
                                      }
                                      try {
                                        const auto [new_first, new_second] = getter(*selected_motor->motor);
                                        *first_value = new_first;
                                        *second_value = new_second;
                                      } catch (...) {
                                        *first_value = "Failed";
                                        *second_value = "Failed";
                                      }
                                    },
                                    CreateCenteredButtonOption()) |
                                ftxui::size(ftxui::WIDTH, ftxui::EQUAL, 11);

  ftxui::Component set_button = ftxui::Button(
                                    "Set",
                                    [&app_state, first_value, second_value, getter, setter] {
                                      const std::shared_ptr<SelectedMotor> selected_motor = GetSelectedMotor(app_state);
                                      if (!selected_motor || !selected_motor->motor) {
                                        return;
                                      }
                                      try {
                                        if (!setter(*selected_motor->motor, *first_value, *second_value)) {
                                          *first_value = "Failed";
                                          *second_value = "Failed";
                                          return;
                                        }
                                        SleepForDeviceUpdate();
                                        const auto [new_first, new_second] = getter(*selected_motor->motor);
                                        *first_value = new_first;
                                        *second_value = new_second;
                                      } catch (const std::invalid_argument&) {
                                        *first_value = "Bad Convert";
                                        *second_value = "Bad Convert";
                                      } catch (...) {
                                        *first_value = "Failed";
                                        *second_value = "Failed";
                                      }
                                    },
                                    CreateCenteredButtonOption()) |
                                ftxui::size(ftxui::WIDTH, ftxui::EQUAL, 11);

  ftxui::Component row =
      ftxui::Container::Horizontal({first_input, gap, second_input, filler, get_button, gap, set_button});
  return ftxui::Container::Vertical({title_component, row});
}

uint16_t ParseCanId(const std::string& input) {
  if (input.size() >= 2U && input[0] == '0' && (input[1] == 'x' || input[1] == 'X')) {
    return static_cast<uint16_t>(std::stoi(input, nullptr, 16));
  }
  if (input.size() >= 2U && input[0] == '0' && (input[1] == 'b' || input[1] == 'B')) {
    return static_cast<uint16_t>(std::stoi(input.substr(2), nullptr, 2));
  }
  return static_cast<uint16_t>(std::stoi(input));
}

float ParseFiniteFloat(const std::string& input) {
  std::size_t parsed_chars = 0;
  const float value = std::stof(input, &parsed_chars);
  if (parsed_chars != input.size() || !std::isfinite(value)) {
    throw std::invalid_argument("invalid float");
  }
  return value;
}

std::string FormatSetPosError(const std::exception& error) {
  const std::string message = error.what();
  if (message.find("support") != std::string::npos || message.find("Support") != std::string::npos ||
      message.find("CAN FD") != std::string::npos || message.find("can fd") != std::string::npos ||
      message.find("SetPos") != std::string::npos) {
    return "Not Support";
  }
  return message;
}

}  // namespace

ftxui::Component CreateSettingsPanel(AppState& app_state) {
  SettingsPanelState& state = app_state.settings_panel_state;

  ftxui::Component can_title = ftxui::Renderer([] { return ftxui::text("CAN Settings"); });
  ftxui::Component can_input = CreateLabeledInput("New ID: ", &state.can_id_input, "ID");
  ftxui::Component can_filler = ftxui::Renderer([] { return ftxui::text(" ") | ftxui::flex; });
  ftxui::Component can_gap = ftxui::Renderer([] { return ftxui::text(" "); });
  ftxui::Component can_set_button = ftxui::Button(
                                        "Set",
                                        [&app_state, &state] {
                                          const std::shared_ptr<SelectedMotor> selected_motor =
                                              GetSelectedMotor(app_state);
                                          if (!selected_motor || !selected_motor->motor) {
                                            return;
                                          }

                                          try {
                                            const uint16_t new_id = ParseCanId(state.can_id_input);
                                            if (selected_motor->motor->SetId(new_id, true)) {
                                              app_state.adapter_state.rescan_request =
                                                  RescanRequest{selected_motor->adapter_index, selected_motor->bus_id};
                                              state.can_id_input = "Success";
                                            } else {
                                              state.can_id_input = "Failed";
                                            }
                                          } catch (const std::invalid_argument&) {
                                            state.can_id_input = "Bad Convert";
                                          } catch (...) {
                                            state.can_id_input = "Failed";
                                          }
                                        },
                                        CreateCenteredButtonOption()) |
                                    ftxui::size(ftxui::WIDTH, ftxui::EQUAL, 11);
  ftxui::Component can_panel = ftxui::Container::Vertical(
      {can_title, ftxui::Container::Horizontal({can_input, can_gap, can_filler, can_set_button})});

  ftxui::Component position_title = ftxui::Renderer([] { return ftxui::text("Position"); });
  ftxui::Component position_input = CreateLabeledInput("Pos: ", &state.position_text, "deg");
  ftxui::Component position_result = ftxui::Renderer(
      [&state] { return ftxui::text(state.position_result_text) | ftxui::size(ftxui::WIDTH, ftxui::EQUAL, 24); });
  ftxui::Component position_gap = ftxui::Renderer([] { return ftxui::text(" "); });
  ftxui::Component position_filler = ftxui::Renderer([] { return ftxui::text(" ") | ftxui::flex; });
  ftxui::Component position_get_button =
      ftxui::Button(
          "Get Pos",
          [&app_state, &state] {
            const std::shared_ptr<SelectedMotor> selected_motor = GetSelectedMotor(app_state);
            if (!selected_motor || !selected_motor->motor) {
              return;
            }
            try {
              const float position_radians = selected_motor->motor->GetParameter<encos::MotorParameter::Position>();
              state.position_text = FormatDegrees(position_radians);
              state.position_result_text = "Success";
            } catch (const std::exception& error) {
              state.position_result_text = error.what();
            } catch (...) {
              state.position_result_text = "Failed";
            }
          },
          CreateCenteredButtonOption()) |
      ftxui::size(ftxui::WIDTH, ftxui::EQUAL, 11);
  ftxui::Component position_set_button =
      ftxui::Button(
          "Set",
          [&app_state, &state] {
            const std::shared_ptr<SelectedMotor> selected_motor = GetSelectedMotor(app_state);
            if (!selected_motor || !selected_motor->motor) {
              return;
            }
            try {
              const float position_degrees = ParseFiniteFloat(state.position_text);
              if (!selected_motor->motor->SetPos(static_cast<double>(position_degrees * kDegreesToRadians))) {
                state.position_result_text = "Failed";
                return;
              }
              SleepForDeviceUpdate();
              const float position_radians = selected_motor->motor->GetParameter<encos::MotorParameter::Position>();
              state.position_text = FormatDegrees(position_radians);
              state.position_result_text = "Success";
            } catch (const std::invalid_argument&) {
              state.position_result_text = "Bad Convert";
            } catch (const std::out_of_range&) {
              state.position_result_text = "Bad Convert";
            } catch (const std::exception& error) {
              state.position_result_text = FormatSetPosError(error);
            } catch (...) {
              state.position_result_text = "Failed";
            }
          },
          CreateCenteredButtonOption()) |
      ftxui::size(ftxui::WIDTH, ftxui::EQUAL, 11);
  ftxui::Component position_reset_button =
      ftxui::Button(
          "Reset Zero Pos",
          [&app_state, &state] {
            const std::shared_ptr<SelectedMotor> selected_motor = GetSelectedMotor(app_state);
            if (!selected_motor || !selected_motor->motor) {
              return;
            }
            try {
              if (!selected_motor->motor->ResetZeroPos(true)) {
                state.position_result_text = "Failed";
                return;
              }
              SleepForDeviceUpdate();
              const float position_radians = selected_motor->motor->GetParameter<encos::MotorParameter::Position>();
              state.position_text = FormatDegrees(position_radians);
              state.position_result_text = "Success";
            } catch (const std::exception& error) {
              state.position_result_text = error.what();
            } catch (...) {
              state.position_result_text = "Failed";
            }
          },
          CreateCenteredButtonOption()) |
      ftxui::size(ftxui::WIDTH, ftxui::EQUAL, 18);
  ftxui::Component position_panel = ftxui::Container::Vertical(
      {position_title, ftxui::Container::Horizontal({position_get_button, position_gap, position_input, position_gap,
                                                     position_result, position_gap, position_filler,
                                                     position_set_button, position_gap, position_reset_button})});

  ftxui::Component kt_panel = CreateReadonlyValueEditor(
      app_state, "Kt", "Kt: ", &state.kt_input, "Value",
      [](encos::Motor& motor) { return FormatFloat(motor.GetParameter<encos::MotorParameter::Kt>()); });

  ftxui::Component pvt_kp_panel = CreateRangeEditor(
      app_state, "PVT Kp Range", &state.pvt_kp_min_input, &state.pvt_kp_max_input,
      [](encos::Motor& motor) {
        const auto range = motor.GetParameter<encos::MotorParameter::PVTKpRange>();
        return std::make_pair(std::to_string(range.min), std::to_string(range.max));
      },
      [](encos::Motor& motor, const std::string& min_value, const std::string& max_value) {
        encos::Range<uint16_t> range{static_cast<uint16_t>(std::stoi(min_value)),
                                     static_cast<uint16_t>(std::stoi(max_value))};
        return motor.SetPVTKpRange(range, true);
      });

  ftxui::Component pvt_kd_panel = CreateRangeEditor(
      app_state, "PVT Kd Range", &state.pvt_kd_min_input, &state.pvt_kd_max_input,
      [](encos::Motor& motor) {
        const auto range = motor.GetParameter<encos::MotorParameter::PVTKdRange>();
        return std::make_pair(std::to_string(range.min), std::to_string(range.max));
      },
      [](encos::Motor& motor, const std::string& min_value, const std::string& max_value) {
        encos::Range<uint16_t> range{static_cast<uint16_t>(std::stoi(min_value)),
                                     static_cast<uint16_t>(std::stoi(max_value))};
        return motor.SetPVTKdRange(range, true);
      });

  ftxui::Component pvt_position_panel = CreateRangeEditor(
      app_state, "PVT Pos Range", &state.pvt_position_min_input, &state.pvt_position_max_input,
      [](encos::Motor& motor) {
        const auto range = motor.GetParameter<encos::MotorParameter::PVTPosRange>();
        return std::make_pair(FormatFloat(range.min), FormatFloat(range.max));
      },
      [](encos::Motor& motor, const std::string& min_value, const std::string& max_value) {
        encos::Range<float> range{std::stof(min_value), std::stof(max_value)};
        return motor.SetPVTPosRange(range, true);
      });

  ftxui::Component pvt_speed_panel = CreateRangeEditor(
      app_state, "PVT Spd Range", &state.pvt_speed_min_input, &state.pvt_speed_max_input,
      [](encos::Motor& motor) {
        const auto range = motor.GetParameter<encos::MotorParameter::PVTSpdRange>();
        return std::make_pair(FormatFloat(range.min), FormatFloat(range.max));
      },
      [](encos::Motor& motor, const std::string& min_value, const std::string& max_value) {
        encos::Range<float> range{std::stof(min_value), std::stof(max_value)};
        return motor.SetPVTSpdRange(range, true);
      });

  ftxui::Component pvt_torque_panel = CreateRangeEditor(
      app_state, "PVT Tor Range", &state.pvt_torque_min_input, &state.pvt_torque_max_input,
      [](encos::Motor& motor) {
        const auto range = motor.GetParameter<encos::MotorParameter::PVTTorRange>();
        return std::make_pair(FormatFloat(range.min), FormatFloat(range.max));
      },
      [](encos::Motor& motor, const std::string& min_value, const std::string& max_value) {
        encos::Range<float> range{std::stof(min_value), std::stof(max_value)};
        return motor.SetPVTTorRange(range, true);
      });

  ftxui::Component pvt_current_panel = CreateRangeEditor(
      app_state, "PVT Cur Range", &state.pvt_current_min_input, &state.pvt_current_max_input,
      [](encos::Motor& motor) {
        const auto range = motor.GetParameter<encos::MotorParameter::PVTCurRange>();
        return std::make_pair(FormatFloat(range.min), FormatFloat(range.max));
      },
      [](encos::Motor& motor, const std::string& min_value, const std::string& max_value) {
        encos::Range<float> range{std::stof(min_value), std::stof(max_value)};
        return motor.SetPVTCurRange(range, true);
      });

  ftxui::Component current_pi_panel = CreatePairEditor(
      app_state, "Cur Kp/Ki", "Kp: ", &state.current_kp_input, "Ki: ", &state.current_ki_input,
      [](encos::Motor& motor) {
        const auto values = motor.GetParameter<encos::MotorParameter::CurKpKi>();
        return std::make_pair(FormatFloat(values.kp), FormatFloat(values.ki));
      },
      [](encos::Motor& motor, const std::string& kp, const std::string& ki) {
        return motor.SetCurPI(std::stof(kp), std::stof(ki), true);
      });

  ftxui::Component speed_pi_panel = CreatePairEditor(
      app_state, "Spd Kp/Ki", "Kp: ", &state.speed_kp_input, "Ki: ", &state.speed_ki_input,
      [](encos::Motor& motor) {
        const auto values = motor.GetParameter<encos::MotorParameter::SpdKpKi>();
        return std::make_pair(FormatFloat(values.kp), FormatFloat(values.ki));
      },
      [](encos::Motor& motor, const std::string& kp, const std::string& ki) {
        return motor.SetSpdPI(std::stof(kp), std::stof(ki), true);
      });

  ftxui::Component position_pd_panel = CreatePairEditor(
      app_state, "Pos Kp/Kd", "Kp: ", &state.position_kp_input, "Kd: ", &state.position_kd_input,
      [](encos::Motor& motor) {
        const auto values = motor.GetParameter<encos::MotorParameter::PosKpKd>();
        return std::make_pair(FormatFloat(values.kp), FormatFloat(values.kd));
      },
      [](encos::Motor& motor, const std::string& kp, const std::string& kd) {
        return motor.SetPosPD(std::stof(kp), std::stof(kd), true);
      });

  ftxui::Component can_timeout_panel = CreateSingleValueEditor(
      app_state, "CAN Timeout (ms)", "Timeout: ", &state.can_timeout_input, "ms",
      [](encos::Motor& motor) { return std::to_string(motor.GetParameter<encos::MotorParameter::CanTimeout>()); },
      [](encos::Motor& motor, const std::string& value) {
        return motor.SetCanTimeout(static_cast<uint16_t>(std::stoi(value)), true);
      });

  ftxui::Component main_container = ftxui::Container::Vertical({
      can_panel,          CreateSeparator(), position_panel,    CreateSeparator(), kt_panel,
      CreateSeparator(),  pvt_kp_panel,      CreateSeparator(), pvt_kd_panel,      CreateSeparator(),
      pvt_position_panel, CreateSeparator(), pvt_speed_panel,   CreateSeparator(), pvt_torque_panel,
      CreateSeparator(),  pvt_current_panel, CreateSeparator(), current_pi_panel,  CreateSeparator(),
      speed_pi_panel,     CreateSeparator(), position_pd_panel, CreateSeparator(), can_timeout_panel,
  });

  return ftxui::Renderer(main_container, [main_container] {
    return main_container->Render() | ftxui::vscroll_indicator | ftxui::yframe | ftxui::borderRounded;
  });
}

}  // namespace motor_cli
