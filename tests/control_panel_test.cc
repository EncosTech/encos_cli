// SPDX-License-Identifier: MIT

#include "components/control_panel.h"

#include <encos/adapter/fake_adapter_control.h>

#include <doctest.hpp>
#include <string>
#include <utility>

#include "ftxui/component/event.hpp"
#include "ftxui/dom/node.hpp"
#include "ftxui/screen/screen.hpp"

namespace motor_cli {
namespace {

std::string RenderControlPanel(ftxui::Component panel, int width = 160) {
  auto screen = ftxui::Screen::Create(ftxui::Dimension::Fixed(width), ftxui::Dimension::Fixed(30));
  ftxui::Render(screen, panel->Render());
  return screen.ToString();
}

ftxui::Component FindButton(ftxui::Component component, const std::string& label) {
  for (size_t i = 0; i < component->ChildCount(); ++i) {
    if (auto button = FindButton(component->ChildAt(i), label)) {
      return button;
    }
  }
  if (component->ChildCount() == 0 && component->Focusable() &&
      RenderControlPanel(component).find(label) != std::string::npos) {
    return component;
  }
  return nullptr;
}

std::pair<int, int> FindTextPosition(const ftxui::Screen& screen, const std::string& text) {
  for (int y = 0; y < screen.dimy(); ++y) {
    for (int x = 0; x + static_cast<int>(text.size()) <= screen.dimx(); ++x) {
      bool matches = true;
      for (size_t index = 0; index < text.size(); ++index) {
        if (screen.CellAt(x + static_cast<int>(index), y).character != std::string(1, text[index])) {
          matches = false;
          break;
        }
      }
      if (matches) {
        return {x, y};
      }
    }
  }
  return {-1, -1};
}

}  // namespace

TEST_CASE("control panel slider labels reflect range updates after construction") {
  AppState app_state;
  app_state.control_panel_state.needs_range_refresh = false;

  ftxui::Component panel = CreateControlPanel(app_state);

  ControlPanelState& state = app_state.control_panel_state;
  state.position_min = 0.0f;
  state.position_max = 1.0f;
  state.speed_max = 20.0f;
  state.position_control_position_slider = 1.0f;
  state.position_control_speed_slider = 0.5f;

  const std::string rendered = RenderControlPanel(panel);

  CHECK(rendered.find("Pos: 57.3") != std::string::npos);
  CHECK(rendered.find("Spd: 10.00") != std::string::npos);
}

TEST_CASE("mechanical brake buttons engage and release without changing electronic control") {
  auto adapter = encos::MakeAdapter("Fake", "tui-brake-test", "tui-brake-test", encos::LogLevel::Off);
  REQUIRE(adapter != nullptr);
  auto fake = adapter->GetFakeAdapterControl();
  REQUIRE(fake != nullptr);
  fake->EnableAutoCreateMotor();
  auto motor = adapter->GetBus()->GetMotor(7, encos::MotorModel::EC_A4310_P2);
  REQUIRE(motor != nullptr);
  AppState state;
  auto selected = std::make_shared<SelectedMotor>();
  selected->motor = motor;
  state.SetSelectedMotor(selected);
  state.control_panel_state.needs_range_refresh = false;
  state.UpdateControlCommand([](ControlCommandState& command) { command.mode = ControlMode::Stop; });
  auto panel = CreateControlPanel(state);
  auto engage = FindButton(panel, "Engage");
  auto release = FindButton(panel, "Release");
  REQUIRE(engage != nullptr);
  REQUIRE(release != nullptr);
  engage->OnEvent(ftxui::Event::Return);
  CHECK(fake->GetMotorSnapshot(0, 7).brake_enabled);
  CHECK(state.GetControlCommand().mode == ControlMode::Stop);
  CHECK(RenderControlPanel(panel).find("Engaged") != std::string::npos);
  release->OnEvent(ftxui::Event::Return);
  CHECK_FALSE(fake->GetMotorSnapshot(0, 7).brake_enabled);
  CHECK(RenderControlPanel(panel).find("Released") != std::string::npos);
  state.ClearSelectedMotor();
  engage->OnEvent(ftxui::Event::Return);
  CHECK(RenderControlPanel(panel).find("No motor") != std::string::npos);
  CHECK(encos::DeleteAdapter(adapter));
}

TEST_CASE("mechanical brake actions render as a single labeled status bar") {
  AppState state;
  state.control_panel_state.needs_range_refresh = false;

  auto screen = ftxui::Screen::Create(ftxui::Dimension::Fixed(48), ftxui::Dimension::Fixed(30));
  ftxui::Render(screen, CreateControlPanel(state)->Render());
  const std::string rendered = screen.ToString();
  const size_t engage_position = rendered.find("Engage");
  const size_t release_position = rendered.find("Release");
  const size_t status_position = rendered.find("Status: ");
  const size_t ready_position = rendered.find("Ready", status_position);

  REQUIRE(engage_position != std::string::npos);
  REQUIRE(release_position != std::string::npos);
  REQUIRE(status_position != std::string::npos);
  REQUIRE(ready_position != std::string::npos);
  const size_t row_end = rendered.find('\n', engage_position);
  CHECK(engage_position < release_position);
  CHECK(release_position < status_position);
  CHECK(status_position < ready_position);
  CHECK(ready_position < row_end);

  const auto [engage_x, action_y] = FindTextPosition(screen, "Engage");
  const auto [release_x, release_y] = FindTextPosition(screen, "Release");
  REQUIRE(engage_x >= 0);
  REQUIRE(release_x >= 0);
  REQUIRE(action_y == release_y);

  int engage_left = engage_x;
  int engage_right = engage_x + 5;
  int release_left = release_x;
  int release_right = release_x + 6;
  while (engage_left >= 0 && screen.CellAt(engage_left, action_y).character != "│") {
    --engage_left;
  }
  while (engage_right < screen.dimx() && screen.CellAt(engage_right, action_y).character != "│") {
    ++engage_right;
  }
  while (release_left >= 0 && screen.CellAt(release_left, action_y).character != "│") {
    --release_left;
  }
  while (release_right < screen.dimx() && screen.CellAt(release_right, action_y).character != "│") {
    ++release_right;
  }

  CHECK(engage_right - engage_left == release_right - release_left);
  CHECK(release_left - engage_right == 2);
  CHECK(screen.CellAt(engage_x, action_y).foreground_color == ftxui::Color::RedLight);
  CHECK(screen.CellAt(release_x, action_y).foreground_color == ftxui::Color::GreenLight);
}

}  // namespace motor_cli
