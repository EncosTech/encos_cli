// SPDX-License-Identifier: MIT
//
// @encos/emcli-native 引擎 C ABI。
//
// 约定：
// - 本头文件可被 C11 / C++17 包含，不依赖 Node-API。
// - 所有导出函数均不抛出 C++ 异常；错误通过返回值 + emcli_perf_error 传递。
// - 结构体首字段固定为 size，只允许在尾部追加字段；破坏性变更必须提升 ABI 版本。
// - 字符串均为 UTF-8、NUL 结尾；除静态版本字符串外，有效期至少到下一次调用。
// - 会话句柄 0 无效；destroy 之后不得再使用。

#ifndef EMCLI_PERF_ABI_H
#define EMCLI_PERF_ABI_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define EMCLI_PERF_ABI_VERSION 1u
#define EMCLI_PERF_MAX_PERIODS 8u
#define EMCLI_PERF_MAX_MESSAGE 1024u
#define EMCLI_PERF_MAX_DETAIL 2048u
#define EMCLI_PERF_MAX_EVENT_MESSAGE 512u
#define EMCLI_PERF_NO_SLAVE INT32_MIN

#if defined(_WIN32)
#  if defined(EMCLI_PERF_BUILD)
#    define EMCLI_PERF_API __declspec(dllexport)
#  else
#    define EMCLI_PERF_API __declspec(dllimport)
#  endif
#else
#  define EMCLI_PERF_API __attribute__((visibility("default")))
#endif

#ifdef __cplusplus
#  define EMCLI_PERF_NOEXCEPT noexcept
#else
#  define EMCLI_PERF_NOEXCEPT
#endif

typedef uint64_t emcli_perf_session;

typedef enum emcli_perf_status {
    EMCLI_PERF_OK = 0,
    EMCLI_PERF_EINVAL = 1,
    EMCLI_PERF_ENOENT = 2,
    EMCLI_PERF_EBUSY = 3,
    EMCLI_PERF_EDRIVER = 4,
    EMCLI_PERF_EABI = 5,
    EMCLI_PERF_ESTATE = 6,
    EMCLI_PERF_ECONFLICT = 7,
    EMCLI_PERF_EINTERNAL = 8
} emcli_perf_status;

typedef struct emcli_perf_error {
    uint32_t size;
    int32_t status;       /* emcli_perf_status */
    int32_t os_errno;     /* errno / GetLastError；0 表示不适用 */
    uint32_t reserved0;
    char message[EMCLI_PERF_MAX_MESSAGE];
    char detail[EMCLI_PERF_MAX_DETAIL];
} emcli_perf_error;

/* ------------------------------------------------------------------------- */
/* 进程级生命周期                                                            */
/* ------------------------------------------------------------------------- */

EMCLI_PERF_API uint32_t emcli_perf_abi_version(void) EMCLI_PERF_NOEXCEPT;
EMCLI_PERF_API const char* emcli_perf_version(void) EMCLI_PERF_NOEXCEPT;
EMCLI_PERF_API const char* emcli_perf_build_info_json(void) EMCLI_PERF_NOEXCEPT;

/*
 * 返回引擎内部 encos_get_version() 的指针。
 * 加载器把它与 dlopen 得到的驱动库 encos_get_version() 返回值做指针比较，
 * 相等即证明两者绑定到同一份 libencosdriver 实例。
 */
EMCLI_PERF_API const char* emcli_perf_driver_version_ptr(void) EMCLI_PERF_NOEXCEPT;

/*
 * 初始化进程级运行时。config_json 可为 NULL 或 "{}"。
 * 支持字段（camelCase）：
 *   schema: number
 *   pluginPath: string          可选；仅当 setPluginPath=true 时应用
 *   setPluginPath: boolean      默认 false
 *   driverVersion: string       可选；用于诊断校验
 *   maxSessions: number         默认 8
 * 幂等：重复调用且配置一致时返回 OK。
 */
EMCLI_PERF_API int32_t emcli_perf_global_init(const char* config_json,
                                              emcli_perf_error* error) EMCLI_PERF_NOEXCEPT;

/* 停止并销毁所有会话；进程退出/环境清理时调用。可重复调用。 */
EMCLI_PERF_API void emcli_perf_global_shutdown(void) EMCLI_PERF_NOEXCEPT;

