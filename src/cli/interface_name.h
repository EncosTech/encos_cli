// SPDX-License-Identifier: MIT

#pragma once

#include <string>

namespace motor_cli {

// Returns a human-readable display name for an interface.
// For RelayWs adapters whose interface name is a URL containing an
// AdapterName query parameter, the AdapterName value is returned.
// Otherwise the original interface_name is returned unchanged.
std::string GetDisplayInterfaceName(const std::string& adapter_type, const std::string& interface_name);

// Returns the logger name to use for an adapter.
// For RelayWs adapters whose interface name is a URL containing an
// AdapterName query parameter, the AdapterName value is returned.
// Otherwise the original interface_name is returned unchanged.
std::string GetLoggerName(const std::string& adapter_type, const std::string& interface_name);

}  // namespace motor_cli
