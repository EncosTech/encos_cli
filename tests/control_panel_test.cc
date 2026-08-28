#include "components/control_panel.h"

#include <doctest.hpp>
#include <string>

#include "ftxui/dom/node.hpp"
#include "ftxui/screen/screen.hpp"

namespace motor_cli {
namespace {

std::string RenderControlPanel(ftxui::Component panel) {
  auto screen = ftxui::Screen::Create(ftxui::Dimension::Fixed(160), ftxui::Dimension::Fixed(30));
  ftxui::Render(screen, panel->Render());
  return screen.ToString();
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

}  // namespace motor_cli
