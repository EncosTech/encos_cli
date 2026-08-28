#include "trajectory_csv_parser.h"

#include <cmath>
#include <fstream>
#include <sstream>
#include <stdexcept>

namespace emplay {
namespace {

void Trim(std::string& s) {
  const std::size_t start = s.find_first_not_of(" \t\r\n");
  if (start == std::string::npos) {
    s.clear();
    return;
  }
  const std::size_t end = s.find_last_not_of(" \t\r\n");
  s = s.substr(start, end - start + 1);
}

std::vector<std::string> SplitCsvLine(const std::string& line) {
  std::vector<std::string> columns;
  std::stringstream ss(line);
  std::string cell;
  while (std::getline(ss, cell, ',')) {
    Trim(cell);
    columns.push_back(cell);
  }
  return columns;
}

double ParseFiniteDouble(const std::string& value, const std::string& field_name) {
  std::size_t parsed_chars = 0;
  const double parsed = std::stod(value, &parsed_chars);
  if (parsed_chars != value.size() || !std::isfinite(parsed)) {
    throw std::runtime_error(field_name + " must be a finite number");
  }
  return parsed;
}

}  // namespace

Trajectory ParseTrajectoryCsv(const std::string& filepath) {
  std::ifstream file(filepath);
  if (!file.is_open()) {
    throw std::runtime_error("Cannot open file: " + filepath);
  }

  Trajectory trajectory;
  std::string line;
  int line_number = 0;
  bool header_parsed = false;
  double previous_time_s = 0.0;

  while (std::getline(file, line)) {
    ++line_number;
    Trim(line);

    const std::size_t comment_pos = line.find('#');
    if (comment_pos != std::string::npos) {
      line.erase(comment_pos);
      Trim(line);
    }
    if (line.empty()) {
      continue;
    }

    const std::vector<std::string> columns = SplitCsvLine(line);
    if (!header_parsed) {
      if (columns.size() < 2U) {
        throw std::runtime_error("trajectory header must contain time plus at least one motor column");
      }
      if (columns[0] != "time") {
        throw std::runtime_error("trajectory first column must be 'time'");
      }
      for (std::size_t index = 1; index < columns.size(); ++index) {
        trajectory.motor_names.push_back(columns[index]);
        trajectory.motor_connections.push_back(emzero::ParseMotorConnection(columns[index]));
      }
      header_parsed = true;
      continue;
    }

    if (columns.size() != trajectory.motor_names.size() + 1U) {
      throw std::runtime_error("line " + std::to_string(line_number) + ": expected " +
                               std::to_string(trajectory.motor_names.size() + 1U) + " columns, got " +
                               std::to_string(columns.size()));
    }

    TrajectorySample sample;
    sample.time_s = ParseFiniteDouble(columns[0], "time");
    if (!trajectory.samples.empty() && sample.time_s <= previous_time_s) {
      throw std::runtime_error("line " + std::to_string(line_number) + ": time must be strictly increasing");
    }
    previous_time_s = sample.time_s;

    sample.positions_deg.reserve(trajectory.motor_names.size());
    for (std::size_t index = 1; index < columns.size(); ++index) {
      sample.positions_deg.push_back(static_cast<float>(ParseFiniteDouble(columns[index], "position")));
    }
    trajectory.samples.push_back(std::move(sample));
  }

  if (!header_parsed) {
    throw std::runtime_error("trajectory file is empty");
  }
  if (trajectory.samples.empty()) {
    throw std::runtime_error("trajectory file contains no samples");
  }

  return trajectory;
}

}  // namespace emplay
