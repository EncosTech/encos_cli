#include "src/driver_version.h"

#include <dlfcn.h>

#include <array>
#include <cctype>
#include <cstdint>
#include <string_view>

namespace {

constexpr const char* kSupportedEncosDriverVersionRange = "3.3.0 <= libencosdriver < 3.4.0";
using EncosDriverVersionFunction = const char* (*)();

bool ParseVersionComponent(std::string_view text, std::uint32_t* value) {
  if (text.empty()) {
    return false;
  }

  std::uint64_t parsed = 0;
  for (const unsigned char character : text) {
    if (std::isdigit(character) == 0) {
      return false;
    }
    parsed = parsed * 10U + static_cast<std::uint64_t>(character - '0');
    if (parsed > UINT32_MAX) {
      return false;
    }
  }
  *value = static_cast<std::uint32_t>(parsed);
  return true;
}

bool ParseVersion(const std::string& text, std::array<std::uint32_t, 3>* version) {
  std::size_t component_start = 0;
  for (std::size_t index = 0; index < version->size(); ++index) {
    const std::size_t component_end = text.find('.', component_start);
    if (index < version->size() - 1 && component_end == std::string::npos) {
      return false;
    }
    const std::size_t length = (component_end == std::string::npos ? text.size() : component_end) - component_start;
    if (!ParseVersionComponent(std::string_view(text).substr(component_start, length), &(*version)[index])) {
      return false;
    }
    if (component_end == std::string::npos) {
      return index == version->size() - 1;
    }
    component_start = component_end + 1;
  }
  return false;
}

}  // namespace

std::optional<std::string> GetLoadedEncosDriverVersion() {
  void* handle = dlopen("libencosdriver.so.3", RTLD_LAZY | RTLD_NOLOAD);
  if (handle == nullptr) {
    return std::nullopt;
  }

  const auto get_version = reinterpret_cast<EncosDriverVersionFunction>(dlsym(handle, "encos_get_version"));
  if (get_version == nullptr) {
    dlclose(handle);
    return std::nullopt;
  }

  const char* version = get_version();
  const std::optional<std::string> result = version == nullptr ? std::nullopt : std::optional<std::string>(version);
  dlclose(handle);
  return result;
}

bool IsSupportedEncosDriverVersion(const std::optional<std::string>& version) {
  if (!version.has_value()) {
    return true;
  }

  std::array<std::uint32_t, 3> parsed_version{};
  if (!ParseVersion(*version, &parsed_version)) {
    return false;
  }

  constexpr std::array<std::uint32_t, 3> kMinimumVersion{3, 3, 0};
  constexpr std::array<std::uint32_t, 3> kMaximumVersion{3, 4, 0};
  return parsed_version >= kMinimumVersion && parsed_version < kMaximumVersion;
}

const char* GetSupportedEncosDriverVersionRequirement() { return kSupportedEncosDriverVersionRange; }
