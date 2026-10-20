// SPDX-License-Identifier: MIT

#include "src/cli/adapter_cli_utils.h"

#include <iostream>
#include <sstream>
#include <stdexcept>
#include <unordered_map>
#include <unordered_set>
#include <utility>

#include "src/cli/help_text.h"
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

int ParseTimingInt(const std::string& option, const std::string& value) {
  try {
    std::size_t consumed = 0;
    const int parsed = std::stoi(value, &consumed);
    if (consumed != value.size()) {
      throw std::invalid_argument("trailing characters");
    }
    return parsed;
  } catch (const std::exception&) {
    throw std::runtime_error("Invalid integer for " + option + ": '" + value + "'");
  }
}

double ParseTimingDouble(const std::string& option, const std::string& value) {
  try {
    std::size_t consumed = 0;
    const double parsed = std::stod(value, &consumed);
    if (consumed != value.size()) {
      throw std::invalid_argument("trailing characters");
    }
    return parsed;
  } catch (const std::exception&) {
    throw std::runtime_error("Invalid number for " + option + ": '" + value + "'");
  }
}

bool IsAdapterTimingOption(const std::string& argument) {
  return argument == "--bitrate" || argument == "--dbitrate" || argument == "--sample-point" ||
         argument == "--dsample-point";
}

void AssignTimingOption(const std::string& option, const std::string& value, AdapterTimingOptions* options) {
  if (option == "--bitrate") {
    if (options->bitrate) {
      throw std::runtime_error("Duplicate option: '--bitrate'");
    }
    options->bitrate = ParseTimingInt(option, value);
  } else if (option == "--dbitrate") {
    if (options->dbitrate) {
      throw std::runtime_error("Duplicate option: '--dbitrate'");
    }
    options->dbitrate = ParseTimingInt(option, value);
  } else if (option == "--sample-point") {
    if (options->sample_point) {
      throw std::runtime_error("Duplicate option: '--sample-point'");
    }
    options->sample_point = ParseTimingDouble(option, value);
  } else {
    if (options->dsample_point) {
      throw std::runtime_error("Duplicate option: '--dsample-point'");
    }
    options->dsample_point = ParseTimingDouble(option, value);
  }
}

}  // namespace

bool AdapterTimingOptions::Empty() const { return !bitrate && !dbitrate && !sample_point && !dsample_point; }

nlohmann::json AdapterTimingOptions::ToExtend() const {
  nlohmann::json extend = nlohmann::json::object();
  if (bitrate) {
    extend["bitrate"] = *bitrate;
  }
  if (dbitrate) {
    extend["dbitrate"] = *dbitrate;
  }
  if (sample_point) {
    extend["sample_point"] = *sample_point;
  }
  if (dsample_point) {
    extend["dsample_point"] = *dsample_point;
  }
  return extend;
}

void AdapterTimingOptions::Validate() const {
  const auto require_positive = [](const std::optional<int>& value, const char* option) {
    if (value && *value <= 0) {
      throw std::runtime_error(std::string(option) + " must be a positive bitrate in bit/s");
    }
  };
  const auto require_sample_point = [](const std::optional<double>& value, const char* option) {
    if (value && !(*value > 0.0 && *value <= 1.0)) {
      throw std::runtime_error(std::string(option) + " must be a sample point in (0, 1]");
    }
  };

  require_positive(bitrate, "--bitrate");
  require_positive(dbitrate, "--dbitrate");
  require_sample_point(sample_point, "--sample-point");
  require_sample_point(dsample_point, "--dsample-point");
}

void AdapterTimingOptions::FillMissingFrom(const AdapterTimingOptions& other) {
  if (!bitrate) {
    bitrate = other.bitrate;
  }
  if (!dbitrate) {
    dbitrate = other.dbitrate;
  }
  if (!sample_point) {
    sample_point = other.sample_point;
  }
  if (!dsample_point) {
    dsample_point = other.dsample_point;
  }
}

