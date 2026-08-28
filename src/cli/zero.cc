#include "src/cli/zero.h"

#include <iostream>
#include <vector>

#include "src/calibration_config.h"
#include "src/calibration_runner.h"
#include "src/csv_parser.h"

void ConfigureZeroCommand(argparse::ArgumentParser& parser) {
  parser.add_description("Zero motors from a CSV calibration config");
  parser.add_argument("config").help("Path to CSV config file (motor,current,set_position)");
  parser.add_argument("--canfd").default_value(false).implicit_value(true).help("Enable CAN FD mode on each motor");
  parser.add_argument("--dry-run")
      .default_value(false)
      .implicit_value(true)
      .help("Print actions without sending commands");
}

int RunZeroCommand(const argparse::ArgumentParser& parser) {
  const std::string config_path = parser.get<std::string>("config");
  const bool canfd = parser.get<bool>("--canfd");
  const bool dry_run = parser.get<bool>("--dry-run");

  std::vector<emzero::CalibrationPoint> points;
  try {
    points = emzero::ParseCsvConfig(config_path);
  } catch (const std::exception& e) {
    std::cerr << "Failed to parse config: " << e.what() << "\n";
    return 1;
  }

  if (points.empty()) {
    std::cerr << "No valid calibration points found in config.\n";
    return 1;
  }

  std::cout << "Loaded " << points.size() << " calibration point(s)\n";

  emzero::CalibrationRunner runner(dry_run, canfd);
  if (!dry_run) {
    if (!runner.Initialize(points)) {
      return 1;
    }
  }

  return runner.RunCalibration(points) ? 0 : 1;
}
