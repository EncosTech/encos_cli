#include "components/middle_panel.h"

#include <memory>
#include <vector>

#include "components/settings_panel.h"
#include "ftxui/component/component.hpp"
#include "ftxui/dom/elements.hpp"

namespace motor_cli {

ftxui::Component CreateMiddlePanel(AppState& app_state, ControlRuntime& control_runtime, GraphRuntime& graph_runtime) {
  (void)control_runtime;
  static std::vector<std::string> kTabEntries = {"Control", "Settings", "Graph"};

  ftxui::Component tab_toggle = ftxui::Toggle(&kTabEntries, &app_state.middle_panel_state.selected_tab);
  ftxui::Component control_panel = CreateControlPanel(app_state);
  ftxui::Component settings_panel = CreateSettingsPanel(app_state);
  ftxui::Component graph_panel = CreateGraphPanel(app_state, graph_runtime);

  ftxui::Component tab_container = ftxui::Container::Tab(
      {
          control_panel,
          settings_panel,
          graph_panel,
      },
      &app_state.middle_panel_state.selected_tab);

  ftxui::Component main_container = ftxui::Container::Vertical({
      tab_toggle,
      tab_container,
  });

  return ftxui::Renderer(main_container, [&app_state, &graph_runtime, main_container] {
    const int current_tab = app_state.middle_panel_state.selected_tab;
    if (current_tab != app_state.middle_panel_state.previous_tab) {
      if (current_tab == 0) {
        app_state.control_panel_state.needs_range_refresh = true;
      }
      if (current_tab == 2) {
        app_state.graph_panel_state.needs_range_refresh = true;
        graph_runtime.Start();
      } else if (app_state.middle_panel_state.previous_tab == 2) {
        graph_runtime.Stop();
      }
      app_state.middle_panel_state.previous_tab = current_tab;
    }

    if (!app_state.HasSelectedMotor()) {
      return ftxui::vbox({
          ftxui::filler(),
          ftxui::text("No Motor Selected") | ftxui::center,
          ftxui::filler(),
      });
    }
    return main_container->Render();
  });
}

}  // namespace motor_cli
