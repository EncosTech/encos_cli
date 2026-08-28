#include "csv_parser.h"

#include <cctype>
#include <cmath>
#include <fstream>
#include <iostream>
#include <sstream>
#include <stdexcept>

namespace emzero {

namespace {

void Trim(std::string& s) {
  size_t start = s.find_first_not_of(" \t\r\n");
  if (start == std::string::npos) {
    s.clear();
    return;
  }
  size_t end = s.find_last_not_of(" \t\r\n");
  s = s.substr(start, end - start + 1);
}

std::vector<std::string> SplitColonSeparated(const std::string& value) {
  std::vector<std::string> parts;
  std::size_t start = 0;
  while (start <= value.size()) {
    const std::size_t separator = value.find(':', start);
    if (separator == std::string::npos) {
      parts.push_back(value.substr(start));
      break;
    }
    parts.push_back(value.substr(start, separator - start));
    start = separator + 1;
  }
  return parts;
}

}  // namespace

MotorConnection ParseMotorConnection(const std::string& target_str) {
  const std::vector<std::string> parts = SplitColonSeparated(target_str);
  if (parts.size() != 4 && parts.size() != 5) {
    throw std::runtime_error("Invalid motor target '" + target_str +
                             "', expected AdapterType:AdapterId:BusId:MotorId or "
                             "AdapterType:AdapterId:SlaveId:BusId:MotorId");
  }
  for (const auto& p : parts) {
    if (p.empty()) {
      throw std::runtime_error("Empty target part");
    }
  }

  MotorConnection conn;
  conn.adapter_type = parts[0];
  conn.adapter_id = parts[1];

  if (parts.size() == 4) {
    conn.bus_id = std::stoi(parts[2]);
    conn.motor_id = static_cast<uint16_t>(std::stoul(parts[3]));
  } else {
    conn.slave_id = std::stoi(parts[2]);
    conn.bus_id = std::stoi(parts[3]);
    conn.motor_id = static_cast<uint16_t>(std::stoul(parts[4]));
  }
  return conn;
}

std::string FormatConnection(const MotorConnection& conn) {
  std::string result = conn.adapter_type + ":" + conn.adapter_id;
  if (conn.slave_id.has_value()) {
    result += ":" + std::to_string(*conn.slave_id);
  }
  result += ":" + std::to_string(conn.bus_id) + ":" + std::to_string(conn.motor_id);
  return result;
}

std::vector<CalibrationPoint> ParseCsvConfig(const std::string& filepath) {
  std::ifstream file(filepath);
  if (!file.is_open()) {
    throw std::runtime_error("Cannot open file: " + filepath);
  }

  std::vector<CalibrationPoint> points;
  std::string line;
  int line_number = 0;
  bool first_line = true;

  while (std::getline(file, line)) {
    ++line_number;

    Trim(line);

    // Strip inline comments: everything from the first '#' is ignored
    const size_t comment_pos = line.find('#');
    if (comment_pos != std::string::npos) {
      line.erase(comment_pos);
      Trim(line);
    }

    // Skip empty lines
    if (line.empty()) {
      continue;
    }

    // Skip header line (first non-empty, non-comment line)
    if (first_line) {
      first_line = false;
      continue;
    }

    // Split by comma
    std::vector<std::string> columns;
    std::stringstream ss(line);
    std::string cell;
    while (std::getline(ss, cell, ',')) {
      Trim(cell);
      columns.push_back(cell);
    }

    if (columns.size() != 3) {
      std::cerr << "Error line " << line_number << ": expected 3 columns, got " << columns.size() << " (skipped)\n";
      continue;
    }

    try {
      CalibrationPoint point;
      point.connection = ParseMotorConnection(columns[0]);
      point.current = std::stof(columns[1]);

      // Validate: reject NaN/Inf
      if (!std::isfinite(point.current)) {
        throw std::runtime_error("current must be finite");
      }

      point.set_position_deg = std::stof(columns[2]);
      if (!std::isfinite(point.set_position_deg)) {
        throw std::runtime_error("set_position must be finite");
      }

      points.push_back(std::move(point));
    } catch (const std::exception& e) {
      std::cerr << "Error line " << line_number << ": " << e.what() << " (skipped)\n";
      continue;
    }
  }

  return points;
}

}  // namespace emzero