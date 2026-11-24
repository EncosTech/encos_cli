// SPDX-FileCopyrightText: 2026 Encos
// SPDX-License-Identifier: MIT
//
// emcli 原生性能模块（原型）：scan / stress / bench。
// 直接链接 libencosdriver，由 CLI 在驱动运行时加载后 dlopen；
// NEEDED 只记录 SONAME，复用进程内已加载的驱动实例。

#include <node_api.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <memory>
#include <mutex>
#include <optional>
#include <random>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

#include "encos/encos_driver.h"
#include "adapter/fake_adapter_control.h"
#include "external/json.hpp"
#include "src/cli/slave_config.h"

namespace {

using json = nlohmann::json;
using Clock = std::chrono::steady_clock;

struct MotorAddress {
    std::string type;
    std::string iface;
    int slaveId = 0;
    bool hasSlave = false;
    int busId = 0;
    int motorId = 0;
};

struct ResolvedMotor {
    encos::BaseAdapter* adapter = nullptr;
    encos::Bus* bus = nullptr;
    encos::Motor* motor = nullptr;
    int slaveId = 0;
    bool hasSlave = false;
    int busId = 0;
    int motorId = 0;
};

constexpr unsigned kPhysicalCanIdBits = 29;

bool IsSubMotor(int motorId) {
    return (static_cast<uint32_t>(motorId) >> kPhysicalCanIdBits) != 0;
}

std::string GetString(napi_env env, napi_value value) {
    size_t length = 0;
    napi_get_value_string_utf8(env, value, nullptr, 0, &length);
    std::string text(length, '\0');
    napi_get_value_string_utf8(env, value, text.data(), length + 1, &length);
    return text;
}

void Throw(napi_env env, const std::string& message) {
    napi_throw_error(env, nullptr, message.c_str());
}

std::vector<MotorAddress> ParseMotors(const json& config) {
    std::vector<MotorAddress> motors;
    for (const auto& item : config.at("motors")) {
        MotorAddress motor;
        motor.type = item.at("type").get<std::string>();
        motor.iface = item.at("interfaceName").get<std::string>();
        if (item.contains("slaveId") && !item["slaveId"].is_null()) {
            motor.hasSlave = true;
            motor.slaveId = item["slaveId"].get<int>();
        }
        motor.busId = item.at("busId").get<int>();
        motor.motorId = item.at("motorId").get<int>();
        motors.push_back(std::move(motor));
    }
    return motors;
}

std::vector<ResolvedMotor> ResolveMotors(const std::vector<MotorAddress>& addresses, const json& timing = json::object()) {
    std::vector<ResolvedMotor> resolved;
    for (const auto& address : addresses) {
        auto* adapter = encos::MakeAdapter(address.type, address.iface, "", encos::LogLevel::Info, timing);
        if (adapter == nullptr) {
            throw std::runtime_error("failed to resolve adapter " + address.type + ":" + address.iface);
        }
        // Match the ordinary CLI's Fake initialization. Explicit performance
        // targets must exist before GetMotor reads their parameter ranges.
        if (address.type == "Fake") {
            if (auto* fake = adapter->GetFakeAdapterControl()) fake->EnableAutoCreateMotor();
        }
        auto* bus = address.hasSlave ? adapter->GetBus(address.slaveId, address.busId)
                                     : adapter->GetBus(address.busId);
        if (bus == nullptr) {
            throw std::runtime_error("failed to resolve bus");
        }
        // 对未登记的子电机调用 GetMotor 会在初始化时发送参数查询。
        auto* motor = IsSubMotor(address.motorId) ? bus->SelectMotor(address.motorId)
                                                  : bus->GetMotor(address.motorId);
        if (motor == nullptr) {
            throw std::runtime_error("failed to resolve motor " + std::to_string(address.motorId) +
                                     " on bus " + std::to_string(address.busId));
        }
        resolved.push_back({adapter, bus, motor, address.slaveId, address.hasSlave, address.busId,
                            address.motorId});
    }
    return resolved;
}

// ---------------------------------------------------------------------------
// scan
// ---------------------------------------------------------------------------

json Scan(const json& config) {
    const std::string type = config.at("type").get<std::string>();
    const std::string iface = config.at("interfaceName").get<std::string>();
    auto* adapter = encos::MakeAdapter(type, iface, "", encos::LogLevel::Info, config.value("timing", json::object()));
    if (adapter == nullptr) {
        throw std::runtime_error("failed to create adapter " + type + ":" + iface);
    }

    const bool hasBus = config.contains("busId") && !config["busId"].is_null();
    const bool hasSlave = config.contains("slaveId") && !config["slaveId"].is_null();
    std::vector<encos::Bus*> buses;
    if (hasBus) {
        const int busId = config["busId"].get<int>();
        auto* bus = hasSlave ? adapter->GetBus(config["slaveId"].get<int>(), busId)
                             : adapter->GetBus(busId);
        if (bus != nullptr) buses.push_back(bus);
    } else {
        auto all = adapter->GetBuses();
        for (auto& [raw, bus] : all) {
            if (bus != nullptr) buses.push_back(bus);
        }
    }

    struct Row {
        int slaveId;
        bool hasSlave;
        int busId;
        int motorId;
        bool eff;
        bool canfd;
    };
    const bool requestedSlave = hasSlave;
    const int requestedSlaveId = hasSlave ? config["slaveId"].get<int>() : 0;
    std::vector<Row> rows;
    std::mutex rowsMutex;
    std::vector<std::thread> threads;
    std::mutex errorMutex;
    std::string error;
    for (auto* bus : buses) {
        threads.emplace_back([&, bus] {
            try {
                const int raw = bus->GetBusIndex();
                const bool slave = requestedSlave || raw > 0xffff;
                const int slaveId = requestedSlave ? requestedSlaveId : (raw > 0xffff ? (raw >> 16) : 0);
                const int busId = raw > 0xffff ? (raw & 0xffff) : raw;
                const auto motors = bus->ScanMotors();
                std::lock_guard<std::mutex> lock(rowsMutex);
                for (const auto& [motorId, motor] : motors) {
                    if (motor == nullptr) continue;
                    rows.push_back({slaveId, slave, busId, motorId, motor->IsCanEffEnabled(),
                                    motor->IsCanFdEnabled()});
                }
            } catch (const std::exception& ex) {
                std::lock_guard<std::mutex> lock(errorMutex);
                if (error.empty()) error = ex.what();
            }
        });
    }
    for (auto& thread : threads) thread.join();
    if (!error.empty()) throw std::runtime_error(error);

    std::sort(rows.begin(), rows.end(), [](const Row& a, const Row& b) {
        if (a.hasSlave != b.hasSlave) return a.hasSlave < b.hasSlave;
        if (a.slaveId != b.slaveId) return a.slaveId < b.slaveId;
        if (a.busId != b.busId) return a.busId < b.busId;
        return a.motorId < b.motorId;
    });
    json result = json::array();
    for (const auto& row : rows) {
        result.push_back({{"slaveId", row.hasSlave ? json(row.slaveId) : json(nullptr)},
                          {"busId", row.busId},
                          {"motorId", row.motorId},
                          {"eff", row.eff},
                          {"canfd", row.canfd}});
    }
    return result;
}

// ---------------------------------------------------------------------------
// stress
// ---------------------------------------------------------------------------

// Commit enables synchronization in the driver. Keep it confined to test sessions.
struct SoftSyncScope {
    std::unordered_map<encos::BaseAdapter*, bool> adapters;
    explicit SoftSyncScope(const std::vector<ResolvedMotor>& motors) {
        for (const auto& motor : motors) adapters[motor.adapter] = true;
        try {
            for (auto& [adapter, _] : adapters) adapter->SetSyncMode(false);
            for (const auto& motor : motors) motor.bus->SetSyncMode(true);
        } catch (...) {
            Close();
            throw;
        }
    }
    void Close() noexcept {
        // Adapter-wide reset also covers buses enabled implicitly by Commit().
        for (auto& [adapter, _] : adapters) {
            try { adapter->SetSyncMode(false); } catch (...) {}
        }
        adapters.clear();
    }
    ~SoftSyncScope() { Close(); }
};

struct JoinSenders {
    std::atomic<bool>& stop;
    std::vector<std::thread>& threads;
    ~JoinSenders() {
        stop.store(true);
        for (auto& thread : threads) if (thread.joinable()) thread.join();
    }
};

struct StressMotor {
    ResolvedMotor resolved;
    std::shared_ptr<std::atomic<uint64_t>> sent = std::make_shared<std::atomic<uint64_t>>(0);
    std::shared_ptr<std::atomic<uint64_t>> received = std::make_shared<std::atomic<uint64_t>>(0);
};

struct StressGroup {
    std::vector<size_t> motors;
    const std::atomic<uint64_t>* feedback = nullptr;
    Clock::time_point retryAt{};
    uint64_t lastFeedback = 0;
};

std::vector<StressGroup> StressGroups(const std::vector<StressMotor>& motors,
                                      const std::vector<size_t>& indices) {
    constexpr uint32_t kPhysicalCanIdMask = (1U << kPhysicalCanIdBits) - 1U;
    std::unordered_map<encos::Bus*, std::unordered_map<uint32_t, size_t>> groupIndices;
    std::vector<StressGroup> groups(1);
    for (const size_t index : indices) {
        const auto& motor = motors[index];
        if (!IsSubMotor(motor.resolved.motorId)) {
            groups.front().motors.push_back(index);
            continue;
        }
        const auto canId = static_cast<uint32_t>(motor.resolved.motorId) & kPhysicalCanIdMask;
        const auto [group, inserted] = groupIndices[motor.resolved.bus].try_emplace(canId, groups.size());
        if (inserted) {
            // 同一网关回包含整组缓存。只跟踪一条反馈，避免同一回包释放多个周期。
            groups.emplace_back().feedback = motor.received.get();
        }
        groups[group->second].motors.push_back(index);
    }
    if (groups.front().motors.empty()) groups.erase(groups.begin());
    return groups;
}

struct StressSession {
    std::unique_ptr<SoftSyncScope> sync;
    bool stopped = false;
    ~StressSession() { Stop(0); }
    std::atomic<bool> stop{false};
    std::vector<std::thread> threads;
    std::vector<StressMotor> motors;
    std::vector<encos::BaseAdapter*> adapters;
    Clock::time_point started{};
    double periodMs = 0;
    std::mutex errorMutex;
    std::string error;