/* ------------------------------------------------------------------------- */
/* 通用遥测                                                                  */
/* ------------------------------------------------------------------------- */

typedef struct emcli_perf_motor_snapshot {
    uint32_t size;
    int32_t adapter_index;   /* 配置中的适配器序号 */
    int32_t slave_id;        /* EMCLI_PERF_NO_SLAVE 表示无从站 */
    int32_t bus_id;
    int32_t motor_id;
    uint32_t error_code;     /* encos::MotorError 数值 */
    uint32_t flags;          /* EMCLI_PERF_MOTOR_FLAG_* */
    uint64_t sent;
    uint64_t received;
    uint64_t lost;
    double position_rad;
    double speed_rad_s;
    double current_a;
    double torque_nm;
    double motor_temperature_c;
    double mos_temperature_c;
    double last_sample_us;
} emcli_perf_motor_snapshot;

#define EMCLI_PERF_MOTOR_FLAG_ONLINE 0x00000001u
#define EMCLI_PERF_MOTOR_FLAG_BUSY 0x00000002u
#define EMCLI_PERF_MOTOR_FLAG_LOGGING 0x00000004u
#define EMCLI_PERF_MOTOR_FLAG_HAS_STATUS 0x00000008u
#define EMCLI_PERF_MOTOR_FLAG_HOLDING 0x00000010u

typedef struct emcli_perf_event {
    uint32_t size;
    uint32_t level;          /* 0 debug, 1 info, 2 warn, 3 error */
    uint32_t code;
    uint32_t reserved0;
    uint64_t time_ns;        /* 会话启动以来的单调纳秒 */
    char message[EMCLI_PERF_MAX_EVENT_MESSAGE];
} emcli_perf_event;

#define EMCLI_PERF_EVENT_DEBUG 0u
#define EMCLI_PERF_EVENT_INFO 1u
#define EMCLI_PERF_EVENT_WARN 2u
#define EMCLI_PERF_EVENT_ERROR 3u

/* 读取会话事件环；返回 OK，out_count 为本次读取数量。容量不足时只读 capacity 条。 */
EMCLI_PERF_API int32_t emcli_perf_drain_events(emcli_perf_session session,
                                               emcli_perf_event* events,
                                               uint32_t capacity,
                                               uint32_t* out_count,
                                               emcli_perf_error* error) EMCLI_PERF_NOEXCEPT;

/* ------------------------------------------------------------------------- */
/* bench                                                                     */
/* ------------------------------------------------------------------------- */

typedef enum emcli_perf_bench_phase {
    EMCLI_PERF_BENCH_IDLE = 0,
    EMCLI_PERF_BENCH_RUNNING = 1,
    EMCLI_PERF_BENCH_STOPPING = 2,
    EMCLI_PERF_BENCH_FINISHED = 3,
    EMCLI_PERF_BENCH_ERROR = 4
} emcli_perf_bench_phase;

typedef enum emcli_perf_bench_period_state {
    EMCLI_PERF_BENCH_PERIOD_PENDING = 0,
    EMCLI_PERF_BENCH_PERIOD_WARMUP = 1,
    EMCLI_PERF_BENCH_PERIOD_SAMPLING = 2,
    EMCLI_PERF_BENCH_PERIOD_DONE = 3
} emcli_perf_bench_period_state;

typedef enum emcli_perf_bench_stop_reason {
    EMCLI_PERF_BENCH_STOP_OK = 0,
    EMCLI_PERF_BENCH_STOP_LOSS_LIMIT = 1,
    EMCLI_PERF_BENCH_STOP_INTERRUPTED = 2,
    EMCLI_PERF_BENCH_STOP_ERROR = 3
} emcli_perf_bench_stop_reason;

typedef struct emcli_perf_bench_period_result {
    uint32_t size;
    uint32_t period_ms;
    uint32_t state;          /* emcli_perf_bench_period_state */
    uint32_t stop_reason;    /* emcli_perf_bench_stop_reason */
    uint64_t attempts;
    uint64_t valid;
    uint64_t lost;
    double mean_us;
    double p1_us;
    double p5_us;
    double p50_us;
    double p95_us;
    double p99_us;
    double ops_per_second;
    double error_percent;
} emcli_perf_bench_period_result;

