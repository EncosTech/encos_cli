#include "components/left_panel.h"

#include <encos_motor.h>

#include <doctest.hpp>
#include <string>
#include <unordered_map>
#include <vector>

#include "components/app_state.h"

namespace motor_cli {

std::vector<int> SortMotorIdsForDisplay(const std::unordered_map<int, encos::Motor*>& motors);
bool ShouldShowMotorScanDialog(bool scan_active, bool dialog_has_rendered);
std::vector<int32_t> SortBusIdsForDisplay(const std::unordered_map<int, encos::Bus*>& buses);
bool IsSelectedMotor(const std::shared_ptr<SelectedMotor>& selected_motor, std::size_t adapter_index, int32_t bus_id,
                     int32_t motor_id);

TEST_CASE("Motor list IDs are sorted in ascending numeric order") {
  const std::unordered_map<int, encos::Motor*> motors = {
      {42, nullptr},
      {3, nullptr},
      {17, nullptr},
  };

  CHECK(SortMotorIdsForDisplay(motors) == std::vector<int>{3, 17, 42});
}

TEST_CASE("Completed scan remains visible until its loading dialog has rendered") {
  CHECK(ShouldShowMotorScanDialog(false, false));
  CHECK(ShouldShowMotorScanDialog(true, false));
  CHECK(ShouldShowMotorScanDialog(true, true));
  CHECK_FALSE(ShouldShowMotorScanDialog(false, true));
}

TEST_CASE("Bus list is ordered by its raw adapter bus ID") {
  const std::unordered_map<int, encos::Bus*> buses = {
      {0x00020001, nullptr}, {4, nullptr}, {0x00010000, nullptr}, {1, nullptr}, {0x00020000, nullptr},
  };

  CHECK(SortBusIdsForDisplay(buses) == std::vector<int32_t>{1, 4, 0x00010000, 0x00020000, 0x00020001});
}

TEST_CASE("Motor highlight matches adapter bus and motor ID") {
  auto selected_motor = std::make_shared<SelectedMotor>();
  selected_motor->adapter_index = 1;
  selected_motor->bus_id = 7;
  selected_motor->motor_id = 44;

  CHECK(IsSelectedMotor(selected_motor, 1, 7, 44));
  CHECK_FALSE(IsSelectedMotor(selected_motor, 1, 6, 44));
  CHECK_FALSE(IsSelectedMotor(selected_motor, 0, 7, 44));
  CHECK_FALSE(IsSelectedMotor(selected_motor, 1, 7, 43));
}

TEST_CASE("Rescan clears cached motors and the selected motor before rediscovery") {
  encos::BaseAdapterPtr adapter =
      encos::MakeAdapter("Fake", "tui-rescan-state-reset", "tui-rescan-state-reset", encos::LogLevel::Off);
  REQUIRE(adapter != nullptr);
  encos::Bus* bus = adapter->GetBus();
  REQUIRE(bus != nullptr);
  encos::Motor* motor = bus->GetMotor(7, encos::MotorModel::EC_A4310_P2);
  REQUIRE(motor != nullptr);

  AppState app_state;
  auto selected_motor = std::make_shared<SelectedMotor>();
  selected_motor->motor = motor;
  app_state.SetSelectedMotor(std::move(selected_motor));

  ClearMotorsForRescan(app_state, {bus});

  CHECK_FALSE(app_state.HasSelectedMotor());
  CHECK(bus->GetMotors().empty());
  CHECK(encos::DeleteAdapter(adapter));
}

}  // namespace motor_cli
