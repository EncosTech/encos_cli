// SPDX-License-Identifier: MIT

#pragma once
#include <array>
#include <optional>
#include <string>
#include <vector>
namespace motor_cli {
bool IsEthercatPlugin(const std::string& name);
struct SlaveScanRow {
  unsigned index;
  std::string uuid;
};
std::vector<SlaveScanRow> ScanEthernetSlaves(const std::string& interface);
std::string FormatSlaveTable(std::vector<SlaveScanRow> rows);
struct SlaveConfigTarget {
  bool serial = false;
  std::string endpoint;
  std::optional<unsigned> slave;
  std::array<unsigned char, 16> uuid{};
};
struct SlaveConfigRequest {
  SlaveConfigTarget target;
  std::vector<std::string> commands;
};
/** @brief 仅将指定的Ethernet/Ethercat连接串识别为从站配置；其他目标保留电机语义。 */
std::optional<SlaveConfigRequest> ParseSlaveConfig(const std::vector<std::string>& args);
/** @brief 执行从站配置，写配置成功保存后自动重启。 */
std::optional<int> RunSlaveConfig(const std::vector<std::string>& args);
std::string SlaveConfigHelp();
}  // namespace motor_cli
