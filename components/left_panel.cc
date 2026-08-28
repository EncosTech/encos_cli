#include "components/left_panel.h"

#include <algorithm>
#include <atomic>
#include <cstdint>
#include <future>
#include <iomanip>
#include <limits>
#include <map>
#include <memory>
#include <mutex>
#include <sstream>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

#include "components/panel_common.h"
#include "ftxui/component/component.hpp"
#include "ftxui/component/component_options.hpp"
#include "ftxui/component/event.hpp"
#include "ftxui/dom/elements.hpp"
#include "src/cli/interface_name.h"

namespace motor_cli {
namespace {

enum class MotorScanStatus {
  Idle,
  Scanning,
  Complete,
  Failed,
};

class MotorScanResult {
public:
  std::uint64_t Begin() {
    std::lock_guard<std::mutex> lock(mutex_);
    motors_.clear();
    status_ = MotorScanStatus::Scanning;
    ++revision_;
    return revision_;
  }

  void Complete(std::unordered_map<int, encos::Motor*> motors, std::uint64_t revision) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (revision_ != revision) {
      return;
    }
    motors_ = std::move(motors);
    status_ = MotorScanStatus::Complete;
  }

  void Fail(std::uint64_t revision) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (revision_ != revision) {
      return;
    }
    motors_.clear();
    status_ = MotorScanStatus::Failed;
  }

  MotorScanStatus GetStatus() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return status_;
  }

  std::unordered_map<int, encos::Motor*> GetMotors() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return motors_;
  }

  std::uint64_t GetRevision() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return revision_;
  }

private:
  mutable std::mutex mutex_;
  std::unordered_map<int, encos::Motor*> motors_;
  MotorScanStatus status_{MotorScanStatus::Idle};
  std::uint64_t revision_{0};
};

class MotorScanManager {
public:
  ~MotorScanManager() {
    WaitForWorkers(global_workers_);
    WaitForWorkers(local_workers_);
  }

  void ScanAll(const std::vector<AdapterEntry>& adapters, std::optional<std::size_t> adapter_index = std::nullopt) {
    WaitForWorkers(global_workers_);
    WaitForWorkers(local_workers_);

    std::vector<std::pair<ScanKey, encos::Bus*>> jobs;
    const std::size_t first = adapter_index.value_or(0);
    const std::size_t last = adapter_index.has_value() ? first + 1U : adapters.size();
    for (std::size_t index = first; index < last && index < adapters.size(); ++index) {
      if (!adapters[index].adapter) {
        continue;
      }
      for (const auto& [bus_id, bus] : adapters[index].adapter->GetBuses()) {
        jobs.push_back({ScanKey{index, bus_id}, bus});
      }
    }

    std::vector<encos::Bus*> buses;
    buses.reserve(jobs.size());
    for (const auto& [key, bus] : jobs) {
      static_cast<void>(key);
      buses.push_back(bus);
    }
    ClearMotorsForRescan(*app_state_, buses);

    active_global_tasks_.store(static_cast<int>(jobs.size()));
    app_state_->adapter_state.global_scan_active.store(!jobs.empty());
    app_state_->adapter_state.global_scan_dialog_has_rendered.store(false);
    app_state_->adapter_state.global_scan_dialog_visible.store(true);
    for (const auto& [key, bus] : jobs) {
      global_workers_.push_back(StartJob(key, bus, true));
    }
  }

  void ScanBus(std::size_t adapter_index, int32_t bus_id, encos::Bus* bus) {
    WaitForWorkers(global_workers_);
    WaitForWorkers(local_workers_);
    ClearMotorsForRescan(*app_state_, {bus});
    local_workers_.push_back(StartJob(ScanKey{adapter_index, bus_id}, bus, false));
  }

  std::shared_ptr<MotorScanResult> GetResult(std::size_t adapter_index, int32_t bus_id) {
    const ScanKey key{adapter_index, bus_id};
    std::lock_guard<std::mutex> lock(results_mutex_);
    auto [iterator, inserted] = results_.try_emplace(key, std::make_shared<MotorScanResult>());
    return iterator->second;
  }

  void SetAppState(AppState& app_state) { app_state_ = &app_state; }

private:
  struct ScanKey {
    std::size_t adapter_index;
    int32_t bus_id;

