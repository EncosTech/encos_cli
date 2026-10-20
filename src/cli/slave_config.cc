// SPDX-License-Identifier: MIT

#include "src/cli/slave_config.h"

#include "src/cli/firmware_download.h"
#include "src/cli/help_text.h"

#if defined(_WIN32)
// clang-format off
#include <winsock2.h>
#include <ws2tcpip.h>
#include <iphlpapi.h>
#include <netioapi.h>
// clang-format on
#include <serialib.h>
#ifndef IFNAMSIZ
#define IFNAMSIZ 16
#endif
#else
#include <arpa/inet.h>
#include <net/if.h>
#include <poll.h>
#include <serialib.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <unistd.h>
#endif

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cstring>
#include <iomanip>
#include <iostream>
#include <map>
#include <sstream>
#include <stdexcept>

namespace motor_cli {
namespace {
using Clock = std::chrono::steady_clock;
using Bytes = std::vector<unsigned char>;

#if defined(_WIN32)
using SocketHandle = SOCKET;
constexpr SocketHandle kInvalidSocket = INVALID_SOCKET;
int CloseSocket(SocketHandle handle) { return closesocket(handle); }
bool SocketValid(SocketHandle handle) { return handle != INVALID_SOCKET; }
void EnsureSocketsInitialized() {
  static const bool initialized = []() {
    WSADATA data{};
    return WSAStartup(MAKEWORD(2, 2), &data) == 0;
  }();
  (void)initialized;
}
std::string Utf16ToUtf8(const wchar_t* value) {
  if (value == nullptr) return {};
  const int size = WideCharToMultiByte(CP_UTF8, 0, value, -1, nullptr, 0, nullptr, nullptr);
  if (size <= 0) return {};
  std::string result(static_cast<std::size_t>(size), '\0');
  WideCharToMultiByte(CP_UTF8, 0, value, -1, result.data(), size, nullptr, nullptr);
  result.pop_back();
  return result;
}
bool ResolveInterface(const std::string& name, unsigned* index, in_addr* address) {
  const ULONG flags = GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER;
  ULONG size = 0;
  if (GetAdaptersAddresses(AF_INET, flags, nullptr, nullptr, &size) != ERROR_BUFFER_OVERFLOW) return false;
  std::vector<unsigned char> buffer(size);
  auto* adapters = reinterpret_cast<IP_ADAPTER_ADDRESSES*>(buffer.data());
  if (GetAdaptersAddresses(AF_INET, flags, nullptr, adapters, &size) != NO_ERROR) return false;
  for (auto* adapter = adapters; adapter != nullptr; adapter = adapter->Next) {
    if (adapter->OperStatus != IfOperStatusUp) continue;
    const std::string friendly = Utf16ToUtf8(adapter->FriendlyName);
    const std::string adapter_name = adapter->AdapterName != nullptr ? adapter->AdapterName : std::string();
    if (name != friendly && name != adapter_name) continue;
    auto* unicast = adapter->FirstUnicastAddress;
    if (unicast == nullptr || unicast->Address.lpSockaddr == nullptr) continue;
    if (unicast->Address.lpSockaddr->sa_family != AF_INET) continue;
    const auto* ipv4 = reinterpret_cast<const sockaddr_in*>(unicast->Address.lpSockaddr);
    *index = adapter->IfIndex;
    *address = ipv4->sin_addr;
    return true;
  }
  return false;
}
#else
using SocketHandle = int;
constexpr SocketHandle kInvalidSocket = -1;
int CloseSocket(SocketHandle handle) { return close(handle); }
bool SocketValid(SocketHandle handle) { return handle >= 0; }
void EnsureSocketsInitialized() {}
bool ResolveInterface(const std::string& name, unsigned* index, in_addr* address) {
  *index = if_nametoindex(name.c_str());
  if (*index == 0) return false;
  const SocketHandle probe = socket(AF_INET, SOCK_DGRAM, 0);
  if (!SocketValid(probe)) return false;
  ifreq request{};
  std::strncpy(request.ifr_name, name.c_str(), IFNAMSIZ - 1);
  const bool ok = ioctl(probe, SIOCGIFADDR, &request) == 0;
  if (ok) *address = reinterpret_cast<sockaddr_in*>(&request.ifr_addr)->sin_addr;
  close(probe);
  return ok;
}
#endif
bool IsSerialEndpoint(const std::string& name) {
  if (name.rfind("/dev/", 0) == 0) {
    return true;
  }
#if defined(_WIN32)
  if (name.size() > 3) {
    const std::string prefix = name.substr(0, 3);
    if (prefix == "COM" || prefix == "com") {
      return name.find_first_not_of("0123456789", 3) == std::string::npos;
    }
  }
#endif
  return false;
}

void Require(bool condition, const std::string& message) {
  if (!condition) throw std::runtime_error(message);
}
unsigned Number(const std::string& value) {
  Require(!value.empty() && value.size() <= 3 && value.find_first_not_of("0123456789") == std::string::npos,
          "Slave ID must be 0..252");
  unsigned id = static_cast<unsigned>(std::stoul(value));
  Require(id <= 252, "Slave ID must be 0..252 (.254 is reserved for host)");
  return id;
}
/** @brief CLI mode token and the firmware's MODE SET spelling for it.
 *  The tokens must stay in sync with SlaveConfigHelp(). */
struct GatewayModeName {
  const char* token;
  const char* firmware;
};
constexpr GatewayModeName kGatewayModes[] = {
    {"ecat", "ECAT"},
    {"enet", "UDP"},
    {"udp", "UDP"},
    {"usb3can", "USB3CAN"},
    {"usb8can", "USB8CAN"},
    {"sim", "SIM"},
    {"simsensors", "SIMSENSORS"},
};
/** @brief Resolve a CLI mode token to its firmware spelling. */
std::optional<std::string> FirmwareModeName(const std::string& token) {
  for (const auto& entry : kGatewayModes) {
    if (token == entry.token) return std::string(entry.firmware);
  }
  return std::nullopt;
}
uint32_t Get32(const unsigned char* p) {
  return uint32_t(p[0]) | uint32_t(p[1]) << 8 | uint32_t(p[2]) << 16 | uint32_t(p[3]) << 24;
}
void Put32(unsigned char* p, uint32_t value) {
  for (unsigned i = 0; i < 4; ++i) p[i] = static_cast<unsigned char>(value >> (8 * i));
}
Bytes Packet(unsigned type, uint32_t request, const SlaveConfigTarget& target) {
  Bytes data(64);
  std::memcpy(data.data(), "EMM1", 4);
  data[4] = 1;
  data[5] = static_cast<unsigned char>(type);
  data[6] = 64;
  Put32(data.data() + 8, request);
  std::copy(target.uuid.begin(), target.uuid.end(), data.begin() + 12);
  return data;
}
std::string CheckedReply(std::string reply) {
  while (!reply.empty() && (reply.back() == '\r' || reply.back() == '\n')) reply.pop_back();
  Require(reply.rfind("OK ", 0) == 0, "Slave configuration failed: " + reply);
  return reply;
}
class UdpConfig {
public:
  explicit UdpConfig(SlaveConfigTarget target) : target_(std::move(target)) {
    EnsureSocketsInitialized();
    fd_ = socket(AF_INET, SOCK_DGRAM, 0);
    Require(SocketValid(fd_), "Cannot open UDP management socket");
    try {
      Require(ResolveInterface(target_.endpoint, &index_, &local_),
              "Interface requires IPv4 configuration (host 192.168.100.254/24)");
      const int one = 1;
      Require(setsockopt(fd_, SOL_SOCKET, SO_BROADCAST, reinterpret_cast<const char*>(&one), sizeof one) == 0,
              "Cannot enable UDP broadcast");
#ifndef _WIN32
      Require(setsockopt(fd_, IPPROTO_IP, IP_PKTINFO, &one, sizeof one) == 0, "Cannot enable UDP broadcast");
#endif
      sockaddr_in local{};
      local.sin_family = AF_INET;
      Require(bind(fd_, reinterpret_cast<sockaddr*>(&local), sizeof local) == 0, "Cannot bind management socket");
      if (target_.slave) {
        destination_ = "192.168.100." + std::to_string(*target_.slave + 1);
        auto info = Exchange(Packet(1, NextId(), target_), 2, false);
        Require(info[31] == *target_.slave + 1 && info[28] == 192 && info[29] == 168 && info[30] == 100,
                "Discovered slave address mismatch");
        std::copy_n(info.begin() + 12, 16, target_.uuid.begin());
        Require(std::any_of(target_.uuid.begin(), target_.uuid.end(), [](auto b) { return b != 0; }),
                "Invalid gateway UUID");
      }
    } catch (...) {
      CloseSocket(fd_);
      fd_ = kInvalidSocket;
      throw;
    }
  }
  ~UdpConfig() {
    if (SocketValid(fd_)) CloseSocket(fd_);
  }
  UdpConfig(const UdpConfig&) = delete;
  UdpConfig& operator=(const UdpConfig&) = delete;
  std::string Command(const std::string& command) {
    Require(command.size() < 36, "UDP management command must be at most 35 bytes");
    auto request = Packet(12, NextId(), target_);
    std::copy(command.begin(), command.end(), request.begin() + 28);
    const auto response = Exchange(request, 13, true);
    const auto end = std::find(response.begin() + 28, response.end(), 0);
    Require(end != response.end(), "Unterminated management response");
    return CheckedReply(std::string(response.begin() + 28, end));
  }

