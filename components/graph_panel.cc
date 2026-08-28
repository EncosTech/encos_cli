#include "components/graph_panel.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include "components/math_constants.h"
#include "components/panel_common.h"
#include "ftxui/component/component.hpp"
#include "ftxui/dom/elements.hpp"

namespace motor_cli {
namespace {

constexpr float kAssumedSystemVoltage = 48.0f;

void RefreshGraphRangesIfNeeded(AppState& app_state) {
  if (!app_state.graph_panel_state.needs_range_refresh) {
    return;
  }

  const std::shared_ptr<SelectedMotor> selected_motor = app_state.GetSelectedMotor();
  if (!selected_motor || !selected_motor->motor) {
    return;
  }

  try {
    const auto ranges = selected_motor->motor->GetPVTRanges();
    GraphPanelState& state = app_state.graph_panel_state;
    state.speed_min = ranges.speed.min;
    state.speed_max = ranges.speed.max;
    state.current_min = ranges.current.min;
    state.current_max = ranges.current.max;
    const float max_abs_current = std::max(std::abs(state.current_min), std::abs(state.current_max));
    state.power_min = -max_abs_current * kAssumedSystemVoltage;
    state.power_max = max_abs_current * kAssumedSystemVoltage;
    state.needs_range_refresh = false;
  } catch (...) {
  }
}

std::string GraphTypeName(GraphType graph_type) {
  switch (graph_type) {
    case GraphType::None:
      return "None";
    case GraphType::Position:
      return "Position";
    case GraphType::Speed:
      return "Speed";
    case GraphType::Current:
      return "Current";
    case GraphType::Power:
      return "Power";
  }
  return "Unknown";
}

}  // namespace

GraphRuntime::GraphRuntime(AppState& app_state) : app_state_(app_state) {}

GraphRuntime::~GraphRuntime() { Stop(); }

void GraphRuntime::Start() {
  if (running_.exchange(true)) {
    return;
  }
  worker_ = std::thread(&GraphRuntime::RunLoop, this);
}

void GraphRuntime::Stop() {
  if (!running_.exchange(false)) {
    return;
  }
  if (worker_.joinable()) {
    worker_.join();
  }
}

void GraphRuntime::SetGraphType(GraphType graph_type) { graph_type_.store(graph_type); }

GraphType GraphRuntime::GetGraphType() const { return graph_type_.load(); }

void GraphRuntime::ClearData() {
  std::lock_guard<std::mutex> lock(data_mutex_);
  graph_data_.clear();
}

std::vector<float> GraphRuntime::GetDataSnapshot() const {
  std::lock_guard<std::mutex> lock(data_mutex_);
  return std::vector<float>(graph_data_.begin(), graph_data_.end());
}

void GraphRuntime::RunLoop() {
  using namespace std::chrono_literals;

  std::shared_ptr<SelectedMotor> last_selected_motor;
  while (running_.load()) {
    const auto start = std::chrono::steady_clock::now();
    const std::shared_ptr<SelectedMotor> selected_motor = app_state_.GetSelectedMotor();
    if (selected_motor != last_selected_motor) {
      ClearData();
      last_selected_motor = selected_motor;
    }

    if (selected_motor && selected_motor->motor) {
      const GraphType graph_type = graph_type_.load();
      float value = 0.0f;
      bool has_value = false;

      try {
        switch (graph_type) {
          case GraphType::Position: {
            float position_radians = selected_motor->motor->template GetParameter<encos::MotorParameter::Position>();
            while (position_radians > kPiF) {
              position_radians -= 2.0f * kPiF;
            }
            while (position_radians < -kPiF) {
              position_radians += 2.0f * kPiF;
            }
            value = position_radians * kRadiansToDegrees;
            has_value = true;
            break;
          }
          case GraphType::Speed:
            value = selected_motor->motor->template GetParameter<encos::MotorParameter::Speed>();
            has_value = true;
            break;
          case GraphType::Current:
            value = selected_motor->motor->template GetParameter<encos::MotorParameter::Current>();
            has_value = true;
            break;
          case GraphType::Power:
            value = selected_motor->motor->template GetParameter<encos::MotorParameter::Power>();
            has_value = true;
            break;
          case GraphType::None:
            break;
        }
      } catch (...) {
      }

      if (has_value) {
        std::lock_guard<std::mutex> lock(data_mutex_);
        graph_data_.push_back(value);
        if (graph_data_.size() > kMaxDataPoints) {
          graph_data_.pop_front();
        }
      }
    }

    const auto elapsed = std::chrono::steady_clock::now() - start;
    const auto remaining = 50ms - std::chrono::duration_cast<std::chrono::milliseconds>(elapsed);
    if (remaining > 0ms) {
      std::this_thread::sleep_for(remaining);
    }
  }
}

ftxui::Component CreateGraphPanel(AppState& app_state, GraphRuntime& graph_runtime) {
  static std::vector<std::string> kGraphTypeEntries = {"None", "Position", "Speed", "Current", "Power"};

  ftxui::Component type_label = ftxui::Renderer([] { return ftxui::text("Graph Type: "); });
  ftxui::Component type_toggle = ftxui::Toggle(&kGraphTypeEntries, &app_state.graph_panel_state.selected_graph_type);

  ftxui::Component type_selector = ftxui::Container::Horizontal({type_label, type_toggle});

  ftxui::Component graph_renderer = ftxui::Renderer([&app_state, &graph_runtime] {
    RefreshGraphRangesIfNeeded(app_state);

    const GraphType graph_type = static_cast<GraphType>(app_state.graph_panel_state.selected_graph_type);
    if (graph_type != graph_runtime.GetGraphType()) {
      graph_runtime.SetGraphType(graph_type);
      graph_runtime.ClearData();
    }

    if (graph_type == GraphType::None) {
      return ftxui::text("Select a graph type to display") | ftxui::center;
    }

    const std::shared_ptr<SelectedMotor> selected_motor = app_state.GetSelectedMotor();
    if (!selected_motor || !selected_motor->motor) {
      return ftxui::text("No motor selected") | ftxui::center;
    }

    const std::vector<float> graph_data = graph_runtime.GetDataSnapshot();
    if (graph_data.empty()) {
      return ftxui::text("Waiting for data...") | ftxui::center;
    }

    float y_min = -1.0f;
    float y_max = 1.0f;
    std::string unit;
    switch (graph_type) {
      case GraphType::Position:
        y_min = -180.0f;
        y_max = 180.0f;
        unit = "deg";
        break;
      case GraphType::Speed:
        y_min = app_state.graph_panel_state.speed_min;
        y_max = app_state.graph_panel_state.speed_max;
        unit = "rad/s";
        break;
      case GraphType::Current:
        y_min = app_state.graph_panel_state.current_min;
        y_max = app_state.graph_panel_state.current_max;
        unit = "A";
        break;
      case GraphType::Power:
        y_min = app_state.graph_panel_state.power_min;
        y_max = app_state.graph_panel_state.power_max;
        unit = "W";
        break;
      case GraphType::None:
        break;
    }

    auto graph_function = [graph_data, y_min, y_max](int width, int height) {
      std::vector<int> output(static_cast<std::size_t>(width), 0);
      if (graph_data.empty()) {
        return output;
      }

      for (int column = 0; column < width; ++column) {
        float value = 0.0f;
        if (graph_data.size() >= static_cast<std::size_t>(width)) {
          const std::size_t data_index =
              graph_data.size() - static_cast<std::size_t>(width) + static_cast<std::size_t>(column);
          value = graph_data[data_index];
        } else {
          const int start_column = width - static_cast<int>(graph_data.size());
          if (column >= start_column) {
            value = graph_data[static_cast<std::size_t>(column - start_column)];
          }
        }

        float normalized = (value - y_min) / (y_max - y_min);
        normalized = std::clamp(normalized, 0.0f, 1.0f);
        output[static_cast<std::size_t>(column)] = static_cast<int>(normalized * static_cast<float>(height - 1));
      }
      return output;
    };

    const float step = (y_max - y_min) / 6.0f;
    const auto tick_text = [=](float value) { return ftxui::text(FormatFloat(value) + " "); };
    ftxui::Element y_axis_ticks = ftxui::vbox({
        tick_text(y_max),
        ftxui::filler(),
        tick_text(y_max - step),
        ftxui::filler(),
        tick_text(y_max - 2.0f * step),
        ftxui::filler(),
        tick_text(y_max - 3.0f * step),
        ftxui::filler(),
        tick_text(y_max - 4.0f * step),
        ftxui::filler(),
        tick_text(y_max - 5.0f * step),
        ftxui::filler(),
        tick_text(y_min),
    });

    ftxui::Element graph_view = ftxui::hbox({
                                    y_axis_ticks,
                                    ftxui::graph(graph_function) | ftxui::color(ftxui::Color::GreenLight) | ftxui::flex,
                                }) |
                                ftxui::flex | ftxui::size(ftxui::HEIGHT, ftxui::GREATER_THAN, 20);

    ftxui::Element info = ftxui::vbox({
        ftxui::hbox({ftxui::text("Type:  "), ftxui::text(GraphTypeName(graph_type)) | ftxui::bold}),
        ftxui::hbox({ftxui::text("Value: "), ftxui::text(FormatFloat(graph_data.back()) + " " + unit) | ftxui::bold}),
        ftxui::hbox(
            {ftxui::text("Range: "), ftxui::text(FormatFloat(y_min) + " ~ " + FormatFloat(y_max) + " " + unit)}),
    });

    return ftxui::vbox({graph_view, ftxui::separator(), info});
  });

  ftxui::Component main_container = ftxui::Container::Vertical({type_selector, CreateSeparator(), graph_renderer});

  return ftxui::Renderer(main_container, [main_container] { return main_container->Render() | ftxui::borderRounded; });
}

}  // namespace motor_cli