    bool operator<(const ScanKey& other) const {
      return adapter_index != other.adapter_index ? adapter_index < other.adapter_index : bus_id < other.bus_id;
    }
  };

  std::shared_ptr<std::mutex> GetScanMutex(const ScanKey& key) {
    std::lock_guard<std::mutex> lock(scan_mutexes_mutex_);
    auto [iterator, inserted] = scan_mutexes_.try_emplace(key, std::make_shared<std::mutex>());
    return iterator->second;
  }

  std::future<void> StartJob(const ScanKey& key, encos::Bus* bus, bool contributes_to_global_progress) {
    const std::shared_ptr<MotorScanResult> result = GetResult(key.adapter_index, key.bus_id);
    const std::uint64_t revision = result->Begin();
    const std::shared_ptr<std::mutex> scan_mutex = GetScanMutex(key);
    return std::async(std::launch::async, [this, result, bus, revision, scan_mutex, contributes_to_global_progress] {
      std::lock_guard<std::mutex> scan_lock(*scan_mutex);
      try {
        result->Complete(bus->ScanMotors(), revision);
      } catch (...) {
        result->Fail(revision);
      }
      if (contributes_to_global_progress && active_global_tasks_.fetch_sub(1) == 1) {
        app_state_->adapter_state.global_scan_active.store(false);
      }
    });
  }

  static void WaitForWorkers(std::vector<std::future<void>>& workers) {
    for (std::future<void>& worker : workers) {
      worker.get();
    }
    workers.clear();
  }

  AppState* app_state_{nullptr};
  std::mutex results_mutex_;
  std::map<ScanKey, std::shared_ptr<MotorScanResult>> results_;
  std::mutex scan_mutexes_mutex_;
  std::map<ScanKey, std::shared_ptr<std::mutex>> scan_mutexes_;
  std::vector<std::future<void>> global_workers_;
  std::vector<std::future<void>> local_workers_;
  std::atomic<int> active_global_tasks_{0};
};

std::string FormatMotorLabel(int motor_id) {
  std::ostringstream stream;
  stream << "  Motor " << motor_id << " 0x" << std::hex << std::setw(2) << std::setfill('0') << std::uppercase
         << motor_id;
  return stream.str();
}

ftxui::Component CreateMotorList(AppState& app_state, std::shared_ptr<MotorScanManager> scan_manager,
                                 std::size_t adapter_index, int32_t bus_id) {
  auto spinner_state = std::make_shared<int>(0);
  auto rendered_revision = std::make_shared<std::uint64_t>(std::numeric_limits<std::uint64_t>::max());
  auto list_container = ftxui::Container::Vertical({});

  return ftxui::Renderer(
      list_container, [&, scan_manager, adapter_index, spinner_state, rendered_revision, list_container, bus_id] {
        const std::shared_ptr<MotorScanResult> scan_result = scan_manager->GetResult(adapter_index, bus_id);

        if (scan_result->GetStatus() == MotorScanStatus::Scanning) {
          ++(*spinner_state);
          return ftxui::spinner(16, *spinner_state) | ftxui::center;
        }

        if (scan_result->GetStatus() != MotorScanStatus::Complete) {
          return ftxui::text("") | ftxui::center;
        }

        const auto motors = scan_result->GetMotors();
        if (*rendered_revision != scan_result->GetRevision()) {
          list_container->DetachAllChildren();
          for (const int motor_id : SortMotorIdsForDisplay(motors)) {
            encos::Motor* motor = motors.at(motor_id);
            ftxui::ButtonOption option;
            option.transform = [&app_state, adapter_index, bus_id, motor_id](const ftxui::EntryState& state) {
              ftxui::Element element = ftxui::text(FormatMotorLabel(motor_id));
              if (state.focused) {
                element |= ftxui::bold;
              }
              const std::shared_ptr<SelectedMotor> selected_motor = app_state.GetSelectedMotor();
              if (IsSelectedMotor(selected_motor, adapter_index, bus_id, motor_id)) {
                element |= ftxui::inverted;
              }
              return element;
            };

            list_container->Add(ftxui::Button(
                "Motor " + std::to_string(motor_id),
                [&app_state, adapter_index, motor_id, bus_id, motor] {
                  auto selected_motor = std::make_shared<SelectedMotor>();
                  selected_motor->adapter_index = adapter_index;
                  selected_motor->motor_id = motor_id;
                  selected_motor->bus_id = bus_id;
                  selected_motor->motor = motor;
                  app_state.SetSelectedMotor(std::move(selected_motor));
                },
                option));
          }
          *rendered_revision = scan_result->GetRevision();
        }
        return list_container->Render();
      });
}

