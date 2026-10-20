#include <algorithm>
#include <cctype>
#include <chrono>
#include <cstring>
#include <fstream>
#include <iostream>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <thread>

#include "serialib.h"
#include "src/cli/firmware_download.h"
#if defined(_WIN32)
#include <cfgmgr32.h>
#include <setupapi.h>
#include <windows.h>
#include <winioctl.h>
#else
#include <fcntl.h>
#include <sys/wait.h>
#include <unistd.h>

#include <cerrno>
#include <csignal>
#endif

namespace motor_cli {
namespace {
namespace fs = std::filesystem;
using Clock = std::chrono::steady_clock;
void Require(bool ok, const std::string& why) {
  if (!ok) throw std::runtime_error(why);
}
std::string Lower(std::string s) {
  std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return char(std::tolower(c)); });
  return s;
}
struct Identity {
  std::string serial;
  std::string location;
};
std::string Command(std::string endpoint, const std::string& command) {
#if defined(_WIN32)
  if (Lower(endpoint).rfind("com", 0) == 0) endpoint = "\\\\.\\" + endpoint;
#endif
  serialib port;
  Require(port.openDevice(endpoint.c_str(), 115200) == 1, "Cannot open CDC device: " + endpoint);
  port.flushReceiver();
  Require(port.writeString((command + "\n").c_str()) == 1, "CDC write failed: " + command);
  char reply[256]{};
  Require(port.readString(reply, '\n', sizeof reply - 1, 1500) > 0 && std::strchr(reply, '\n'),
          "No complete CDC response: " + command);
  std::string result(reply);
  while (!result.empty() && (result.back() == '\r' || result.back() == '\n')) result.pop_back();
  return result;
}
#if defined(_WIN32)
constexpr GUID kPorts = {0x4d36e978, 0xe325, 0x11ce, {0xbf, 0xc1, 0x08, 0x00, 0x2b, 0xe1, 0x03, 0x18}};
constexpr GUID kDisk = {0x53f56307, 0xb6bf, 0x11d0, {0x94, 0xf2, 0x00, 0xa0, 0xc9, 0x1e, 0xfb, 0x8b}};
struct DeviceSet {
  HDEVINFO value;
  ~DeviceSet() {
    if (value != INVALID_HANDLE_VALUE) SetupDiDestroyDeviceInfoList(value);
  }
};
struct Handle {
  HANDLE value;
  ~Handle() {
    if (value != INVALID_HANDLE_VALUE) CloseHandle(value);
  }
};
std::string UsbSerial(DEVINST instance) {
  for (unsigned i = 0; i < 16; ++i) {
    char id[MAX_DEVICE_ID_LEN]{};
    if (CM_Get_Device_IDA(instance, id, MAX_DEVICE_ID_LEN, 0) != CR_SUCCESS) break;
    auto s = Lower(id);
    if (s.rfind("usb\\vid_34b7&pid_ffff\\", 0) == 0) return s.substr(s.rfind('\\') + 1);
    DEVINST parent;
    if (CM_Get_Parent(&parent, instance, 0) != CR_SUCCESS) break;
    instance = parent;
  }
  return {};
}
std::vector<std::pair<std::string, std::string>> Ports() {
  std::vector<std::pair<std::string, std::string>> result;
  DeviceSet set{SetupDiGetClassDevsA(&kPorts, nullptr, nullptr, DIGCF_PRESENT)};
  if (set.value == INVALID_HANDLE_VALUE) return result;
  SP_DEVINFO_DATA info{};
  info.cbSize = sizeof info;
  for (DWORD i = 0; SetupDiEnumDeviceInfo(set.value, i, &info); ++i) {
    auto serial = UsbSerial(info.DevInst);
    if (serial.empty()) continue;
    auto key = SetupDiOpenDevRegKey(set.value, &info, DICS_FLAG_GLOBAL, 0, DIREG_DEV, KEY_READ);
    if (key == INVALID_HANDLE_VALUE) continue;
    char name[256]{};
    DWORD size = sizeof name, type = 0;
    auto status = RegQueryValueExA(key, "PortName", nullptr, &type, reinterpret_cast<BYTE*>(name), &size);
    RegCloseKey(key);
    if (status == ERROR_SUCCESS && type == REG_SZ && size < sizeof name && Lower(name).rfind("com", 0) == 0)
      result.emplace_back(name, serial);
  }
  return result;
}
Identity Identify(const std::string& endpoint) {
  for (const auto& port : Ports())
    if (Lower(port.first) == Lower(endpoint)) return {port.second, {}};
  throw std::runtime_error("CDC port is not an HPMicro gateway: " + endpoint);
}
std::string FindPort(const Identity& identity) {
  std::string result;
  for (const auto& port : Ports())
    if (port.second == identity.serial) {
      Require(result.empty(), "Multiple CDC ports match gateway UUID");
      result = port.first;
    }
  return result;
}
fs::path FindVolume(const Identity& identity) {
  DeviceSet set{SetupDiGetClassDevsA(&kDisk, nullptr, nullptr, DIGCF_PRESENT | DIGCF_DEVICEINTERFACE)};
  if (set.value == INVALID_HANDLE_VALUE) return {};
  std::optional<DWORD> disk;
  SP_DEVICE_INTERFACE_DATA iface{};
  iface.cbSize = sizeof iface;
  for (DWORD i = 0; SetupDiEnumDeviceInterfaces(set.value, nullptr, &kDisk, i, &iface); ++i) {
    DWORD size = 0;
    SetupDiGetDeviceInterfaceDetailW(set.value, &iface, nullptr, 0, &size, nullptr);
    if (!size) continue;
    std::vector<BYTE> buffer(size);
    auto detail = reinterpret_cast<SP_DEVICE_INTERFACE_DETAIL_DATA_W*>(buffer.data());
    detail->cbSize = sizeof(SP_DEVICE_INTERFACE_DETAIL_DATA_W);
    SP_DEVINFO_DATA info{};
    info.cbSize = sizeof info;
    if (!SetupDiGetDeviceInterfaceDetailW(set.value, &iface, detail, size, nullptr, &info) ||
        UsbSerial(info.DevInst) != identity.serial)
      continue;
    Handle file{
        CreateFileW(detail->DevicePath, 0, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, 0, nullptr)};
    STORAGE_DEVICE_NUMBER number{};
    DWORD got = 0;
    if (file.value != INVALID_HANDLE_VALUE && DeviceIoControl(file.value, IOCTL_STORAGE_GET_DEVICE_NUMBER, nullptr, 0,
                                                              &number, sizeof number, &got, nullptr)) {
      Require(!disk.has_value(), "Multiple disks match gateway UUID");
      disk = number.DeviceNumber;
    }
  }
  if (!disk) return {};
  wchar_t drives[512]{};
  DWORD length = GetLogicalDriveStringsW(512, drives);
  if (!length || length >= 512) return {};
  fs::path result;
  for (const wchar_t* drive = drives; *drive; drive += wcslen(drive) + 1) {
    std::wstring name = L"\\\\.\\" + std::wstring(drive, 2);
    Handle volume{CreateFileW(name.c_str(), 0, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, 0, nullptr)};
    STORAGE_DEVICE_NUMBER number{};
    DWORD got = 0;
    if (volume.value != INVALID_HANDLE_VALUE &&
        DeviceIoControl(volume.value, IOCTL_STORAGE_GET_DEVICE_NUMBER, nullptr, 0, &number, sizeof number, &got,
                        nullptr) &&
        number.DeviceNumber == *disk) {
      Require(result.empty(), "Multiple volumes match gateway UUID");
      result = drive;
    }
  }
  return result;
}
void WritePackage(const fs::path& path, const FirmwareBytes& bytes) {
  Handle file{CreateFileW(path.c_str(), GENERIC_WRITE, FILE_SHARE_READ, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL,
                          nullptr)};
  Require(file.value != INVALID_HANDLE_VALUE, "Cannot create upgrade file on USB volume");
  DWORD written = 0;
  Require(WriteFile(file.value, bytes.data(), static_cast<DWORD>(bytes.size()), &written, nullptr) &&
              written == bytes.size(),
          "USB firmware write failed");
  Require(FlushFileBuffers(file.value) != 0, "USB firmware flush failed");
}
#else
std::string Text(const fs::path& path) {
  std::ifstream input(path);
  std::string value;
  std::getline(input, value);
  return value;
}
fs::path UsbParent(const fs::path& path) {
  std::error_code ec;
  auto p = fs::canonical(path, ec);
  if (ec) return {};
  while (!p.empty() && p != p.root_path()) {
    if (fs::exists(p / "idVendor", ec)) return p;
    p = p.parent_path();
  }
  return {};
}
fs::path PortUsb(const std::string& port) {
  std::error_code ec;
  auto name = fs::canonical(port, ec).filename();
  return ec ? fs::path{} : UsbParent(fs::path("/sys/class/tty") / name / "device");
}
bool Matches(const fs::path& usb, const Identity& identity) {
  return !usb.empty() && usb.string() == identity.location && Text(usb / "idVendor") == "34b7" &&
         Text(usb / "idProduct") == "ffff" && Lower(Text(usb / "serial")) == identity.serial;
}
Identity Identify(const std::string& endpoint) {
  auto usb = PortUsb(endpoint);
  Require(!usb.empty() && Text(usb / "idVendor") == "34b7" && Text(usb / "idProduct") == "ffff",
          "CDC port is not an HPMicro gateway: " + endpoint);
  return {Lower(Text(usb / "serial")), usb.string()};
}
std::string FindPort(const Identity& identity) {
  std::string result;
  std::error_code ec;
  for (const auto& tty : fs::directory_iterator("/sys/class/tty", ec)) {
    if (Matches(UsbParent(tty.path() / "device"), identity)) {
      Require(result.empty(), "Multiple CDC ports match gateway UUID");
      result = "/dev/" + tty.path().filename().string();
    }
  }
  return result;
}
std::string UnescapeMount(const std::string& text) {
  std::string result;
  for (size_t i = 0; i < text.size(); ++i) {
    if (text[i] == '\\' && i + 3 < text.size() && text[i + 1] >= '0' && text[i + 1] <= '7' && text[i + 2] >= '0' &&
        text[i + 2] <= '7' && text[i + 3] >= '0' && text[i + 3] <= '7') {
      result += static_cast<char>((text[i + 1] - '0') * 64 + (text[i + 2] - '0') * 8 + text[i + 3] - '0');
      i += 3;
    } else
      result += text[i];
  }
  return result;
}
fs::path FindVolume(const Identity& identity) {
  fs::path result;
  std::ifstream mounts("/proc/mounts");
  std::string line;
  while (std::getline(mounts, line)) {
    std::istringstream row(line);
    std::string device, mount;
    if (!(row >> device >> mount)) continue;
    std::error_code ec;
    auto resolved = fs::canonical(UnescapeMount(device), ec);
    if (ec) continue;
    auto usb = UsbParent(fs::path("/sys/class/block") / resolved.filename());
    if (Matches(usb, identity) && Text(usb / "product") == "Encos Gateway OTA") {
      Require(result.empty(), "Multiple mounts match gateway UUID");
      result = UnescapeMount(mount);
    }
  }
  return result;
}
bool TryMount(const Identity& identity) {
  // No shell: device names never become command text. Polkit may allow the active desktop user.
  std::error_code ec;
  for (const auto& block : fs::directory_iterator("/sys/class/block", ec)) {
    auto usb = UsbParent(block.path());
    if (!Matches(usb, identity) || Text(usb / "product") != "Encos Gateway OTA" ||
        fs::exists(block.path() / "partition", ec))
      continue;
    auto device = "/dev/" + block.path().filename().string();
    auto child = fork();
    if (child == 0) {
      execlp("udisksctl", "udisksctl", "mount", "--no-user-interaction", "-b", device.c_str(),
             static_cast<char*>(nullptr));
      _exit(127);
    }
    if (child < 0) return false;
    auto deadline = Clock::now() + std::chrono::seconds(5);
    int status = 0;
    while (waitpid(child, &status, WNOHANG) == 0) {
      if (Clock::now() >= deadline) {
        kill(child, SIGKILL);
        waitpid(child, &status, 0);
        break;
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
    return true;
  }
  return false;
}
void WritePackage(const fs::path& path, const FirmwareBytes& bytes) {
  int fd = open(path.c_str(), O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC | O_NOFOLLOW, 0644);
  Require(fd >= 0, "Cannot create upgrade file: " + path.string() + ": " + std::strerror(errno));
  size_t offset = 0;
  while (offset < bytes.size()) {
    auto n = write(fd, bytes.data() + offset, bytes.size() - offset);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) {
      auto error = std::string(std::strerror(errno));
      close(fd);
      throw std::runtime_error("USB write failed: " + error);
    }
    offset += static_cast<size_t>(n);
  }
  const int flushed = fsync(fd), closed = close(fd);
  Require(flushed == 0 && closed == 0, "USB firmware flush failed; update is not confirmed");
}
#endif
}  // namespace

