#pragma once

#include <cstdint>
#include <functional>
#include <optional>
#include <string>

namespace emzero {

struct MotorConnection {
  std::string adapter_type;
  std::string adapter_id;
  std::optional<int32_t> slave_id;
  int32_t bus_id{0};
  uint16_t motor_id{0};
};

struct CalibrationPoint {
  MotorConnection connection;
  float current;           // A，符号表示方向
  float set_position_deg;  // degrees
};

struct AdapterKey {
  std::string type;
  std::string id;
  bool operator==(const AdapterKey& other) const { return type == other.type && id == other.id; }
};

struct AdapterKeyHash {
  std::size_t operator()(const AdapterKey& key) const noexcept {
    return std::hash<std::string>{}(key.type) ^ (std::hash<std::string>{}(key.id) << 1);
  }
};

MotorConnection ParseMotorConnection(const std::string& target_str);
std::string FormatConnection(const MotorConnection& conn);

}  // namespace emzero