  std::vector<SlaveScanRow> Scan() {
    std::vector<Bytes> packets;
    Exchange(Packet(1, NextId(), target_), 2, false, &packets);
    std::map<unsigned, std::string> devices;
    for (const auto& data : packets) {
      if (data[28] != 192 || data[29] != 168 || data[30] != 100 || data[31] < 1 || data[31] > 253 || data[32] != 255 ||
          data[33] != 255 || data[34] != 255 || data[35] != 0)
        continue;
      std::ostringstream uuid;
      for (unsigned i = 12; i < 28; i++) uuid << std::hex << std::setfill('0') << std::setw(2) << unsigned(data[i]);
      if (uuid.str() == std::string(32, '0')) continue;
      auto found = devices.find(data[31] - 1u);
      Require(found == devices.end() || found->second == uuid.str(), "Conflicting slave IDs in discovery");
      devices[data[31] - 1u] = uuid.str();
    }
    std::vector<SlaveScanRow> rows;
    for (const auto& entry : devices) rows.push_back({entry.first, entry.second});
    return rows;
  }

private:
  uint32_t NextId() { return ++request_id_; }
  Bytes Exchange(const Bytes& request, unsigned type, bool check_uuid, std::vector<Bytes>* collected = nullptr) {
    const auto deadline = Clock::now() + std::chrono::seconds(3);
    auto next_send = Clock::time_point::min();
    while (Clock::now() < deadline) {
      if (Clock::now() >= next_send) {
        sockaddr_in remote{};
        remote.sin_family = AF_INET;
        remote.sin_port = htons(5001);
        inet_pton(AF_INET, destination_.c_str(), &remote.sin_addr);
#if defined(_WIN32)
        const int sent = sendto(fd_, reinterpret_cast<const char*>(request.data()), static_cast<int>(request.size()), 0,
                                reinterpret_cast<sockaddr*>(&remote), sizeof remote);
        Require(sent == static_cast<int>(request.size()), "UDP management send failed");
#else
        iovec io{const_cast<unsigned char*>(request.data()), request.size()};
        alignas(cmsghdr) char control[CMSG_SPACE(sizeof(in_pktinfo))]{};
        msghdr message{};
        message.msg_name = &remote;
        message.msg_namelen = sizeof remote;
        message.msg_iov = &io;
        message.msg_iovlen = 1;
        message.msg_control = control;
        message.msg_controllen = sizeof control;
        auto* header = CMSG_FIRSTHDR(&message);
        header->cmsg_level = IPPROTO_IP;
        header->cmsg_type = IP_PKTINFO;
        header->cmsg_len = CMSG_LEN(sizeof(in_pktinfo));
        auto* info = reinterpret_cast<in_pktinfo*>(CMSG_DATA(header));
        info->ipi_ifindex = static_cast<int>(index_);
        info->ipi_spec_dst = local_;
        Require(sendmsg(fd_, &message, 0) == static_cast<ssize_t>(request.size()), "UDP management send failed");
#endif
        next_send = Clock::now() + std::chrono::milliseconds(300);
      }
      unsigned char data[512]{};
      sockaddr_in source{};
      const unsigned expected = type == 13 ? 256 : 64;
#if defined(_WIN32)
      fd_set read_fds;
      FD_ZERO(&read_fds);
      FD_SET(fd_, &read_fds);
      timeval timeout{0, 50000};
      if (select(0, &read_fds, nullptr, nullptr, &timeout) <= 0) continue;
      int source_length = sizeof source;
      const int size = recvfrom(fd_, reinterpret_cast<char*>(data), sizeof data, 0,
                                reinterpret_cast<sockaddr*>(&source), &source_length);
      if (size != static_cast<int>(expected) || source.sin_port != htons(5001) || std::memcmp(data, "EMM1", 4) ||
          data[4] != 1 || data[5] != type || (unsigned(data[6]) | unsigned(data[7]) << 8) != expected ||
          Get32(data + 8) != Get32(request.data() + 8))
        continue;
#else
      pollfd wait{fd_, POLLIN, 0};
      if (poll(&wait, 1, 50) <= 0) continue;
      alignas(cmsghdr) char control[CMSG_SPACE(sizeof(in_pktinfo))]{};
      iovec io{data, sizeof data};
      msghdr message{};
      message.msg_name = &source;
      message.msg_namelen = sizeof source;
      message.msg_iov = &io;
      message.msg_iovlen = 1;
      message.msg_control = control;
      message.msg_controllen = sizeof control;
      auto size = recvmsg(fd_, &message, 0);
      if (size != static_cast<ssize_t>(expected) || source.sin_port != htons(5001) || std::memcmp(data, "EMM1", 4) ||
          data[4] != 1 || data[5] != type || (unsigned(data[6]) | unsigned(data[7]) << 8) != expected ||
          Get32(data + 8) != Get32(request.data() + 8))
        continue;
      bool matching_interface = false;
      for (auto* h = CMSG_FIRSTHDR(&message); h; h = CMSG_NXTHDR(&message, h)) {
        if (h->cmsg_level == IPPROTO_IP && h->cmsg_type == IP_PKTINFO && h->cmsg_len >= CMSG_LEN(sizeof(in_pktinfo)))
          matching_interface = reinterpret_cast<in_pktinfo*>(CMSG_DATA(h))->ipi_ifindex == static_cast<int>(index_);
      }
      if (!matching_interface) continue;
#endif
      if (destination_ != "255.255.255.255") {
        in_addr wanted{};
        inet_pton(AF_INET, destination_.c_str(), &wanted);
        if (source.sin_addr.s_addr != wanted.s_addr) continue;
      }
      if (type == 2 && std::memcmp(data + 28, &source.sin_addr.s_addr, 4)) continue;
      if (check_uuid && !std::equal(target_.uuid.begin(), target_.uuid.end(), data + 12)) continue;
      if (collected) {
        collected->emplace_back(data, data + expected);
        continue;
      }
      return Bytes(data, data + expected);
    }
    if (collected) return {};
    throw std::runtime_error("No slave management response (new firmware required for text configuration)");
  }
  SlaveConfigTarget target_;
  SocketHandle fd_ = kInvalidSocket;
  unsigned index_ = 0;
  in_addr local_{};
  std::string destination_ = "255.255.255.255";
  uint32_t request_id_ = static_cast<uint32_t>(Clock::now().time_since_epoch().count());
};
}  // namespace
bool IsEthercatPlugin(const std::string& name) {
  std::string lower = name;
  std::transform(lower.begin(), lower.end(), lower.begin(),
                 [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  return lower.find("ethercat") != std::string::npos;
}
std::vector<SlaveScanRow> ScanEthernetSlaves(const std::string& interface_name) {
  SlaveConfigTarget target;
  target.endpoint = interface_name;
  return UdpConfig(target).Scan();
}
std::string FormatSlaveTable(std::vector<SlaveScanRow> rows) {
  std::sort(rows.begin(), rows.end(), [](const auto& a, const auto& b) { return a.index < b.index; });
  std::ostringstream out;
  out << std::left << std::setw(10) << "SlaveIdx" << " UUID\n";
  for (const auto& row : rows) out << std::left << std::setw(10) << row.index << " " << row.uuid << "\n";
  return out.str();
}
std::optional<SlaveConfigRequest> ParseSlaveConfig(const std::vector<std::string>& args) {
  if (args.size() < 2 || args[0] != "config") return std::nullopt;
  auto pos = std::find_if(args.begin() + 1, args.end(), [](const auto& s) { return s.rfind("--", 0) != 0; });
  if (pos == args.end()) return std::nullopt;
  std::vector<std::string> parts;
  size_t begin = 0;
  for (;;) {
    auto end = pos->find(':', begin);
    parts.push_back(pos->substr(begin, end - begin));
    if (end == std::string::npos) break;
    begin = end + 1;
  }
  const bool match = (parts[0] == "Ethernet" && (parts.size() == 2 || parts.size() == 3)) ||
                     (IsEthercatPlugin(parts[0]) && parts.size() == 2);
  if (!match) return std::nullopt;
  Require(pos == args.begin() + 1, "Motor options are not supported in slave configuration mode");
  SlaveConfigRequest result;
  result.target.endpoint = parts[1];
  result.target.serial = parts.size() == 2;
  if (result.target.serial)
    Require(IsSerialEndpoint(parts[1]), "CDC target requires a /dev/... or COMx serial device");
  else {
    Require(!parts[1].empty() && parts[1].size() < IFNAMSIZ, "Invalid network interface name");
    const auto& id = parts[2];
    if (id.size() <= 3)
      result.target.slave = Number(id);
    else {
      std::string hex;
      for (char c : id)
        if (c != '-') hex += c;
      Require(hex.size() == 32 && hex.find_first_not_of("0123456789abcdefABCDEF") == std::string::npos,
              "UUID must contain 32 hex digits");
      for (unsigned i = 0; i < 16; i++)
        result.target.uuid[i] = static_cast<unsigned char>(std::stoul(hex.substr(i * 2, 2), nullptr, 16));
      Require(std::any_of(result.target.uuid.begin(), result.target.uuid.end(), [](auto b) { return b != 0; }),
              "UUID must be nonzero");
    }
  }
  std::vector<std::string> values(pos + 1, args.end());
  Require(!values.empty(), SlaveConfigHelp());
  if (values[0] == "download") {
    Require(result.target.serial, "download requires a USB CDC target");
    Require(values.size() == 2 && !values[1].empty(), "download requires exactly one .bin or .elf path");
    result.download = values[1];
    return result;
  }
  if (values[0] == "raw") {
    Require(values.size() >= 2, "raw requires a CDC command");
    std::string command;
    for (size_t i = 1; i < values.size(); i++) {
      if (i > 1) command += ' ';
      command += values[i];
    }
    Require(command.find_first_of("\r\n") == std::string::npos && !command.empty() && command.size() < 36,
            "raw command must be one line, at most 35 bytes");
    result.commands = {command};
    return result;
  }
  if (values[0] == "version") {
    Require(values.size() == 1 || (values.size() == 2 && values[1] == "get"),
            "version is read-only; expected version [get]");
    result.commands = {"VERSION GET"};
    return result;
  }
  if (values[0] == "reboot") {
    Require(values.size() == 1, "reboot takes no values");
    result.commands = {"REBOOT"};
    return result;
  }
  Require(values[0] == "ip" || values[0] == "slave" || values[0] == "mode",
          "Unknown slave item; use ip, slave, mode, version, reboot, raw or download");
  if (values.size() == 1 || (values.size() == 2 && values[1] == "get")) {
    result.commands = {values[0] == "mode" ? "MODE GET" : "NET GET"};
    return result;
  }
  Require(values.size() == 3 && values[1] == "set", "Expected <ip|slave|mode> set <value>");
  if (values[0] == "mode") {
    const auto firmware_mode = FirmwareModeName(values[2]);
    Require(firmware_mode.has_value(), "Mode must be ecat, enet, udp, usb3can, usb8can, sim or simsensors");
    result.commands = {"MODE SET " + *firmware_mode, "CONFIG SAVE", "REBOOT"};
  } else if (values[0] == "slave") {
    const auto id = Number(values[2]);
    result.commands = {"NET SETIP 192.168.100." + std::to_string(id + 1), "CONFIG SAVE", "REBOOT"};
  } else {
    in_addr address{};
    Require(inet_pton(AF_INET, values[2].c_str(), &address) == 1, "Invalid IPv4 address");
    const auto ip = ntohl(address.s_addr);
    Require((ip & 0xffffff00U) == 0xc0a86400U && (ip & 255) > 0 && (ip & 255) < 254,
            "Slave IP must be 192.168.100.1..253");
    result.commands = {"NET SETIP " + values[2], "CONFIG SAVE", "REBOOT"};
  }
  return result;
}
std::optional<int> RunSlaveConfig(const std::vector<std::string>& args) {
  const auto request = ParseSlaveConfig(args);
  if (!request) return std::nullopt;
  if (request->download) return DownloadFirmware(request->target.endpoint, *request->download);
  if (request->target.serial) {
    serialib port;
    std::string device = request->target.endpoint;
#if defined(_WIN32)
    // CreateFile 对 COM 设备使用 \\.\COMx 形式最稳妥（COM10 以上必需）。
    if (device.size() > 3 && (device.rfind("COM", 0) == 0 || device.rfind("com", 0) == 0)) {
      device = "\\\\.\\" + device;
    }
#endif
    Require(port.openDevice(device.c_str(), 115200) == 1, "Cannot open CDC device: " + request->target.endpoint);
    port.flushReceiver();
    for (const auto& command : request->commands) {
      Require(port.writeString((command + "\n").c_str()) == 1, "CDC write failed");
      char reply[256]{};
      Require(port.readString(reply, '\n', sizeof reply - 1, 3000) > 0 && std::strchr(reply, '\n'),
              "No complete CDC response");
      std::cout << CheckedReply(reply) << '\n';
    }
  } else {
    UdpConfig transport(request->target);
    for (const auto& command : request->commands) std::cout << transport.Command(command) << '\n';
  }
  return 0;
}
}  // namespace motor_cli
