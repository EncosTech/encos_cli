// SPDX-License-Identifier: MIT

#pragma once

#include <encos/encos_motor.h>

#include <argparse/argparse.hpp>
#include <optional>
#include <string>
#include <vector>

struct PreparedAdapter {
  std::string type;
  std::string id;
  std::string label;
  encos::BaseAdapterPtr adapter;
};

/// 已解析的 CAN 位时序选项。
///
/// 未给出的字段保持为空并且**不进入**适配器 extend 信封：各适配器的插件默认值并不相同
/// （Can 的采样点默认 0.765/0.882，Ethernet 是 0.75/0.875），因此 CLI 侧不能用一个统一的
/// 默认值去覆盖它们。
struct AdapterTimingOptions {
  std::optional<int> bitrate;
  std::optional<int> dbitrate;
  std::optional<double> sample_point;
  std::optional<double> dsample_point;

  /// 是否一个字段都没有给出。
  bool Empty() const;

  /// 构造适配器 extend 信封，只包含被显式给出的字段。
  nlohmann::json ToExtend() const;

  /// 校验取值范围，非法时抛出带选项名的 std::runtime_error。
  void Validate() const;

  /// 用 other 中已给出、而本对象尚未给出的字段补齐。
  ///
  /// 供 tui 使用：前置写法由 argparse 收走，尾置写法被 remaining() 吞进位置参数，
  /// 两个来源各掌握一部分，互补后才是完整结果。
  void FillMissingFrom(const AdapterTimingOptions& other);
};

void AddAdapterArgument(argparse::ArgumentParser& parser);

/// 声明 4 个 CAN 位时序选项（--bitrate / --dbitrate / --sample-point / --dsample-point）。
///
/// 选项写入 extend 信封的顶层，因此对命令实际用到的所有适配器与总线生效。
void AddAdapterTimingArguments(argparse::ArgumentParser& parser);

/// 从 argparse 解析结果读取位时序选项（A 族命令使用）。
///
/// 只能作用于已调用过 `AddAdapterTimingArguments` 的 parser：argparse 在选项未声明时会抛
/// std::logic_error。
AdapterTimingOptions ReadAdapterTimingOptions(const argparse::ArgumentParser& parser);

/// 从参数列表中剥离位时序选项并就地删除它们（B 族命令使用）。
AdapterTimingOptions StripAdapterTimingFlags(std::vector<std::string>& arguments);

/// 用带 extend 的入口创建适配器；extend 为空信封时与旧行为完全一致。
///
/// 失败时把适配器标签补进错误信息：插件侧的报错只含字段名（例如 SLCAN 不支持某字段），
/// 一条命令开多个适配器时无法定位是哪一个。
encos::BaseAdapterPtr MakeAdapterWithExtend(const std::string& type, const std::string& id, const std::string& logger,
                                            encos::LogLevel log_level, const nlohmann::json& extend);

encos::BaseAdapterPtr MakeAdapterWithTiming(const std::string& type, const std::string& id, const std::string& logger,
                                            encos::LogLevel log_level, const AdapterTimingOptions& timing);

std::vector<PreparedAdapter> LoadAdaptersFromArgs(const argparse::ArgumentParser& parser,
                                                  encos::LogLevel log_level = encos::LogLevel::Warn);
