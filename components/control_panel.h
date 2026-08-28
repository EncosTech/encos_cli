#pragma once

#include <atomic>
#include <thread>

#include "components/app_state.h"
#include "ftxui/component/component.hpp"

namespace motor_cli {

class ControlRuntime {
public:
  explicit ControlRuntime(AppState& app_state);
  ~ControlRuntime();

  ControlRuntime(const ControlRuntime&) = delete;
  ControlRuntime& operator=(const ControlRuntime&) = delete;

  void Start();
  void Stop();

private:
  void RunLoop();

  AppState& app_state_;
  std::atomic<bool> running_{false};
  std::thread worker_;
};

ftxui::Component CreateControlPanel(AppState& app_state);

}  // namespace motor_cli