    void SetError(const std::string& message) {
        std::lock_guard<std::mutex> lock(errorMutex);
        if (error.empty()) error = message;
        stop.store(true);
    }

    uint64_t beforeSent = 0;
    uint64_t beforeReceived = 0;
    uint64_t afterSent = 0;
    uint64_t afterReceived = 0;
    double measurementMs = 0;
    int drainMs = 0;

    void Stop(int drain) {
        if (stopped) return;
        stopped = true;
        stop.store(true);
        for (auto& thread : threads) {
            if (thread.joinable()) thread.join();
        }
        for (const auto& motor : motors) {
            beforeSent += motor.sent->load(std::memory_order_relaxed);
            beforeReceived += motor.received->load(std::memory_order_relaxed);
        }
        measurementMs = std::chrono::duration<double, std::milli>(Clock::now() - started).count();
        drainMs = drain;
        if (drain > 0) {
            std::this_thread::sleep_for(std::chrono::milliseconds(drain));
        }
        for (const auto& motor : motors) {
            afterSent += motor.sent->load(std::memory_order_relaxed);
            afterReceived += motor.received->load(std::memory_order_relaxed);
        }
        for (auto& motor : motors) {
            try {
                motor.resolved.motor->SetOnStatus(nullptr);
            } catch (...) {
            }
        }
        threads.clear();
        sync.reset();
    }
};

std::mutex g_stressMutex;
std::unique_ptr<StressSession> g_stress;

void StartStress(const json& config) {
    std::lock_guard<std::mutex> lock(g_stressMutex);
    if (g_stress) {
        throw std::runtime_error("stress session already running");
    }
    auto session = std::make_unique<StressSession>();
    const double periodMs = config.at("periodMs").get<double>();
    if (!std::isfinite(periodMs) || periodMs <= 0 || periodMs > 1e9)
        throw std::runtime_error("invalid stress period");
    const auto period = std::chrono::duration_cast<Clock::duration>(std::chrono::duration<double, std::milli>(periodMs));
    if (period <= Clock::duration::zero()) throw std::runtime_error("stress period is below clock resolution");
    session->periodMs = periodMs;
    const auto resolved = ResolveMotors(ParseMotors(config), config.value("timing", json::object()));
    session->sync = std::make_unique<SoftSyncScope>(resolved);
    for (const auto& item : resolved) {
        StressMotor motor;
        motor.resolved = item;
        const auto received = motor.received;
        item.motor->SetOnStatus([received](const encos::MotorStatus&) {
            received->fetch_add(1, std::memory_order_relaxed);
        });
        session->motors.push_back(std::move(motor));
    }

    std::unordered_map<encos::BaseAdapter*, std::vector<size_t>> byAdapter;
    for (size_t index = 0; index < session->motors.size(); ++index) {
        byAdapter[session->motors[index].resolved.adapter].push_back(index);
    }
    session->started = Clock::now();
    for (auto& [adapter, indices] : byAdapter) {
        session->adapters.push_back(adapter);
        session->threads.emplace_back([sessionPtr = session.get(), adapter, period,
                                       groups = StressGroups(session->motors, indices)]() mutable {
            constexpr auto kGroupFeedbackTimeout = std::chrono::milliseconds(3);
            auto next = Clock::now();
            while (!sessionPtr->stop.load(std::memory_order_relaxed)) {
                try {
                    const auto now = Clock::now();
                    next += period * ((now - next) / period + 1);
                    bool queued = false;
                    for (auto& group : groups) {
                        if (group.feedback) {
                            const auto feedback = group.feedback->load(std::memory_order_relaxed);
                            if (now < group.retryAt && feedback == group.lastFeedback) continue;
                            group.lastFeedback = feedback;
                            group.retryAt = now + kGroupFeedbackTimeout;
                        }
                        for (const size_t index : group.motors) {
                            auto& motor = sessionPtr->motors[index];
                            motor.resolved.motor->PVTControl<0>(0.0f, 1.0f, 0.0f, 0.0f, 0.0f);
                            motor.sent->fetch_add(1, std::memory_order_relaxed);
                        }
                        queued = true;
                    }
                    if (queued) adapter->Commit();
                    std::this_thread::sleep_until(next);
                } catch (const std::exception& ex) {
                    sessionPtr->SetError(ex.what());
                    return;
                }
            }
        });
    }
    g_stress = std::move(session);
}

json StressSnapshot(bool final, int drainMs = 0) {
    std::lock_guard<std::mutex> lock(g_stressMutex);
    if (!g_stress) throw std::runtime_error("no stress session");
    if (final) {
        g_stress->Stop(drainMs);
    }
    uint64_t sent = 0;
    uint64_t received = 0;
    json motors = json::array();
    for (const auto& motor : g_stress->motors) {
        const auto s = motor.sent->load(std::memory_order_relaxed);
        const auto r = motor.received->load(std::memory_order_relaxed);
        sent += s;
        received += r;
        motors.push_back({{"slaveId", motor.resolved.hasSlave ? json(motor.resolved.slaveId)
                                                              : json(nullptr)},
                          {"busId", motor.resolved.busId},
                          {"motorId", motor.resolved.motorId},
                          {"sent", s},
                          {"received", r}});
    }
    const double elapsedMs =
        std::chrono::duration<double, std::milli>(Clock::now() - g_stress->started).count();
    std::string error;
    {
        std::lock_guard<std::mutex> errorLock(g_stress->errorMutex);
        error = g_stress->error;
    }
    json result{{"sent", sent},
                {"received", received},
                {"periodMs", g_stress->periodMs},
                {"elapsedMs", elapsedMs},
                {"measurementMs", final ? g_stress->measurementMs : elapsedMs},
                {"drainMs", final ? g_stress->drainMs : 0},
                {"drainAdditional",
                 final ? static_cast<int64_t>(g_stress->afterReceived - g_stress->beforeReceived) : 0},
                {"outstandingBefore",
                 final ? static_cast<int64_t>(g_stress->beforeSent - g_stress->beforeReceived) : 0},
                {"outstandingAfter",
                 final ? static_cast<int64_t>(g_stress->afterSent - g_stress->afterReceived) : 0},
                {"motors", motors},
                {"error", error},
                {"final", final}};
    if (final) g_stress.reset();
    return result;
}

// ---------------------------------------------------------------------------
// bench
// ---------------------------------------------------------------------------

// Parameter retries hide lost samples and inflate successful latency readings.
// Restore the process-wide setting after workers finish, including exceptions.
struct BenchRetryScope {
    unsigned int previous = encos::GetMotorRetryCount();
    BenchRetryScope() { encos::SetMotorRetryCount(0); }
    ~BenchRetryScope() { encos::SetMotorRetryCount(previous); }
};

json BenchRun(const json& config) {
    const int periodMs = config.at("periodMs").get<int>();
    const int attempts = config.at("attempts").get<int>();
    const int warmupMs = config.value("warmupMs", 200);
    const int sampleGapMs = config.value("sampleGapMs", 5);
    const int jitterUs = config.value("jitterUs", 1000);
    if (periodMs <= 0 || attempts <= 0 || warmupMs < 0 || sampleGapMs < 0 || jitterUs < 0) {
        throw std::runtime_error("invalid bench timing");
    }

    const auto resolved = ResolveMotors(ParseMotors(config), config.value("timing", json::object()));
    if (resolved.empty()) throw std::runtime_error("no motors to benchmark");
    struct Task {
        ResolvedMotor resolved;
        std::atomic<bool> busy{false};
    };
    std::vector<std::unique_ptr<Task>> tasks;
    std::vector<Task*> probes;
    std::unordered_map<encos::BaseAdapter*, std::vector<Task*>> byAdapter;
    for (const auto& item : resolved) {
        auto task = std::make_unique<Task>();
        task->resolved = item;
        byAdapter[item.adapter].push_back(task.get());
        if (!IsSubMotor(item.motorId)) probes.push_back(task.get());
        tasks.push_back(std::move(task));
    }
    std::optional<BenchRetryScope> retries;
    if (!probes.empty()) retries.emplace();
    SoftSyncScope sync(resolved);

    std::atomic<bool> stop{false};
    std::string error;
    std::mutex errorMutex;
    std::vector<std::thread> senders;
    JoinSenders joinSenders{stop, senders};
    for (auto& [adapter, group] : byAdapter) {
        senders.emplace_back([&, adapter, group] {
            auto next = Clock::now();
            const auto period = std::chrono::milliseconds(periodMs);
            while (!stop.load(std::memory_order_relaxed)) {
                try {
                    for (auto* task : group) {
                        bool expected = false;
                        if (!task->busy.compare_exchange_strong(expected, true)) continue;
                        try {
                            task->resolved.motor->PVTControl<0>(0.0f, 1.0f, 0.0f, 0.0f, 0.0f);
                        } catch (...) {
                            task->busy.store(false);
                            throw;
                        }
                        task->busy.store(false);
                    }
                    adapter->Commit();
                } catch (const std::exception& ex) {
                    std::lock_guard<std::mutex> lock(errorMutex);
                    if (error.empty()) error = ex.what();
                    stop.store(true);
                    return;
                }
                next += period;
                const auto now = Clock::now();
                if (next > now) std::this_thread::sleep_until(next);
                else next = now;
            }
        });
    }

    std::vector<double> samples;
    size_t lost = 0;
    size_t attempted = 0;
    std::thread sampler([&] {
        try {
            const int warmup = probes.empty() ? std::max(warmupMs, periodMs) : warmupMs;
            std::this_thread::sleep_for(std::chrono::milliseconds(warmup));
            std::mt19937 random(std::random_device{}());
            std::uniform_int_distribution<int> jitter(0, jitterUs);
            const auto waitSampleGap = [&] {
                std::this_thread::sleep_for(std::chrono::milliseconds(sampleGapMs) +
                                            std::chrono::microseconds(jitter(random)));
            };
            if (probes.empty()) {
                for (int i = 0; i < attempts && !stop.load(); ++i) waitSampleGap();
                return;
            }
            std::uniform_int_distribution<size_t> choose(0, probes.size() - 1);
            while (attempted < static_cast<size_t>(attempts) && !stop.load()) {
                auto& task = *probes[choose(random)];
                waitSampleGap();
                if (stop.load()) break;
                while (!stop.load()) {
                    bool expected = false;
                    if (task.busy.compare_exchange_strong(expected, true)) break;
                    std::this_thread::sleep_for(std::chrono::microseconds(50));
                }
                if (stop.load()) break;
                ++attempted;
                try {
                    const auto start = Clock::now();
                    (void)task.resolved.motor->GetParameter<encos::MotorParameter::Position>();
                    const auto elapsed =
                        std::chrono::duration<double, std::micro>(Clock::now() - start).count();
                    samples.push_back(std::max(0.001, elapsed));
                } catch (const std::exception&) {
                    ++lost;
                }
                task.busy.store(false);
            }
        } catch (const std::exception& ex) {
            std::lock_guard<std::mutex> lock(errorMutex);
            if (error.empty()) error = ex.what();
            stop.store(true);
        }
    });
    sampler.join();
    stop.store(true);
    for (auto& sender : senders) {
        if (sender.joinable()) sender.join();
    }
    json result{{"samples", samples}, {"lost", lost}, {"attempts", attempted},
                {"error", error}, {"probeMotorCount", probes.size()}};
    return result;
}


// ---------------------------------------------------------------------------
// play
// ---------------------------------------------------------------------------

struct PlayMotor {
    ResolvedMotor resolved;
    int trajectoryIndex = -1;
    bool holding = false;
    float initial = 0.0f;
    std::shared_ptr<std::atomic<uint64_t>> sent = std::make_shared<std::atomic<uint64_t>>(0);
    std::shared_ptr<std::atomic<uint64_t>> received = std::make_shared<std::atomic<uint64_t>>(0);
    std::shared_ptr<std::atomic<float>> current = std::make_shared<std::atomic<float>>(0.0f);
};

struct PlaySession {
    ~PlaySession() { Stop(); }
    std::atomic<bool> paused{false};
    std::atomic<bool> returnRequested{false};
    std::atomic<double> elapsedMs{0};
    std::atomic<bool> stop{false};
    std::atomic<int> phase{0};
    std::thread worker;
    std::vector<PlayMotor> motors;
    std::vector<encos::BaseAdapter*> adapters;
    std::vector<double> times;
    std::vector<float> positions;
    int motorCount = 0;
    double periodMs = 1;
    int startupMs = 2000;
    int returnMs = 2000;
    bool endless = false;
    bool returnToInitial = true;
    bool usePvt = true;
    float kp = 0.0f;
    float kd = 1.0f;
    float velocity = 0.0f;
    float torque = 0.0f;
    float maxSpeed = 20.0f;
    float maxCurrent = 10.0f;
    Clock::time_point started{};
    Clock::time_point phaseStart{};
    Clock::time_point playbackStart{};
    std::vector<float> returnStart;
    std::mutex errorMutex;
    std::string error;