ftxui::Component CreateBusList(AppState& app_state, std::shared_ptr<MotorScanManager> scan_manager,
                               std::size_t adapter_index, encos::BaseAdapterPtr adapter) {
  ftxui::Component container = ftxui::Container::Vertical({});
  const auto buses = adapter->GetBuses();

  if (buses.size() == 1U) {
    const auto& [bus_id, bus] = *buses.begin();
    static_cast<void>(bus);
    return CreateMotorList(app_state, scan_manager, adapter_index, bus_id);
  }

  for (const int32_t bus_id : SortBusIdsForDisplay(buses)) {
    auto expanded = std::make_shared<bool>(false);
    std::string label;
    if (bus_id > 0xFFFF) {
      const int32_t slave_id = bus_id >> 16;
      const int32_t actual_bus_id = bus_id & 0xFFFF;
      label = "Slave " + std::to_string(slave_id) + " Bus " + std::to_string(actual_bus_id);
    } else {
      label = "Bus " + std::to_string(bus_id);
    }

    ftxui::CheckboxOption option;
    option.transform = [label](const ftxui::EntryState& state) {
      const std::string prefix = state.state ? "▼ " : "▶ ";
      ftxui::Element element = ftxui::text(prefix + label);
      if (state.focused) {
        element |= ftxui::bold;
      }
      return element;
    };

    ftxui::Component header = ftxui::Checkbox("", expanded.get(), option);
    ftxui::Component motor_list = CreateMotorList(app_state, scan_manager, adapter_index, bus_id);
    ftxui::Component content =
        ftxui::Renderer(motor_list, [motor_list] { return ftxui::hbox({ftxui::text("  "), motor_list->Render()}); });

    ftxui::Component bus_entry = ftxui::Container::Vertical({
        header,
        ftxui::Maybe(content, [expanded] { return *expanded; }),
    });
    container->Add(ftxui::Maybe(bus_entry, [scan_manager, adapter_index, bus_id] {
      const std::shared_ptr<MotorScanResult> result = scan_manager->GetResult(adapter_index, bus_id);
      const MotorScanStatus status = result->GetStatus();
      return status == MotorScanStatus::Idle || status == MotorScanStatus::Scanning || !result->GetMotors().empty();
    }));
  }

  return container;
}

ftxui::Component CreateAdapterList(AppState& app_state, std::shared_ptr<MotorScanManager> scan_manager) {
  ftxui::Component container = ftxui::Container::Vertical({});

  for (std::size_t adapter_index = 0; adapter_index < app_state.adapter_state.adapters.size(); ++adapter_index) {
    const AdapterEntry& entry = app_state.adapter_state.adapters[adapter_index];
    auto expanded = std::make_shared<bool>(false);

    ftxui::CheckboxOption option;
    option.transform = [&entry](const ftxui::EntryState& state) {
      const std::string prefix = state.state ? "▼ " : "▶ ";
      ftxui::Element element =
          ftxui::text(prefix + GetDisplayInterfaceName(entry.type, entry.adapter->GetInterfaceName()));
      if (state.focused) {
        element |= ftxui::bold;
      }
      return element;
    };

    ftxui::Component header = ftxui::Checkbox("", expanded.get(), option);
    ftxui::Component bus_list = CreateBusList(app_state, scan_manager, adapter_index, entry.adapter);
    ftxui::Component content =
        ftxui::Renderer(bus_list, [bus_list] { return ftxui::hbox({ftxui::text("  "), bus_list->Render()}); });

    container->Add(ftxui::Container::Vertical({
        header,
        ftxui::Maybe(content, [expanded] { return *expanded; }),
    }));
  }

  return container;
}

