#pragma once

#include <memory>
#include <optional>

namespace motor_cli::platform {

/** @brief 判断标准输入是否为交互终端 */
bool StdinIsInteractive();

/** @brief 判断标准输出是否为交互终端 */
bool StdoutIsInteractive();

/** @brief 标准输出可交互且终端支持原位刷新 */
bool SupportsInPlaceRefresh();

/** @brief 非阻塞检测是否按下 q/Q（仅交互终端） */
bool QuitKeyPressed();

/** @brief 终端字符尺寸 */
struct TerminalDimensions {
  int columns = 0;
  int rows = 0;
};

/** @brief 获取当前终端尺寸，不可用时返回空 */
std::optional<TerminalDimensions> GetTerminalDimensions();

/** @brief 将标准输入切换为原始模式，析构时恢复 */
class TerminalRawMode {
public:
  TerminalRawMode();
  ~TerminalRawMode();
  TerminalRawMode(const TerminalRawMode&) = delete;
  TerminalRawMode& operator=(const TerminalRawMode&) = delete;

private:
  class Impl;
  std::unique_ptr<Impl> impl_;
};

/** @brief 尽力锁定当前进程内存页；平台不支持时视为无操作成功 */
bool TryLockMemoryPages();

/** @brief 将当前线程绑定到指定 CPU，成功后返回 true */
bool SetCurrentThreadAffinity(int cpu_index);

/** @brief 返回可用 CPU 数量，未知时返回 1 */
int CpuCount();

}  // namespace motor_cli::platform
