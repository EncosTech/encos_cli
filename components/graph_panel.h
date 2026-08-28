#pragma once

#include <atomic>
#include <deque>
#include <mutex>
#include <thread>
#include <vector>

#include "components/app_state.h"
#include "ftxui/component/component.hpp"

namespace motor_cli {

class GraphRuntime {
public:
  explicit GraphRuntime(AppState& app_state);
  ~GraphRuntime();

  GraphRuntime(const GraphRuntime&) = delete;
  GraphRuntime& operator=(const GraphRuntime&) = delete;

  void Start();
  void Stop();
  void SetGraphType(GraphType graph_type);
  GraphType GetGraphType() const;
  void ClearData();
  std::vector<float> GetDataSnapshot() const;

private:
  void RunLoop();

  static constexpr std::size_t kMaxDataPoints = 600;

  AppState& app_state_;
  std::atomic<bool> running_{false};
  std::atomic<GraphType> graph_type_{GraphType::None};
  mutable std::mutex data_mutex_;
  std::deque<float> graph_data_;
  std::thread worker_;
};

ftxui::Component CreateGraphPanel(AppState& app_state, GraphRuntime& graph_runtime);

}  // namespace motor_cli
