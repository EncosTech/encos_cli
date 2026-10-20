#pragma once
#include <cstdint>
#include <filesystem>
#include <string>
#include <vector>

namespace motor_cli {
using FirmwareBytes = std::vector<uint8_t>;
struct OtaStatus {
  uint32_t slot, version, confirmed, pending, ready;
};
FirmwareBytes LoadOtaFirmware(const std::filesystem::path& path);
FirmwareBytes MakeOtaPackage(const FirmwareBytes& payload, uint32_t version);
OtaStatus ParseOtaStatus(const std::string& reply);
bool OtaConfirmed(const OtaStatus& status);
void CheckOtaResult(const OtaStatus& before, const OtaStatus& after, uint32_t version);
int DownloadFirmware(const std::string& endpoint, const std::string& filename);
}  // namespace motor_cli