void RefreshInterfaces(AppState& app_state) {
  DialogState& dialog_state = app_state.dialog_state;
  const int selected_type_index = dialog_state.selected_type_index;
  if (selected_type_index < 0 || selected_type_index >= static_cast<int>(dialog_state.adapter_types.size())) {
    dialog_state.interfaces.clear();
    dialog_state.selected_interface_index = -1;
    return;
  }

  std::unordered_set<std::string> used_interface_ids;
  for (const AdapterEntry& entry : app_state.adapter_state.adapters) {
    if (entry.adapter) {
      used_interface_ids.insert(entry.adapter->GetInterfaceName());
    }
  }

  const auto all_interfaces =
      encos::GetAvailableInterface(dialog_state.adapter_types[static_cast<std::size_t>(selected_type_index)]);
  const std::string& adapter_type = dialog_state.adapter_types[static_cast<std::size_t>(selected_type_index)];
  dialog_state.interfaces.clear();
  dialog_state.interface_ids.clear();
  dialog_state.interfaces.reserve(all_interfaces.size());
  dialog_state.interface_ids.reserve(all_interfaces.size());
  for (const std::string& interface_name : all_interfaces) {
    if (used_interface_ids.find(interface_name) == used_interface_ids.end()) {
      dialog_state.interface_ids.push_back(interface_name);
      dialog_state.interfaces.push_back(GetDisplayInterfaceName(adapter_type, interface_name));
    }
  }

  if (dialog_state.interfaces.empty()) {
    dialog_state.selected_interface_index = -1;
    return;
  }

  if (dialog_state.selected_interface_index < 0 ||
      dialog_state.selected_interface_index >= static_cast<int>(dialog_state.interfaces.size())) {
    dialog_state.selected_interface_index = 0;
  }
}

}  // namespace

void ClearMotorsForRescan(AppState& app_state, const std::vector<encos::Bus*>& buses) {
  app_state.ClearSelectedMotor();

  std::unordered_set<encos::Bus*> unique_buses;
  for (encos::Bus* bus : buses) {
    if (bus == nullptr || !unique_buses.insert(bus).second) {
      continue;
    }
    for (const auto& [motor_id, motor] : bus->GetMotors()) {
      static_cast<void>(motor_id);
      if (motor != nullptr) {
        static_cast<void>(encos::DeleteMotor(motor));
      }
    }
  }
}

std::vector<int> SortMotorIdsForDisplay(const std::unordered_map<int, encos::Motor*>& motors) {
  std::vector<int> motor_ids;
  motor_ids.reserve(motors.size());
  for (const auto& [motor_id, motor] : motors) {
    static_cast<void>(motor);
    motor_ids.push_back(motor_id);
  }
  std::sort(motor_ids.begin(), motor_ids.end());
  return motor_ids;
}

std::vector<int32_t> SortBusIdsForDisplay(const std::unordered_map<int, encos::Bus*>& buses) {
  std::vector<int32_t> bus_ids;
  bus_ids.reserve(buses.size());
  for (const auto& [bus_id, bus] : buses) {
    static_cast<void>(bus);
    bus_ids.push_back(bus_id);
  }
  std::sort(bus_ids.begin(), bus_ids.end());
  return bus_ids;
}

bool ShouldShowMotorScanDialog(bool scan_active, bool dialog_has_rendered) {
  return scan_active || !dialog_has_rendered;
}

bool IsSelectedMotor(const std::shared_ptr<SelectedMotor>& selected_motor, std::size_t adapter_index, int32_t bus_id,
                     int32_t motor_id) {
  return selected_motor && selected_motor->adapter_index == adapter_index && selected_motor->bus_id == bus_id &&
         selected_motor->motor_id == motor_id;
}

