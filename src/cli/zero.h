#pragma once

#include <argparse/argparse.hpp>

void ConfigureZeroCommand(argparse::ArgumentParser& parser);
int RunZeroCommand(const argparse::ArgumentParser& parser);