typedef struct emcli_perf_bench_update {
    uint32_t size;
    uint32_t phase;          /* emcli_perf_bench_phase */
    uint32_t current_period;
    uint32_t period_count;
    uint32_t motor_count;
    uint32_t reserved0;
    double elapsed_seconds;
    emcli_perf_bench_period_result periods[EMCLI_PERF_MAX_PERIODS];
} emcli_perf_bench_update;

/*
 * config_json 结构见 docs/node-rewrite/emcli-native-package-design.md §7.3。
 * 成功时 *out_session 非 0。
 */
EMCLI_PERF_API int32_t emcli_perf_bench_create(const char* config_json,
                                               emcli_perf_session* out_session,
                                               emcli_perf_error* error) EMCLI_PERF_NOEXCEPT;

EMCLI_PERF_API int32_t emcli_perf_bench_start(emcli_perf_session session,
                                              emcli_perf_error* error) EMCLI_PERF_NOEXCEPT;

/*
 * 读取快照。motors 可为 NULL（仅当 motor_capacity==0）。
 * out_motor_count 返回会话内电机总数；写入数量为 min(capacity, total)。
 */
EMCLI_PERF_API int32_t emcli_perf_bench_poll(emcli_perf_session session,
                                             emcli_perf_bench_update* update,
                                             emcli_perf_motor_snapshot* motors,
                                             uint32_t motor_capacity,
                                             uint32_t* out_motor_count,
                                             emcli_perf_error* error) EMCLI_PERF_NOEXCEPT;

/* 请求停止并等待线程退出；drain_ms 仅用于 bench/play 的收尾等待。可重复调用。 */
EMCLI_PERF_API int32_t emcli_perf_bench_stop(emcli_perf_session session,
                                             uint32_t drain_ms,
                                             emcli_perf_error* error) EMCLI_PERF_NOEXCEPT;

/* 释放会话；对无效句柄是 no-op。 */
EMCLI_PERF_API void emcli_perf_bench_destroy(emcli_perf_session session) EMCLI_PERF_NOEXCEPT;

/* ------------------------------------------------------------------------- */
/* stress                                                                    */
/* ------------------------------------------------------------------------- */

typedef enum emcli_perf_stress_phase {
    EMCLI_PERF_STRESS_IDLE = 0,
    EMCLI_PERF_STRESS_RUNNING = 1,
    EMCLI_PERF_STRESS_STOPPING = 2,
    EMCLI_PERF_STRESS_FINISHED = 3,
    EMCLI_PERF_STRESS_ERROR = 4
} emcli_perf_stress_phase;

typedef struct emcli_perf_stress_update {
    uint32_t size;
    uint32_t phase;          /* emcli_perf_stress_phase */
    uint32_t motor_count;
    uint32_t event_count;
    double elapsed_seconds;
    double configured_period_ms;
    double measured_period_p50_ms;
    uint64_t sent;
    uint64_t received;
    uint64_t lost;
    uint64_t loop_overruns;
    uint64_t dropped_events;
    uint64_t reserved0;
} emcli_perf_stress_update;

EMCLI_PERF_API int32_t emcli_perf_stress_create(const char* config_json,
                                                emcli_perf_session* out_session,
                                                emcli_perf_error* error) EMCLI_PERF_NOEXCEPT;

EMCLI_PERF_API int32_t emcli_perf_stress_start(emcli_perf_session session,
                                               emcli_perf_error* error) EMCLI_PERF_NOEXCEPT;

EMCLI_PERF_API int32_t emcli_perf_stress_poll(emcli_perf_session session,
                                              emcli_perf_stress_update* update,
                                              emcli_perf_motor_snapshot* motors,
                                              uint32_t motor_capacity,
                                              uint32_t* out_motor_count,
                                              emcli_perf_error* error) EMCLI_PERF_NOEXCEPT;

EMCLI_PERF_API int32_t emcli_perf_stress_stop(emcli_perf_session session,
                                              uint32_t drain_ms,
                                              emcli_perf_error* error) EMCLI_PERF_NOEXCEPT;