    void SetError(const std::string& message) {
        std::lock_guard<std::mutex> lock(errorMutex);
        if (error.empty()) error = message;
        stop.store(true);
        phase.store(4);
    }

    void Stop() {
        stop.store(true);
        if (worker.joinable()) worker.join();
        for (auto& motor : motors) {
            try {
                motor.resolved.motor->SetOnStatus(nullptr);
            } catch (...) {
            }
        }
        motors.clear();
        adapters.clear();
    }
};

std::mutex g_playMutex;
std::unique_ptr<PlaySession> g_play;

std::vector<float> EvaluateTrajectory(const PlaySession& session, double elapsed, bool& finished) {
    const size_t count = session.motorCount;
    const size_t sampleCount = session.times.size();
    auto row = [&](size_t index) {
        std::vector<float> result(count);
        for (size_t motor = 0; motor < count; ++motor) {
            result[motor] = session.positions[index * count + motor];
        }
        return result;
    };
    auto interpolate = [&](size_t a, size_t b, double ratio) {
        std::vector<float> result(count);
        for (size_t motor = 0; motor < count; ++motor) {
            const float start = session.positions[a * count + motor];
            const float end = session.positions[b * count + motor];
            result[motor] = static_cast<float>(start + (end - start) * ratio);
        }
        return result;
    };

    if (sampleCount <= 1) {
        finished = !session.endless;
        return row(0);
    }
    const double first = session.times.front();
    const double duration = session.times.back() - first;
    if (duration <= 0) {
        finished = !session.endless;
        return row(sampleCount - 1);
    }
    if (!session.endless && elapsed >= duration) {
        finished = true;
        return row(sampleCount - 1);
    }

    auto forward = [&](double value) {
        for (size_t index = 0; index + 1 < sampleCount; ++index) {
            const double offset = session.times[index] - first;
            const double segment = session.times[index + 1] - session.times[index];
            if (value <= offset + segment) {
                return interpolate(index, index + 1, segment <= 0 ? 0 : (value - offset) / segment);
            }
        }
        return row(sampleCount - 1);
    };
    auto backward = [&](double value) {
        double remaining = value;
        for (size_t index = sampleCount - 1; index > 0; --index) {
            const double segment = session.times[index] - session.times[index - 1];
            if (remaining <= segment) {
                return interpolate(index, index - 1, segment <= 0 ? 0 : remaining / segment);
            }
            remaining -= segment;
        }
        return row(0);
    };

    if (!session.endless) {
        finished = false;
        return forward(std::max(0.0, elapsed));
    }
    const double cycle = duration * 2;
    double value = std::fmod(std::max(0.0, elapsed), cycle);
    if (value <= duration) return forward(value);
    finished = false;
    return backward(value - duration);
}

void StartPlay(const json& config) {
    std::lock_guard<std::mutex> lock(g_playMutex);
    if (g_play) throw std::runtime_error("play session already running");
    auto session = std::make_unique<PlaySession>();
    session->periodMs = config.value("periodMs", 1.0);
    if (!std::isfinite(session->periodMs) || session->periodMs <= 0) throw std::runtime_error("Invalid control period");
    session->startupMs = config.value("startupMs", 2000);
    session->returnMs = config.value("returnMs", 2000);
    session->endless = config.value("endless", false);
    session->returnToInitial = config.value("returnToInitial", true);
    session->usePvt = config.value("usePvt", true);
    session->kp = config.value("kp", 0.0f);
    session->kd = config.value("kd", 1.0f);
    session->velocity = config.value("velocity", 0.0f);
    session->torque = config.value("torque", 0.0f);
    session->maxSpeed = config.value("maxSpeed", 20.0f);
    session->maxCurrent = config.value("maxCurrent", 10.0f);
    session->times = config.at("times").get<std::vector<double>>();
    session->positions = config.at("positions").get<std::vector<float>>();
    for (auto& position : session->positions) position *= static_cast<float>(3.14159265358979323846 / 180.0);
    session->motorCount = config.at("motorCount").get<int>();
    if (session->motorCount <= 0 ||
        session->positions.size() != session->times.size() * static_cast<size_t>(session->motorCount)) {
        throw std::runtime_error("trajectory size mismatch");
    }

    for (const auto& item : config.at("motors")) {
        PlayMotor motor;
        MotorAddress address;
        address.type = item.at("type").get<std::string>();
        address.iface = item.at("interfaceName").get<std::string>();
        if (item.contains("slaveId") && !item["slaveId"].is_null()) {
            address.hasSlave = true;
            address.slaveId = item["slaveId"].get<int>();
        }
        address.busId = item.at("busId").get<int>();
        address.motorId = item.at("motorId").get<int>();
        motor.resolved = ResolveMotors({address}, config.value("timing", json::object())).front();
        motor.trajectoryIndex = item.value("trajectoryIndex", -1);
        motor.holding = item.value("holding", false);
        motor.initial = motor.resolved.motor->GetParameter<encos::MotorParameter::Position>();
        motor.current->store(motor.initial);
        const auto received = motor.received;
        motor.resolved.motor->SetOnStatus([received](const encos::MotorStatus&) {
            received->fetch_add(1, std::memory_order_relaxed);
        });
        session->motors.push_back(std::move(motor));
    }
    for (auto& motor : session->motors) {
        if (std::find(session->adapters.begin(), session->adapters.end(), motor.resolved.adapter) ==
            session->adapters.end()) {
            session->adapters.push_back(motor.resolved.adapter);
        }
    }

    session->started = Clock::now();
    session->phaseStart = session->started;
    session->phase.store(0);
    session->worker = std::thread([sessionPtr = session.get()] {
        const auto period = std::chrono::duration_cast<Clock::duration>(std::chrono::duration<double, std::milli>(sessionPtr->periodMs));
        auto next = Clock::now();
        auto lastTick = next;
        Clock::duration pausedDuration{};
        std::vector<float> returnStart;
        while (!sessionPtr->stop.load(std::memory_order_relaxed)) {
            try {
                const auto actualNow = Clock::now();
                if (sessionPtr->paused.load()) pausedDuration += actualNow - lastTick;
                lastTick = actualNow;
                const auto now = actualNow - pausedDuration;
                sessionPtr->elapsedMs.store(std::chrono::duration<double, std::milli>(now - sessionPtr->started).count());
                if (sessionPtr->returnRequested.exchange(false) && sessionPtr->phase.load() < 2) {
                    returnStart.resize(sessionPtr->motorCount);
                    for (auto& motor : sessionPtr->motors) {
                        if (motor.holding || motor.trajectoryIndex < 0) continue;
                        // Read the physical position, as the legacy player does on Stop.
                        returnStart[motor.trajectoryIndex] =
                            motor.resolved.motor->GetParameter<encos::MotorParameter::Position>();
                    }
                    sessionPtr->phaseStart = now;
                    sessionPtr->phase.store(2);
                }
                const int phase = sessionPtr->phase.load();
                std::vector<float> positions;
                bool finished = false;
                if (phase == 0) {
                    const double ratio = sessionPtr->startupMs <= 0
                                             ? 1.0
                                             : std::min(1.0,
                                                        std::chrono::duration<double, std::milli>(
                                                            now - sessionPtr->phaseStart)
                                                                .count() /
                                                            sessionPtr->startupMs);
                    positions.resize(sessionPtr->motorCount);
                    for (int index = 0; index < sessionPtr->motorCount; ++index) {
                        const float target = sessionPtr->positions[index];
                        positions[index] = static_cast<float>(
                            sessionPtr->motors[index].initial +
                            (target - sessionPtr->motors[index].initial) * ratio);
                    }
                    if (ratio >= 1.0) {
                        sessionPtr->phase.store(1);
                        sessionPtr->playbackStart = now;
                    }
                } else if (phase == 1) {
                    const double elapsed =
                        std::chrono::duration<double>(now - sessionPtr->playbackStart).count();
                    positions = EvaluateTrajectory(*sessionPtr, elapsed, finished);
                    if (finished && !sessionPtr->endless) {
                        if (sessionPtr->returnToInitial && sessionPtr->returnMs > 0) {
                            returnStart = positions;
                            sessionPtr->phase.store(2);
                            sessionPtr->phaseStart = now;
                        } else {
                            sessionPtr->phase.store(3);
                        }
                    }
                } else if (phase == 2) {
                    const double ratio =
                        sessionPtr->returnMs <= 0 ? 1.0 : std::min(1.0, std::chrono::duration<double, std::milli>(now - sessionPtr->phaseStart)
                                               .count() /
                                           sessionPtr->returnMs);
                    positions.resize(sessionPtr->motorCount);
                    for (int index = 0; index < sessionPtr->motorCount; ++index) {
                        const float start = index < static_cast<int>(returnStart.size())
                                                ? returnStart[index]
                                                : sessionPtr->motors[index].initial;
                        positions[index] =
                            static_cast<float>(start + (sessionPtr->motors[index].initial - start) * ratio);
                    }
                    if (ratio >= 1.0) sessionPtr->phase.store(3);
                } else {
                    break;
                }

                for (auto& motor : sessionPtr->motors) {
                    float target = motor.initial;
                    if (!motor.holding && motor.trajectoryIndex >= 0) {
                        target = positions[motor.trajectoryIndex];
                    }
                    if (motor.holding) {
                        motor.resolved.motor->PosControl<0>(motor.initial, sessionPtr->maxSpeed,
                                                           sessionPtr->maxCurrent, 1);
                    } else if (sessionPtr->usePvt) {
                        motor.resolved.motor->PVTControl<0>(
                            sessionPtr->kp, sessionPtr->kd, target, sessionPtr->velocity,
                            sessionPtr->torque);
                    } else {
                        motor.resolved.motor->PosControl<0>(target, sessionPtr->maxSpeed,
                                                           sessionPtr->maxCurrent, 1);
                    }
                    motor.sent->fetch_add(1, std::memory_order_relaxed);
                    motor.current->store(target);
                }

                next += period;
                const auto current = Clock::now();
                if (next > current) std::this_thread::sleep_until(next);
                else next = current;
            } catch (const std::exception& ex) {
                sessionPtr->SetError(ex.what());
                return;
            }
        }
    });
    g_play = std::move(session);
}

json PlaySnapshot(bool final) {
    std::lock_guard<std::mutex> lock(g_playMutex);
    if (!g_play) throw std::runtime_error("no play session");
    struct FinalCleanup {
        bool active;
        ~FinalCleanup() { if (active && g_play) { g_play->Stop(); g_play.reset(); } }
    } cleanup{final};
    int phase = g_play->phase.load();
    uint64_t sent = 0;
    uint64_t received = 0;
    json motors = json::array();
    for (auto& motor : g_play->motors) {
        const auto s = motor.sent->load(std::memory_order_relaxed);
        const auto r = motor.received->load(std::memory_order_relaxed);
        sent += s;
        received += r;
        const auto status = motor.resolved.motor->GetStatus(0);
        const auto finite = [](float value) -> json { return std::isfinite(value) ? json(value) : json(nullptr); };
        const auto kt = motor.resolved.motor->GetProperties().kt;
        motors.push_back({{"slaveId", motor.resolved.hasSlave ? json(motor.resolved.slaveId) : json(nullptr)},
                          {"busId", motor.resolved.busId},
                          {"motorId", motor.resolved.motorId},
                          {"sent", s},
                          {"received", r},
                          {"positionRad", motor.current->load()},
                          {"holding", motor.holding},
                          {"feedbackPosition", status ? finite(status->position) : json(nullptr)},
                          {"speed", status ? finite(status->speed) : json(nullptr)},
                          {"current", status ? finite(status->current) : json(nullptr)},
                          {"torque", status ? finite(status->current * kt) : json(nullptr)},
                          {"motorTemperature", status ? finite(status->motor_temperature) : json(nullptr)},
                          {"mosTemperature", status ? finite(status->mos_temperature) : json(nullptr)},
                          {"motorError", status ? json(static_cast<int>(status->error)) : json(nullptr)}});
    }
    const double elapsedMs =
        g_play->elapsedMs.load();
    std::string error;
    {
        std::lock_guard<std::mutex> errorLock(g_play->errorMutex);
        error = g_play->error;
    }
    json result{{"paused", g_play->paused.load()}, {"phase", phase},
                {"elapsedMs", elapsedMs},
                {"sent", sent},
                {"received", received},
                {"motors", motors},
                {"error", error},
                {"final", final}};
    return result;
}

// ---------------------------------------------------------------------------
// N-API
// ---------------------------------------------------------------------------

napi_value ScanBinding(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    try {
        const auto result = Scan(json::parse(GetString(env, argv[0])));
        napi_value out;
        const std::string text = result.dump();
        napi_create_string_utf8(env, text.c_str(), text.size(), &out);
        return out;
    } catch (const std::exception& ex) {
        Throw(env, ex.what());
        return nullptr;
    }
}

napi_value StressStartBinding(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    try {
        StartStress(json::parse(GetString(env, argv[0])));
        return nullptr;
    } catch (const std::exception& ex) {
        Throw(env, ex.what());
        return nullptr;
    }
}

napi_value StressPollBinding(napi_env env, napi_callback_info) {
    try {
        napi_value out;
        const std::string text = StressSnapshot(false).dump();
        napi_create_string_utf8(env, text.c_str(), text.size(), &out);
        return out;
    } catch (const std::exception& ex) {
        Throw(env, ex.what());
        return nullptr;
    }
}

napi_value StressStopBinding(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    int drainMs = 0;
    if (argc >= 1) {
        napi_get_value_int32(env, argv[0], &drainMs);
    }
    try {
        napi_value out;
        const std::string text = StressSnapshot(true, drainMs).dump();
        napi_create_string_utf8(env, text.c_str(), text.size(), &out);
        return out;
    } catch (const std::exception& ex) {
        Throw(env, ex.what());
        return nullptr;
    }
}

napi_value BenchBinding(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    try {
        napi_value out;
        const std::string text = BenchRun(json::parse(GetString(env, argv[0]))).dump();
        napi_create_string_utf8(env, text.c_str(), text.size(), &out);
        return out;
    } catch (const std::exception& ex) {
        Throw(env, ex.what());
        return nullptr;
    }
}



napi_value SlaveBinding(napi_env env, napi_callback_info info) {
    size_t argc=1; napi_value argv[1];
    napi_get_cb_info(env,info,&argc,argv,nullptr,nullptr);
    try {
        auto config=json::parse(GetString(env,argv[0]));
        auto args=config.at("args").get<std::vector<std::string>>();
        const auto request=motor_cli::ParseSlaveConfig(args);
        json result={{"handled",bool(request)}};
        if(request) {
            result["commands"]=request->commands;
            result["serial"]=request->target.serial;
            result["endpoint"]=request->target.endpoint;
            if(request->download)result["download"]=*request->download;
            if (config.value("execute", true)) {
                const auto timeout_ms = config.value("timeoutMs", 3000);

                if (timeout_ms < 1 || timeout_ms > 3000) {
                    throw std::invalid_argument("CDC timeout must be between 1 and 3000 ms");
                }

                std::vector<std::string> replies;
                result["code"] = *motor_cli::RunSlaveConfig(args, &replies, timeout_ms);
                result["replies"] = replies;
            }
        }
        napi_value out;const auto text=result.dump();
        napi_create_string_utf8(env,text.c_str(),text.size(),&out);return out;
    }catch(const std::exception& ex){Throw(env,ex.what());return nullptr;}
}
napi_value SlaveScanBinding(napi_env env, napi_callback_info info) {
    size_t argc=1; napi_value argv[1];
    napi_get_cb_info(env,info,&argc,argv,nullptr,nullptr);
    try {
        auto c=json::parse(GetString(env,argv[0]));
        const auto type=c.at("type").get<std::string>(),iface=c.at("interfaceName").get<std::string>();
        std::vector<motor_cli::SlaveScanRow> rows;
        if(type=="Ethernet") rows=motor_cli::ScanEthernetSlaves(iface);
        else if(motor_cli::IsEthercatPlugin(type)) {
            auto* adapter=encos::MakeAdapter(type,iface,"",encos::LogLevel::Info,c.value("timing",json::object()));
            if(!adapter)throw std::runtime_error("Cannot create slave scan adapter");
            std::map<unsigned,bool> indices;
            for(auto& pair:adapter->GetBuses())indices[static_cast<unsigned>(pair.first)>>16]=true;
            for(auto& pair:indices)rows.push_back({pair.first,{}});
        } else throw std::runtime_error("Slave scan requires Ethernet or an Ethercat plugin");
        json result=json::array();for(auto& row:rows)result.push_back({{"index",row.index},{"uuid",row.uuid}});
        napi_value out;const auto text=result.dump();
        napi_create_string_utf8(env,text.c_str(),text.size(),&out);return out;
    }catch(const std::exception& ex){Throw(env,ex.what());return nullptr;}
}
napi_value MotorLogBinding(napi_env env, napi_callback_info info) {
    size_t argc=1; napi_value argv[1];
    napi_get_cb_info(env,info,&argc,argv,nullptr,nullptr);
    std::vector<encos::Motor*> enabled;
    try {
        auto c=json::parse(GetString(env,argv[0]));
        auto motors=ResolveMotors(ParseMotors(c));
        const auto directory=c.value("directory",std::string{});
        if(!directory.empty())std::filesystem::create_directories(directory);
        for(size_t i=0;i<motors.size();++i) {
            auto* motor=motors[i].motor;
            if(directory.empty()){motor->DisableLog();continue;}
            auto name=c.at("motors")[i].at("interfaceName").get<std::string>();
            for(char& ch:name)if(!std::isalnum(static_cast<unsigned char>(ch))&&ch!='-'&&ch!='_')ch='_';
            auto base=(std::filesystem::path(directory)/(name+"_"+std::to_string(motors[i].slaveId)+"_"+std::to_string(motors[i].busId)+"_"+std::to_string(motors[i].motorId)+"_"+std::to_string(i))).string();
            enabled.push_back(motor);motor->EnableLog(base);
            if(!motor->IsLogged())throw std::runtime_error("Failed to enable motor log: "+base);
        }
        return nullptr;
    }catch(const std::exception& ex){
        for(auto* motor:enabled)try{motor->DisableLog();}catch(...){}
        Throw(env,ex.what());return nullptr;
    }
}
napi_value PlayStartBinding(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
    try {
        StartPlay(json::parse(GetString(env, argv[0])));
        return nullptr;
    } catch (const std::exception& ex) {
        Throw(env, ex.what());
        return nullptr;
    }
}

napi_value PlayRequestReturnBinding(napi_env env, napi_callback_info) {
    std::lock_guard<std::mutex> lock(g_playMutex);
    if (!g_play) { Throw(env,"no play session"); return nullptr; }
    g_play->paused.store(false);
    g_play->returnRequested.store(true);
    return nullptr;
}

napi_value PlayPauseBinding(napi_env env, napi_callback_info info) {
    size_t argc=1; napi_value argv[1]; bool paused=false;
    napi_get_cb_info(env,info,&argc,argv,nullptr,nullptr);
    napi_get_value_bool(env,argv[0],&paused);
    std::lock_guard<std::mutex> lock(g_playMutex);
    if (!g_play) { Throw(env,"no play session"); return nullptr; }
    g_play->paused.store(paused);
    return nullptr;
}

napi_value PlayPollBinding(napi_env env, napi_callback_info) {
    try {
        napi_value out;
        const std::string text = PlaySnapshot(false).dump();
        napi_create_string_utf8(env, text.c_str(), text.size(), &out);
        return out;
    } catch (const std::exception& ex) {
        Throw(env, ex.what());
        return nullptr;
    }
}

napi_value PlayStopBinding(napi_env env, napi_callback_info) {
    try {
        napi_value out;
        const std::string text = PlaySnapshot(true).dump();
        napi_create_string_utf8(env, text.c_str(), text.size(), &out);
        return out;
    } catch (const std::exception& ex) {
        Throw(env, ex.what());
        return nullptr;
    }
}

}  // namespace

NAPI_MODULE_INIT() {
    napi_value fn;
#define EXPORT(name, callback)                                              \
    napi_create_function(env, name, NAPI_AUTO_LENGTH, callback, nullptr, &fn); \
    napi_set_named_property(env, exports, name, fn)
    EXPORT("scan", ScanBinding);
    EXPORT("stressStart", StressStartBinding);
    EXPORT("stressPoll", StressPollBinding);
    EXPORT("stressStop", StressStopBinding);
    EXPORT("bench", BenchBinding);
    EXPORT("playStart", PlayStartBinding);
    EXPORT("motorLog", MotorLogBinding);
    EXPORT("slave", SlaveBinding);
    EXPORT("scanSlaves", SlaveScanBinding);
    EXPORT("playPoll", PlayPollBinding);
    EXPORT("playPause", PlayPauseBinding);
    EXPORT("playRequestReturn", PlayRequestReturnBinding);
    EXPORT("playStop", PlayStopBinding);
#undef EXPORT
    return exports;
}
