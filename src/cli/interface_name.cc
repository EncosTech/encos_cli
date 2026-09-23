// SPDX-License-Identifier: MIT

#include "src/cli/interface_name.h"

#include <cctype>
#include <sstream>
#include <string>

namespace motor_cli {
namespace {

bool IsRelayWsAdapter(const std::string& adapter_type) { return adapter_type == "RelayWs"; }

// Decodes a percent-encoded triplet starting at index i.
// Returns the decoded character and advances i by 2 on success.
// On failure returns '\0' and leaves i unchanged.
char DecodePercentEncoded(const std::string& value, std::size_t& i) {
  if (i + 2 >= value.size()) {
    return '\0';
  }
  const char high = value[i + 1];
  const char low = value[i + 2];
  const auto hex_digit = [](char c) -> int {
    if (c >= '0' && c <= '9') {
      return c - '0';
    }
    if (c >= 'A' && c <= 'F') {
      return c - 'A' + 10;
    }
    if (c >= 'a' && c <= 'f') {
      return c - 'a' + 10;
    }
    return -1;
  };
  const int high_value = hex_digit(high);
  const int low_value = hex_digit(low);
  if (high_value < 0 || low_value < 0) {
    return '\0';
  }
  i += 2;
  return static_cast<char>((high_value << 4) | low_value);
}

std::string UrlDecode(const std::string& value) {
  std::string result;
  result.reserve(value.size());
  for (std::size_t i = 0; i < value.size(); ++i) {
    const char c = value[i];
    if (c == '%') {
      const char decoded = DecodePercentEncoded(value, i);
      if (decoded != '\0') {
        result.push_back(decoded);
      } else {
        result.push_back(c);
      }
    } else if (c == '+') {
      result.push_back(' ');
    } else {
      result.push_back(c);
    }
  }
  return result;
}

// Extracts the value of the first occurrence of the named query parameter.
// Returns an empty string if the parameter is not found or has an empty value.
std::string ExtractQueryParameter(const std::string& query, const std::string& name) {
  std::string prefix = name + "=";
  std::size_t pos = 0;
  while (pos < query.size()) {
    const std::size_t found = query.find(prefix, pos);
    if (found == std::string::npos) {
      break;
    }
    // Ensure the match starts at a parameter boundary.
    if (found > 0 && query[found - 1] != '&') {
      pos = found + 1;
      continue;
    }
    const std::size_t value_start = found + prefix.size();
    const std::size_t value_end = query.find('&', value_start);
    const std::string raw_value =
        value_end == std::string::npos ? query.substr(value_start) : query.substr(value_start, value_end - value_start);
    return UrlDecode(raw_value);
  }
  return {};
}

std::string ExtractAdapterName(const std::string& interface_name) {
  // Only process URL-style interface names.
  if (interface_name.compare(0, 7, "http://") != 0 && interface_name.compare(0, 8, "https://") != 0) {
    return {};
  }

  const std::size_t query_start = interface_name.find('?');
  if (query_start == std::string::npos) {
    return {};
  }

  // Strip fragment identifier if present.
  std::size_t fragment_start = interface_name.find('#', query_start);
  if (fragment_start == std::string::npos) {
    fragment_start = interface_name.size();
  }

  const std::string query = interface_name.substr(query_start + 1, fragment_start - query_start - 1);
  return ExtractQueryParameter(query, "AdapterName");
}

std::string GetAdaptedInterfaceName(const std::string& adapter_type, const std::string& interface_name) {
  if (!IsRelayWsAdapter(adapter_type)) {
    return interface_name;
  }
  const std::string adapter_name = ExtractAdapterName(interface_name);
  return adapter_name.empty() ? interface_name : adapter_name;
}

}  // namespace

std::string GetDisplayInterfaceName(const std::string& adapter_type, const std::string& interface_name) {
  return GetAdaptedInterfaceName(adapter_type, interface_name);
}

std::string GetLoggerName(const std::string& adapter_type, const std::string& interface_name) {
  return GetAdaptedInterfaceName(adapter_type, interface_name);
}

}  // namespace motor_cli
