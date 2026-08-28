#pragma once

#include <argparse/argparse.hpp>
#include <chrono>
#include <cstddef>
#include <string>

std::chrono::steady_clock::time_point NextPlayControlTick(std::chrono::steady_clock::time_point previous_tick,
                                                          std::chrono::steady_clock::duration control_period,
                                                          std::chrono::steady_clock::time_point now);
bool IsPlayEndless(bool endless, bool stress);
bool ShouldReturnToInitialPosition(bool playback_finished, bool endless);
bool SupportsPlayStressInPlaceRefresh(bool stdout_is_tty, const std::string& terminal);
std::string BuildPlayStressMotorLogBaseName(const std::string& motor_name, std::size_t motor_index);

void ConfigurePlayCommand(argparse::ArgumentParser& parser);
int RunPlayCommand(const argparse::ArgumentParser& parser);
