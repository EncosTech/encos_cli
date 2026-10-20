// SPDX-License-Identifier: MIT

#include "csv_parser.h"

#include <cctype>
#include <cmath>
#include <fstream>
#include <iostream>
#include <sstream>
#include <stdexcept>

namespace emzero {

namespace {

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

}  // namespace emzero