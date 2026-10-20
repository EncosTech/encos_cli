#pragma once

#include <string>

namespace motor_cli {

// 全部面向用户的帮助文本集中在本文件，便于统一维护与按平台裁剪。
// 构建方式：A 族（bench/stress/play）由 argparse 依据各 ConfigureXCommand 生成，
// 其余命令为手写文本。

std::string BuildTopLevelHelp();
std::string BuildTuiHelp();
std::string BuildScanHelp();
std::string BuildConfigHelp();
std::string BuildConfigItemHelp(const std::string& item);
std::string BuildControlHelp();
std::string BuildControlModeHelp(const std::string& mode);
std::string BuildImuHelp();
std::string BuildBatteryHelp();
std::string BuildPmsHelp();
std::string BuildGloveHelp();

/// 从站配置（纯 udp/usb 配置）子模式的帮助；该模式不创建适配器。
std::string SlaveConfigHelp();

std::string BuildBenchHelp();
std::string BuildStressHelp();
std::string BuildPlayHelp();

/// 按命令名返回该命令的帮助
std::string BuildHelpForCommand(const std::string& command);

/// 按完整命令行返回"只与本次调用相关"的帮助：config 的从站子模式、config 项、control 模式
/// 各自只显示对应的帮助，不混入无关小节。
std::string BuildHelpForArgs(int argc, char** argv);

// 4 个 CAN 位时序选项的说明文本：argparse 生成的帮助（A 族）与手写帮助（B 族）共用同一来源。
const char* BitrateOptionHelp();
const char* DbitrateOptionHelp();
const char* SamplePointOptionHelp();
const char* DsamplePointOptionHelp();

/// 位时序选项的帮助文本块，供 B 族手写帮助追加。
std::string BuildAdapterTimingHelpBlock();

}  // namespace motor_cli
