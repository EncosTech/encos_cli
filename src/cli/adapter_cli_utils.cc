#include "src/cli/adapter_cli_utils.h"

#include <iostream>
#include <stdexcept>
#include <unordered_map>
#include <unordered_set>
#include <utility>

#include "src/cli/interface_name.h"

namespace {

struct AdapterSpec {
  std::string type;
  std::string id;
};

std::pair<std::string, std::string> ParseAdapterArg(const std::string& value) {
  const auto separator = value.find(':');
  if (separator == std::string::npos || separator == 0 || separator + 1 >= value.size()) {
    throw std::runtime_error("Invalid link value: '" + value + "', expected Type:Id");
  }
  return {value.substr(0, separator), value.substr(separator + 1)};
}

std::vector<AdapterSpec> ResolveAdapterSpecs(const std::vector<std::string>& raw_specs) {
  const auto adapter_types = encos::GetAvailableAdapterTypes();
  std::unordered_set<std::string> available_types(adapter_types.begin(), adapter_types.end());
  std::unordered_map<std::string, std::unordered_set<std::string>> interfaces_by_type;
  std::unordered_set<std::string> dedup_keys;
  std::vector<AdapterSpec> resolved;

  for (const auto& raw_spec : raw_specs) {
    auto [type, id] = ParseAdapterArg(raw_spec);
    if (available_types.find(type) == available_types.end()) {
      throw std::runtime_error("Unknown adapter type in link: '" + type + "'");
    }

    auto interface_it = interfaces_by_type.find(type);
    if (interface_it == interfaces_by_type.end()) {
      const auto all_interfaces = encos::GetAvailableInterface(type);
      interface_it = interfaces_by_type
                         .emplace(type, std::unordered_set<std::string>(all_interfaces.begin(), all_interfaces.end()))
                         .first;
    }

    const auto& type_interfaces = interface_it->second;
    if (id == "ALL") {
      if (type_interfaces.empty()) {
        std::cerr << "Warning: no available interfaces for adapter type '" << type << "', skip '" << raw_spec << "'"
                  << std::endl;
        continue;
      }
      for (const auto& interface_name : type_interfaces) {
        const auto dedup_key = type + "\n" + interface_name;
        if (dedup_keys.insert(dedup_key).second) {
          resolved.push_back(AdapterSpec{type, interface_name});
        }
      }
      continue;
    }

    // Ethernet endpoints include a remote IPv4 address and cannot be enumerated locally.
    // MakeAdapter validates the explicit endpoint before opening the connection.
    if (type != "Ethernet" && type_interfaces.find(id) == type_interfaces.end()) {
      throw std::runtime_error("Unknown adapter id '" + id + "' for type '" + type + "'");
    }

    const auto dedup_key = type + "\n" + id;
    if (dedup_keys.insert(dedup_key).second) {
      resolved.push_back(AdapterSpec{type, id});
    }
  }

  return resolved;
}

}  // namespace

void AddAdapterArgument(argparse::ArgumentParser& parser) {
  parser.add_argument("link")
      .help("Adapter link in Type:Id form, repeatable, supports Id=ALL")
      .metavar("link")
      .nargs(argparse::nargs_pattern::at_least_one);
}

std::vector<PreparedAdapter> LoadAdaptersFromArgs(const argparse::ArgumentParser& parser, encos::LogLevel log_level) {
  const auto specs = ResolveAdapterSpecs(parser.get<std::vector<std::string>>("link"));
  std::vector<PreparedAdapter> adapters;
  adapters.reserve(specs.size());

  for (const auto& spec : specs) {
    auto adapter = encos::MakeAdapter(spec.type, spec.id, motor_cli::GetLoggerName(spec.type, spec.id), log_level);
    if (!adapter) {
      throw std::runtime_error("Failed to create adapter for link: '" + spec.type + ":" + spec.id + "'");
    }
    adapters.push_back(PreparedAdapter{
        spec.type,
        spec.id,
        spec.type + ":" + spec.id,
        std::move(adapter),
    });
  }

  return adapters;
}
