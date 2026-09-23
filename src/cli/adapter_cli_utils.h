// SPDX-License-Identifier: MIT

#pragma once

#include <encos/encos_motor.h>

#include <argparse/argparse.hpp>
#include <string>
#include <vector>

struct PreparedAdapter {
  std::string type;
  std::string id;
  std::string label;
  encos::BaseAdapterPtr adapter;
};

void AddAdapterArgument(argparse::ArgumentParser& parser);

std::vector<PreparedAdapter> LoadAdaptersFromArgs(const argparse::ArgumentParser& parser,
                                                  encos::LogLevel log_level = encos::LogLevel::Warn);