ftxui::Component CreateAddAdapterDialog(AppState& app_state) {
  DialogState& dialog_state = app_state.dialog_state;

  ftxui::Component adapter_type_dropdown =
      ftxui::Dropdown(&dialog_state.adapter_types, &dialog_state.selected_type_index);
  ftxui::Component interface_dropdown =
      ftxui::Dropdown(&dialog_state.interfaces, &dialog_state.selected_interface_index);
  ftxui::Component interface_input = ftxui::Input(&dialog_state.interface_name_input, "Input interface name here");

  ftxui::Component interface_dropdown_with_refresh = ftxui::CatchEvent(interface_dropdown, [&app_state](ftxui::Event) {
    DialogState& state = app_state.dialog_state;
    if (state.selected_type_index != state.previous_type_index && state.selected_type_index >= 0 &&
        state.selected_type_index < static_cast<int>(state.adapter_types.size())) {
      state.previous_type_index = state.selected_type_index;
      RefreshInterfaces(app_state);
    }
    return false;
  });

  ftxui::Component interface_selector = ftxui::Container::Vertical({
      ftxui::Maybe(interface_dropdown_with_refresh, [&dialog_state] { return !dialog_state.interfaces.empty(); }),
      ftxui::Maybe(interface_input, [&dialog_state] { return dialog_state.interfaces.empty(); }),
  });

  ftxui::Component ok_button = ftxui::Button(
      "OK",
      [&app_state] {
        DialogState& state = app_state.dialog_state;
        if (state.selected_type_index < 0 ||
            state.selected_type_index >= static_cast<int>(state.adapter_types.size())) {
          state.current_page = 0;
          return;
        }

        const std::string& adapter_type = state.adapter_types[static_cast<std::size_t>(state.selected_type_index)];
        std::string interface_name;
        if (!state.interface_ids.empty()) {
          if (state.selected_interface_index >= 0 &&
              state.selected_interface_index < static_cast<int>(state.interface_ids.size())) {
            interface_name = state.interface_ids[static_cast<std::size_t>(state.selected_interface_index)];
          }
        } else {
          interface_name = state.interface_name_input;
        }

        if (!interface_name.empty()) {
          encos::BaseAdapterPtr adapter = encos::MakeAdapter(
              adapter_type, interface_name, GetLoggerName(adapter_type, interface_name), encos::LogLevel::Off);
          if (adapter) {
            app_state.adapter_state.adapters.push_back(AdapterEntry{adapter_type, std::move(adapter)});
            app_state.adapter_state.pending_adapter_scan_index = app_state.adapter_state.adapters.size() - 1U;
            app_state.dialog_state.needs_adapter_list_rebuild = true;
          }
        }
        state.current_page = 0;
      },
      CreateCenteredButtonOption());

  ftxui::Component cancel_button =
      ftxui::Button("Cancel", [&app_state] { app_state.dialog_state.current_page = 0; }, CreateCenteredButtonOption());

  ftxui::Component dialog_buttons = ftxui::Container::Horizontal({ok_button, cancel_button});
  ftxui::Component dialog_content = ftxui::Container::Vertical({
      adapter_type_dropdown,
      interface_selector,
      dialog_buttons,
  });

  return ftxui::Renderer(dialog_content, [&app_state, dialog_content] {
    DialogState& state = app_state.dialog_state;
    if (state.selected_type_index != state.previous_type_index) {
      state.previous_type_index = state.selected_type_index;
      state.interface_name_input.clear();
      RefreshInterfaces(app_state);
    }

    const bool has_interfaces = !state.interfaces.empty();
    const ftxui::Element interface_state =
        has_interfaces ? ftxui::text("") : ftxui::text("No available interfaces; enter name manually") | ftxui::dim;

    return ftxui::vbox({
               ftxui::text("Select Adapter Type:"),
               dialog_content->ChildAt(0)->Render(),
               ftxui::text(""),
               ftxui::text(has_interfaces ? "Select Interface:" : "Enter Interface Name:"),
               dialog_content->ChildAt(1)->Render(),
               interface_state,
               ftxui::text(""),
               ftxui::hbox({
                   dialog_content->ChildAt(2)->ChildAt(0)->Render() | ftxui::flex |
                       ftxui::size(ftxui::HEIGHT, ftxui::EQUAL, 3),
                   ftxui::text("  "),
                   dialog_content->ChildAt(2)->ChildAt(1)->Render() | ftxui::flex |
                       ftxui::size(ftxui::HEIGHT, ftxui::EQUAL, 3),
               }),
           }) |
           ftxui::border | ftxui::size(ftxui::WIDTH, ftxui::GREATER_THAN, 40) | ftxui::center;
  });
}