EMCLI_PERF_API void emcli_perf_stress_destroy(emcli_perf_session session) EMCLI_PERF_NOEXCEPT;

/* ------------------------------------------------------------------------- */
/* play                                                                      */
/* ------------------------------------------------------------------------- */

typedef enum emcli_perf_play_phase {
    EMCLI_PERF_PLAY_IDLE = 0,
    EMCLI_PERF_PLAY_STARTUP = 1,
    EMCLI_PERF_PLAY_RUNNING = 2,
    EMCLI_PERF_PLAY_PAUSED = 3,
    EMCLI_PERF_PLAY_RETURNING = 4,
    EMCLI_PERF_PLAY_FINISHED = 5,
    EMCLI_PERF_PLAY_ERROR = 6
} emcli_perf_play_phase;

typedef struct emcli_perf_trajectory_view {
    uint32_t size;
    uint32_t sample_count;
    uint32_t motor_count;
    uint32_t reserved0;
    const double* times_sec;       /* sample_count 个，严格递增 */
    const float* positions_deg;    /* sample_count * motor_count，行优先 */
} emcli_perf_trajectory_view;

typedef struct emcli_perf_play_update {
    uint32_t size;
    uint32_t phase;          /* emcli_perf_play_phase */
    uint32_t motor_count;
    uint32_t holding_motor_count;
    uint32_t current_sample;
    uint32_t flags;          /* EMCLI_PERF_PLAY_FLAG_* */
    double elapsed_seconds;
    double duration_seconds;
    double control_period_us;
    double last_overrun_us;
    double max_overrun_us;
    uint64_t sent;
    uint64_t received;
    uint64_t lost;
    uint64_t loop_overruns;
} emcli_perf_play_update;

#define EMCLI_PERF_PLAY_FLAG_LOGGING 0x00000001u
#define EMCLI_PERF_PLAY_FLAG_ENDLESS 0x00000002u
#define EMCLI_PERF_PLAY_FLAG_FINISHED 0x00000004u
#define EMCLI_PERF_PLAY_FLAG_RETURNED 0x00000008u
#define EMCLI_PERF_PLAY_FLAG_PAUSED 0x00000010u

/*
 * config_json 提供 play 段与适配器/电机地址；trajectory 提供二进制轨迹。
 * trajectory 数据在调用期间被同步复制，返回后调用方可以释放。
 */
EMCLI_PERF_API int32_t emcli_perf_play_create(const char* config_json,
                                              const emcli_perf_trajectory_view* trajectory,
                                              emcli_perf_session* out_session,
                                              emcli_perf_error* error) EMCLI_PERF_NOEXCEPT;

EMCLI_PERF_API int32_t emcli_perf_play_start(emcli_perf_session session,
                                             emcli_perf_error* error) EMCLI_PERF_NOEXCEPT;

EMCLI_PERF_API int32_t emcli_perf_play_poll(emcli_perf_session session,
                                            emcli_perf_play_update* update,
                                            emcli_perf_motor_snapshot* motors,
                                            uint32_t motor_capacity,
                                            uint32_t* out_motor_count,
                                            emcli_perf_error* error) EMCLI_PERF_NOEXCEPT;

/* paused != 0 暂停；0 恢复。暂停期间控制时钟不前进，但保持位置继续下发。 */
EMCLI_PERF_API int32_t emcli_perf_play_set_paused(emcli_perf_session session,
                                                  int32_t paused,
                                                  emcli_perf_error* error) EMCLI_PERF_NOEXCEPT;

/* 动态启用/停止驱动日志；日志目录在 create 时确定。 */
EMCLI_PERF_API int32_t emcli_perf_play_set_logging(emcli_perf_session session,
                                                   int32_t enabled,
                                                   emcli_perf_error* error) EMCLI_PERF_NOEXCEPT;

EMCLI_PERF_API int32_t emcli_perf_play_stop(emcli_perf_session session,
                                            uint32_t drain_ms,
                                            emcli_perf_error* error) EMCLI_PERF_NOEXCEPT;

EMCLI_PERF_API void emcli_perf_play_destroy(emcli_perf_session session) EMCLI_PERF_NOEXCEPT;

#ifdef __cplusplus
}  /* extern "C" */
#endif

#endif /* EMCLI_PERF_ABI_H */
