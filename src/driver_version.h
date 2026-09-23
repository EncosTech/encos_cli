// SPDX-License-Identifier: MIT

#pragma once

#include <optional>
#include <string>

std::optional<std::string> GetLoadedEncosDriverVersion();
bool IsSupportedEncosDriverVersion(const std::optional<std::string>& version);
const char* GetSupportedEncosDriverVersionRequirement();
