# emcli

`stress` 的驱动握手及错误日志输出到 stderr，统计保留在 stdout。Node 宿主默认设置 `ENCOS_MEMORY_LOCK=none`，保留线程优先级设置，避免进程级锁页与 V8 内存回收冲突；不改变独立 C++ 程序的默认锁页行为。