int DownloadFirmware(const std::string& endpoint, const std::string& filename) {
  // Validate everything possible before asking the running firmware to reboot.
  auto payload = LoadOtaFirmware(fs::u8path(filename));
  const auto identity = Identify(endpoint);
  Require(identity.serial.size() == 32 && identity.serial.find_first_not_of("0123456789abcdef") == std::string::npos,
          "Gateway USB serial must be a 32-digit UUID; update the bootloader before using one-click download");
  auto before = ParseOtaStatus(Command(endpoint, "OTA STATUS"));
  Require(OtaConfirmed(before), "Gateway is not ready or has an unconfirmed OTA trial; retry after startup");
  Require(before.version < 0xfffffffe, "OTA version exhausted");
  const uint32_t version = before.version + 1;
  auto package = MakeOtaPackage(payload, version);
  std::cout << "Gateway " << identity.serial << ": slot " << before.slot << ", version " << before.version << " -> "
            << version << ", " << payload.size() << " firmware bytes\nEntering USB bootloader..." << std::endl;
  auto reply = Command(endpoint, "OTA ENTER");
  Require(reply == "OK OTA REBOOT", "Cannot enter OTA: " + reply);
  fs::path volume;
  auto start = Clock::now(), deadline = start + std::chrono::seconds(40);
#if !defined(_WIN32)
  bool mount_attempted = false;
#endif
  while (Clock::now() < deadline) {
    volume = FindVolume(identity);
    if (!volume.empty()) break;
#if !defined(_WIN32)
    if (!mount_attempted && Clock::now() - start > std::chrono::seconds(5)) {
      mount_attempted = TryMount(identity);
    }
#endif
    std::this_thread::sleep_for(std::chrono::milliseconds(200));
  }
  Require(!volume.empty(), "OTA USB volume did not mount within 40 s; check automount/udisks and USB permissions");
  Require(FindVolume(identity) == volume, "OTA USB identity changed before write");
  std::cout << "Writing " << package.size() << " bytes to " << volume.string() << std::endl;
  WritePackage(volume / "usb_device_update.upd", package);
  std::cout << "Firmware flushed; waiting for confirmed application startup..." << std::endl;
  deadline = Clock::now() + std::chrono::seconds(100);
  std::string last_error;
  while (Clock::now() < deadline) {
    auto port = FindPort(identity);
    std::optional<OtaStatus> status;
    if (!port.empty()) {
      try {
        status = ParseOtaStatus(Command(port, "OTA STATUS"));
      } catch (const std::exception& error) {
        last_error = error.what();
      }
    }
    if (status && OtaConfirmed(*status)) {
      CheckOtaResult(before, *status, version);
      std::cout << "Download successful: " << port << ", slot " << status->slot << ", version " << status->version
                << ", confirmed and ready." << std::endl;
      return 0;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(500));
  }
  throw std::runtime_error("Application did not confirm the update within 100 s. " + last_error);
}
}  // namespace motor_cli