void AddAdapterArgument(argparse::ArgumentParser& parser) {
  parser.add_argument("link")
      .help("Adapter link in Type:Id form, repeatable, supports Id=ALL")
      .metavar("link")
      .nargs(argparse::nargs_pattern::at_least_one);
}

void AddAdapterTimingArguments(argparse::ArgumentParser& parser) {
  parser.add_argument("--bitrate").scan<'i', int>().help(motor_cli::BitrateOptionHelp()).metavar("BPS");
  parser.add_argument("--dbitrate").scan<'i', int>().help(motor_cli::DbitrateOptionHelp()).metavar("BPS");
  parser.add_argument("--sample-point").scan<'g', double>().help(motor_cli::SamplePointOptionHelp()).metavar("RATIO");
  parser.add_argument("--dsample-point").scan<'g', double>().help(motor_cli::DsamplePointOptionHelp()).metavar("RATIO");
}

AdapterTimingOptions ReadAdapterTimingOptions(const argparse::ArgumentParser& parser) {
  AdapterTimingOptions options;
  if (const auto value = parser.present<int>("--bitrate")) {
    options.bitrate = *value;
  }
  if (const auto value = parser.present<int>("--dbitrate")) {
    options.dbitrate = *value;
  }
  if (const auto value = parser.present<double>("--sample-point")) {
    options.sample_point = *value;
  }
  if (const auto value = parser.present<double>("--dsample-point")) {
    options.dsample_point = *value;
  }
  options.Validate();
  return options;
}

AdapterTimingOptions StripAdapterTimingFlags(std::vector<std::string>& arguments) {
  AdapterTimingOptions options;
  std::vector<std::string> remaining;
  remaining.reserve(arguments.size());

  for (std::size_t index = 0; index < arguments.size(); ++index) {
    // 同时接受 `--opt value` 与 `--opt=value`：A 族由 argparse 处理，两种都支持，
    // B 族若只认空格分隔会出现"同一选项在不同命令里语法不同"的割裂。
    std::string option = arguments[index];
    std::string inline_value;
    bool has_inline_value = false;
    const auto equals = option.find('=');
    if (equals != std::string::npos) {
      inline_value = option.substr(equals + 1);
      option = option.substr(0, equals);
      has_inline_value = true;
    }

    if (!IsAdapterTimingOption(option)) {
      // 原样保留，避免误伤含 '=' 的接口名（如 RelayWs 连接串里的查询参数）
      remaining.push_back(arguments[index]);
      continue;
    }

    std::string value;
    if (has_inline_value) {
      value = inline_value;
    } else {
      if (index + 1 >= arguments.size()) {
        throw std::runtime_error("Missing value for " + option);
      }
      value = arguments[++index];
    }
    AssignTimingOption(option, value, &options);
  }

  arguments = std::move(remaining);
  options.Validate();
  return options;
}

encos::BaseAdapterPtr MakeAdapterWithExtend(const std::string& type, const std::string& id, const std::string& logger,
                                            encos::LogLevel log_level, const nlohmann::json& extend) {
  try {
    return encos::MakeAdapter(type, id, logger, log_level, extend);
  } catch (const std::exception& error) {
    throw std::runtime_error("Failed to configure adapter '" + type + ":" + id + "': " + error.what());
  }
}

encos::BaseAdapterPtr MakeAdapterWithTiming(const std::string& type, const std::string& id, const std::string& logger,
                                            encos::LogLevel log_level, const AdapterTimingOptions& timing) {
  return MakeAdapterWithExtend(type, id, logger, log_level, timing.ToExtend());
}

std::vector<PreparedAdapter> LoadAdaptersFromArgs(const argparse::ArgumentParser& parser, encos::LogLevel log_level) {
  const auto specs = ResolveAdapterSpecs(parser.get<std::vector<std::string>>("link"));
  const auto timing = ReadAdapterTimingOptions(parser);
  std::vector<PreparedAdapter> adapters;
  adapters.reserve(specs.size());

  for (const auto& spec : specs) {
    auto adapter =
        MakeAdapterWithTiming(spec.type, spec.id, motor_cli::GetLoggerName(spec.type, spec.id), log_level, timing);
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
