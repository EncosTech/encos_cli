#pragma once

#include <encos/encos_motor.h>

#include <memory>
#include <unordered_map>
#include <vector>

#include "calibration_config.h"

namespace emzero {

class CalibrationRunner {
public:
  CalibrationRunner(bool dry_run, bool canfd);

  bool Initialize(const std::vector<CalibrationPoint>& points);
  bool RunCalibration(const std::vector<CalibrationPoint>& points);

private:
  void CalibrateSingleMotor(const CalibrationPoint& point, encos::Motor& motor);

  bool dry_run_;
  bool canfd_;

  std::unordered_map<AdapterKey, encos::BaseAdapterPtr, AdapterKeyHash> adapters_;
  std::unordered_map<std::string, encos::Motor*> motors_;
};

}  // namespace emzero