ftxui::Component CreateMotorScanDialog(AppState& app_state) {
  auto spinner_state = std::make_shared<int>(0);
  return ftxui::Renderer([&app_state, spinner_state] {
    app_state.adapter_state.global_scan_dialog_has_rendered.store(true);
    ++(*spinner_state);
    return ftxui::vbox({
               ftxui::spinner(20, *spinner_state) | ftxui::center,
               ftxui::text("Scanning motors...") | ftxui::center,
           }) |
           ftxui::border | ftxui::size(ftxui::WIDTH, ftxui::GREATER_THAN, 28) | ftxui::center;
  });
}

ftxui::Component CreateLeftPanel(AppState& app_state) {
  ftxui::ButtonOption option = CreateCenteredButtonOption();
  auto scan_manager = std::make_shared<MotorScanManager>();
  scan_manager->SetAppState(app_state);

  ftxui::Component add_button = ftxui::Button(
      "Add Adapter",
      [&app_state] {
        DialogState& dialog_state = app_state.dialog_state;
        dialog_state.current_page = 1;
        dialog_state.adapter_types = encos::GetAvailableAdapterTypes();
        dialog_state.selected_type_index = 0;
        dialog_state.selected_interface_index = 0;
        dialog_state.previous_type_index = -1;
      },
      option);

  ftxui::Component rescan_button = ftxui::Button(
      "ReScan Motors", [&app_state, scan_manager] { scan_manager->ScanAll(app_state.adapter_state.adapters); }, option);

  ftxui::Component quit_button = ftxui::Button(
      "Quit",
      [&app_state] {
        if (app_state.dialog_state.exit_callback) {
          app_state.dialog_state.exit_callback();
        }
      },
      option);

  auto adapter_list = std::make_shared<ftxui::Component>();
  ftxui::Component container = ftxui::Container::Vertical({});

  const auto rebuild = [&app_state, scan_manager, add_button, rescan_button, quit_button, container, adapter_list] {
    container->DetachAllChildren();
    *adapter_list = CreateAdapterList(app_state, scan_manager);
    container->Add(ftxui::Container::Vertical({add_button, CreateSeparator(), rescan_button, CreateSeparator()}));
    container->Add(ftxui::Renderer(*adapter_list, [adapter_list] {
      return (*adapter_list)->Render() | ftxui::vscroll_indicator | ftxui::frame | ftxui::flex;
    }));
    container->Add(ftxui::Container::Vertical({CreateSeparator(), quit_button}));
    app_state.dialog_state.needs_adapter_list_rebuild = false;
  };

  rebuild();
  app_state.adapter_state.initial_scan_pending = true;

  return ftxui::Renderer(container, [&app_state, scan_manager, container, rebuild] {
    if (app_state.dialog_state.needs_adapter_list_rebuild) {
      rebuild();
    }
    if (app_state.adapter_state.initial_scan_pending) {
      app_state.adapter_state.initial_scan_pending = false;
      scan_manager->ScanAll(app_state.adapter_state.adapters);
    }
    if (app_state.adapter_state.pending_adapter_scan_index.has_value()) {
      scan_manager->ScanAll(app_state.adapter_state.adapters, app_state.adapter_state.pending_adapter_scan_index);
      app_state.adapter_state.pending_adapter_scan_index.reset();
    }
    if (app_state.adapter_state.rescan_request.has_value()) {
      const RescanRequest request = *app_state.adapter_state.rescan_request;
      if (request.adapter_index < app_state.adapter_state.adapters.size()) {
        const encos::BaseAdapterPtr& adapter = app_state.adapter_state.adapters[request.adapter_index].adapter;
        if (adapter) {
          const auto buses = adapter->GetBuses();
          const auto bus_iterator = buses.find(request.bus_id);
          if (bus_iterator != buses.end()) {
            scan_manager->ScanBus(request.adapter_index, request.bus_id, bus_iterator->second);
          }
        }
      }
      app_state.adapter_state.rescan_request.reset();
    }
    return ftxui::vbox({
        container->ChildAt(0)->Render(),
        container->ChildAt(1)->Render() | ftxui::flex,
        container->ChildAt(2)->Render(),
    });
  });
}

}  // namespace motor_cli
