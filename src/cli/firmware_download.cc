#include "src/cli/firmware_download.h"

#include <algorithm>
#include <array>
#include <cctype>
#include <fstream>
#include <map>
#include <sstream>
#include <stdexcept>

namespace motor_cli {
namespace {
constexpr uint32_t kEntry = 0x80041000;
constexpr size_t kMaxPayload = 0xbf000;
void Require(bool ok, const std::string& message) {
  if (!ok) throw std::runtime_error(message);
}
uint32_t Read(const FirmwareBytes& b, size_t p, size_t n = 4) {
  Require(p <= b.size() && n <= b.size() - p, "Truncated ELF");
  uint32_t v = 0;
  for (size_t i = 0; i < n; ++i) v |= uint32_t(b[p + i]) << (8 * i);
  return v;
}
void Put(FirmwareBytes& b, size_t p, uint32_t v) {
  for (size_t i = 0; i < 4; ++i) b[p + i] = static_cast<uint8_t>(v >> (8 * i));
}
uint32_t Rotate(uint32_t n, unsigned s) { return (n >> s) | (n << (32 - s)); }
std::array<uint8_t, 32> Sha256(FirmwareBytes input) {
  constexpr uint32_t k[] = {
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};
  std::array<uint32_t, 8> h = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                               0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
  const uint64_t bits = uint64_t(input.size()) * 8;
  input.push_back(0x80);
  while (input.size() % 64 != 56) input.push_back(0);
  for (int i = 7; i >= 0; --i) input.push_back(static_cast<uint8_t>(bits >> (i * 8)));
  for (size_t p = 0; p < input.size(); p += 64) {
    uint32_t w[64]{};
    for (size_t i = 0; i < 16; ++i)
      for (size_t j = 0; j < 4; ++j) w[i] = (w[i] << 8) | input[p + i * 4 + j];
    for (size_t i = 16; i < 64; ++i) {
      auto x = w[i - 15], y = w[i - 2];
      w[i] = w[i - 16] + (Rotate(x, 7) ^ Rotate(x, 18) ^ (x >> 3)) + w[i - 7] +
             (Rotate(y, 17) ^ Rotate(y, 19) ^ (y >> 10));
    }
    auto a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], v = h[7];
    for (size_t i = 0; i < 64; ++i) {
      auto t1 = v + (Rotate(e, 6) ^ Rotate(e, 11) ^ Rotate(e, 25)) + ((e & f) ^ (~e & g)) + k[i] + w[i];
      auto t2 = (Rotate(a, 2) ^ Rotate(a, 13) ^ Rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
      v = g;
      g = f;
      f = e;
      e = d + t1;
      d = c;
      c = b;
      b = a;
      a = t1 + t2;
    }
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d;
    h[4] += e;
    h[5] += f;
    h[6] += g;
    h[7] += v;
  }
  std::array<uint8_t, 32> result{};
  for (size_t i = 0; i < 32; ++i) result[i] = static_cast<uint8_t>(h[i / 4] >> (24 - 8 * (i % 4)));
  return result;
}
}  // namespace

FirmwareBytes LoadOtaFirmware(const std::filesystem::path& path) {
  auto ext = path.extension().string();
  std::transform(ext.begin(), ext.end(), ext.begin(), [](unsigned char c) { return char(std::tolower(c)); });
  Require(ext == ".bin" || ext == ".elf", "download expects an OTA application .bin or .elf");
  std::ifstream file(path, std::ios::binary | std::ios::ate);
  Require(bool(file), "Cannot open firmware: " + path.string());
  auto size = file.tellg();
  Require(size > 0 && size <= 64 * 1024 * 1024, "Firmware file is empty or exceeds 64 MiB");
  FirmwareBytes data(static_cast<size_t>(size));
  file.seekg(0);
  Require(bool(file.read(reinterpret_cast<char*>(data.data()), size)), "Cannot read firmware");
  if (ext == ".bin") {
    Require(data.size() <= kMaxPayload, "Firmware exceeds OTA slot");
    Require(
        data.size() < 4 || (Read(data, 0) != 0x464c457f && Read(data, 0) != 0xbeaf5aa5 && Read(data, 0) != 0x48504d2d),
        "Expected raw OTA application .bin, not ELF or an already packaged image");
    // Board ROM image begins with .nor_cfg_option (BOARD_APP_XPI_NOR_CFG_OPT_HDR).
    Require(data.size() < 4 || Read(data, 0) != 0xfcf90002, "ROM boot image is not an OTA application");
    return data;
  }
  Require(data.size() >= 52 && Read(data, 0) == 0x464c457f && data[4] == 1 && data[5] == 1 && data[6] == 1 &&
              Read(data, 16, 2) == 2 && Read(data, 18, 2) == 243 && Read(data, 24) == kEntry,
          "ELF must be an executable little-endian ELF32 RISC-V OTA application linked at 0x80041000");
  const size_t offset = Read(data, 28), stride = Read(data, 42, 2), count = Read(data, 44, 2);
  Require(count > 0 && stride >= 32 && offset <= data.size() && count <= (data.size() - offset) / stride,
          "Invalid ELF program headers");
  FirmwareBytes payload, used(kMaxPayload);
  for (size_t i = 0; i < count; ++i) {
    auto p = offset + i * stride;
    if (Read(data, p) != 1 || Read(data, p + 16) == 0) continue;  // PT_LOAD, skip BSS
    const size_t source = Read(data, p + 4), address = Read(data, p + 12), length = Read(data, p + 16);
    Require(source <= data.size() && length <= data.size() - source && length <= Read(data, p + 20),
            "Truncated ELF load segment");
    Require(address >= kEntry && address - kEntry < kMaxPayload && length <= kMaxPayload - (address - kEntry),
            "ELF load segment is outside OTA application flash");
    auto target = address - kEntry;
    payload.resize(std::max(payload.size(), target + length), 0);
    for (size_t j = 0; j < length; ++j) {
      Require(!used[target + j], "Overlapping ELF load segments");
      used[target + j] = 1;
      payload[target + j] = data[source + j];
    }
  }
  Require(!payload.empty() && used[0], "ELF has no loadable OTA entry point");
  return payload;
}

FirmwareBytes MakeOtaPackage(const FirmwareBytes& payload, uint32_t version) {
  Require(!payload.empty() && payload.size() <= kMaxPayload, "Firmware is empty or exceeds OTA slot");
  Require(version > 0 && version < 0xffffffff, "OTA version exhausted (valid range 1..0xfffffffe)");
  FirmwareBytes image(4096, 0);
  Put(image, 0, 0xbeaf5aa5);
  Put(image, 4, 0xa5a55a5a);
  Put(image, 8, 0x3843414e);
  Put(image, 12, static_cast<uint32_t>(payload.size()));
  Put(image, 16, version);
  image[21] = 1;
  image[22] = 1;
  image[23] = 4;
  auto hash = Sha256(payload);
  std::copy(hash.begin(), hash.end(), image.begin() + 28);
  image.insert(image.end(), payload.begin(), payload.end());
  FirmwareBytes blocks(((image.size() + 479) / 480) * 512, 0);
  for (size_t i = 0; i < blocks.size() / 512; ++i) {
    auto b = i * 512, source = i * 480, length = std::min(size_t(480), image.size() - source);
    Put(blocks, b, 0x48504d2d);
    Put(blocks, b + 4, 0x9e5d5157);
    Put(blocks, b + 12, version);
    Put(blocks, b + 16, static_cast<uint32_t>(image.size()));
    Put(blocks, b + 20, static_cast<uint32_t>(i));
    Put(blocks, b + 24, static_cast<uint32_t>(length));
    Put(blocks, b + 508, 0x48454e44);
    std::copy_n(image.begin() + source, length, blocks.begin() + b + 28);
  }
  return blocks;
}

OtaStatus ParseOtaStatus(const std::string& reply) {
  Require(reply.rfind("OK OTA ", 0) == 0, "OTA STATUS failed: " + reply);
  std::istringstream input(reply.substr(7));
  std::map<std::string, uint32_t> fields;
  std::string token;
  while (input >> token) {
    auto p = token.find('=');
    Require(p != std::string::npos && p + 1 < token.size() &&
                token.find_first_not_of("0123456789", p + 1) == std::string::npos,
            "Malformed OTA STATUS: " + reply);
    auto value = std::stoull(token.substr(p + 1));
    Require(value <= 0xffffffff && fields.emplace(token.substr(0, p), static_cast<uint32_t>(value)).second,
            "Invalid OTA STATUS field");
  }
  for (auto key : {"SLOT", "VERSION", "CONFIRMED", "PENDING", "READY"})
    Require(fields.count(key) != 0, "Missing OTA STATUS field: " + std::string(key));
  OtaStatus status{fields["SLOT"], fields["VERSION"], fields["CONFIRMED"], fields["PENDING"], fields["READY"]};
  Require(status.slot < 2 && status.ready <= 1, "Invalid OTA slot or readiness");
  return status;
}
bool OtaConfirmed(const OtaStatus& s) { return s.ready == 1 && s.confirmed == s.slot && s.pending == 0xffffffff; }
void CheckOtaResult(const OtaStatus& before, const OtaStatus& after, uint32_t version) {
  Require(OtaConfirmed(after), "New firmware has not confirmed startup");
  Require(after.slot == 1 - before.slot && after.version == version,
          "Firmware update failed or rolled back: expected alternate slot and version " + std::to_string(version));
}
}  // namespace motor_cli
