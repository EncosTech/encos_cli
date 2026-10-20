#include "src/cli/firmware_download.h"

#include <chrono>
#include <doctest.hpp>
#include <fstream>
#include <limits>

namespace motor_cli {
TEST_CASE("OTA package matches SHA256 golden vector and transport framing") {
  auto bytes = MakeOtaPackage({'a', 'b', 'c'}, 8);
  REQUIRE(bytes.size() == 9 * 512);
  CHECK(FirmwareBytes(bytes.begin(), bytes.begin() + 8) ==
        FirmwareBytes{0x2d, 0x4d, 0x50, 0x48, 0x57, 0x51, 0x5d, 0x9e});
  CHECK(bytes[12] == 8);
  CHECK(bytes[16] == 3);
  CHECK(bytes[17] == 16);
  const FirmwareBytes hash = {0xba, 0x78, 0x16, 0xbf, 0x8f, 0x01, 0xcf, 0xea, 0x41, 0x41, 0x40,
                              0xde, 0x5d, 0xae, 0x22, 0x23, 0xb0, 0x03, 0x61, 0xa3, 0x96, 0x17,
                              0x7a, 0x9c, 0xb4, 0x10, 0xff, 0x61, 0xf2, 0x00, 0x15, 0xad};
  CHECK(FirmwareBytes(bytes.begin() + 56, bytes.begin() + 88) == hash);
  CHECK(bytes[8 * 512 + 24] == 3);  // 259 bytes in last block
  CHECK(bytes[8 * 512 + 25] == 1);
  CHECK(bytes[8 * 512 + 28 + 256] == 'a');
  CHECK(bytes[8 * 512 + 508] == 0x44);
  CHECK_THROWS(MakeOtaPackage({}, 1));
  CHECK_THROWS(MakeOtaPackage({'a'}, 0));
  CHECK_THROWS(MakeOtaPackage({'a'}, 0xffffffff));
  CHECK_THROWS(MakeOtaPackage(FirmwareBytes(0xbf001), 1));
}
TEST_CASE("OTA success requires the expected version and confirmed alternate slot") {
  auto before = ParseOtaStatus("OK OTA SLOT=1 VERSION=7 CONFIRMED=1 PENDING=4294967295 READY=1\r\n");
  CHECK(OtaConfirmed(before));
  auto after = ParseOtaStatus("OK OTA SLOT=0 VERSION=8 CONFIRMED=0 PENDING=4294967295 READY=1");
  CHECK_NOTHROW(CheckOtaResult(before, after, 8));
  CHECK_THROWS(CheckOtaResult(before, before, 8));
  after.version = 9;
  CHECK_THROWS(CheckOtaResult(before, after, 8));
  after.pending = 0;
  CHECK_FALSE(OtaConfirmed(after));
  CHECK_THROWS(ParseOtaStatus("ERR BUSY"));
  CHECK_THROWS(ParseOtaStatus("OK OTA SLOT=1 VERSION=7"));
  CHECK_THROWS(ParseOtaStatus("OK OTA SLOT=2 VERSION=7 CONFIRMED=1 PENDING=4294967295 READY=1"));
}
}  // namespace motor_cli

namespace {
struct TempFirmware {
  std::filesystem::path directory;
  TempFirmware() {
    const auto stamp = std::chrono::steady_clock::now().time_since_epoch().count();
    directory = std::filesystem::temp_directory_path() / ("emcli-firmware-test-" + std::to_string(stamp));
    std::filesystem::create_directory(directory);
  }
  ~TempFirmware() {
    std::error_code ec;
    std::filesystem::remove_all(directory, ec);
  }
  std::filesystem::path Write(const motor_cli::FirmwareBytes& bytes, const char* name = "test.elf") {
    auto path = directory / name;
    std::ofstream file(path, std::ios::binary);
    file.write(reinterpret_cast<const char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
    return path;
  }
};
void Put(motor_cli::FirmwareBytes& data, size_t offset, uint32_t value, unsigned count = 4) {
  for (unsigned i = 0; i < count; ++i) data.at(offset + i) = static_cast<uint8_t>(value >> (i * 8));
}
motor_cli::FirmwareBytes ExampleElf() {
  motor_cli::FirmwareBytes b(124);
  Put(b, 0, 0x464c457f);
  b[4] = 1;
  b[5] = 1;
  b[6] = 1;
  Put(b, 16, 2, 2);
  Put(b, 18, 243, 2);
  Put(b, 24, 0x80041000);
  Put(b, 28, 52);
  Put(b, 42, 32, 2);
  Put(b, 44, 2, 2);
  // Two PT_LOADs: second executes from RAM but loads from flash, with a hole.
  for (size_t p : {size_t(52), size_t(84)}) {
    Put(b, p, 1);
    Put(b, p + 16, 4);
    Put(b, p + 20, 8);
  }
  Put(b, 56, 116);
  Put(b, 60, 0x80041000);
  Put(b, 64, 0x80041000);
  Put(b, 88, 120);
  Put(b, 92, 0);
  Put(b, 96, 0x80041008);
  Put(b, 116, 0x04030201);
  Put(b, 120, 0x08070605);
  return b;
}
}  // namespace
TEST_CASE("ELF extraction uses physical load addresses and rejects unsafe inputs") {
  using namespace motor_cli;
  TempFirmware temp;
  const auto original = ExampleElf();
  CHECK(LoadOtaFirmware(temp.Write(original)) == FirmwareBytes{1, 2, 3, 4, 0, 0, 0, 0, 5, 6, 7, 8});
  for (auto change : {0, 1, 2, 3, 4, 5, 6}) {
    auto b = original;
    if (change == 0) Put(b, 24, 0x80001000);  // wrong linked entry
    if (change == 1) Put(b, 28, 0xfffffff0);  // table overflow
    if (change == 2) Put(b, 96, 0x80041002);  // overlap
    if (change == 3) Put(b, 96, 0x800fffff);  // outside slot
    if (change == 4) Put(b, 88, 123);         // truncated segment
    if (change == 5) b[5] = 2;                // big endian
    if (change == 6) Put(b, 18, 62, 2);       // x86
    CHECK_THROWS(LoadOtaFirmware(temp.Write(b)));
  }
  CHECK(LoadOtaFirmware(temp.Write({1, 2, 3, 4}, "raw.bin")) == FirmwareBytes{1, 2, 3, 4});
  CHECK_THROWS(LoadOtaFirmware(temp.Write({}, "empty.bin")));
  CHECK_THROWS(LoadOtaFirmware(temp.Write({2, 0, 0xf9, 0xfc}, "rom.bin")));
  CHECK_THROWS(LoadOtaFirmware(temp.Write(original, "elf-disguised.bin")));
  CHECK_THROWS(LoadOtaFirmware(temp.Write({1}, "wrong.hex")));
}
