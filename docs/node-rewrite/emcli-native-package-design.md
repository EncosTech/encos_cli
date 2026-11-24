# `@encos/emcli-native` npm 包设计

> 状态：设计稿（v0.1，2026-10-28）
>
> 适用范围：Node.js 重写版 `emcli` 的性能敏感模块（`bench` / `stress` / `play`）。
>
> 关联仓库：`motor_cli`（本仓库，旧 C++ 实现）、`motor_driver`（`@encos/encos-driver-native` 与本地 `encos_driver` SDK）。
>
> 本地基线：`encos_driver 4.1.2`，Node.js `>= 22`，Linux glibc `>= 2.28`（x64 / arm64），Windows x64。

---

## 1. 目标与约束

### 1.1 目标

1. 把旧 C++ `emcli` 中 `bench`、`stress`、`play` 的**热路径**迁移到 C++，以 `.node` / 动态库形式提供给 Node.js 主程序。
2. 新模块独立发布为 npm 包，可被新版 `emcli`（以及后续其他工具）安装和加载。
3. 新模块**不重复加载**驱动：它必须与 `@encos/encos-driver-native` 使用**同一个进程中、同一份 `libencosdriver` 实例**，从而共享 `EncosDriverManager` 单例、`BaseAdapter` / `Bus` / `Motor` 对象。
4. 编译期只依赖本地 `encos_driver` SDK（头文件 + 导入库），且版本必须与目标 npm 驱动包一致。
5. 运行期由 TypeScript 自动定位 `@encos/encos-driver-native` 平台包，把驱动动态库绝对路径传给 `.node`，由 `.node` 完成动态链接；不依赖 `LD_LIBRARY_PATH`、`RPATH` 或构建机绝对路径。
6. 全链路兼容 Node.js 单可执行文件（SEA）：原生文件从内嵌资产释放到缓存目录后再加载，不能假设 `node_modules` 存在。
7. 行为与旧 C++ 实现保持可验证的等价性（采样算法、丢包统计、轨迹插值、启动/回零过渡、日志等）。

### 1.2 硬约束

| 编号 | 约束 | 影响 |
| --- | --- | --- |
| C1 | 两个 `.node`（驱动 + 性能模块）必须在**同一进程**中加载使用 | 禁止 `child_process` / 独立 helper 进程跑热路径 |
| C2 | 进程中只能存在**一份** `libencosdriver` | 禁止混用系统库与 npm 包；必须做加载冲突检测 |
| C3 | 不同 Node Worker 共享进程地址空间但拥有独立 `napi_env` | 禁止在 Worker 中加载/调用两个原生模块 |
| C4 | 单可执行文件运行时可能没有 `node_modules`、当前目录只读 | 必须支持从 SEA 资产释放并使用显式路径加载 |
| C5 | C++ 引擎与 `libencosdriver` 的 C++ ABI 必须一致 | 必须使用与驱动包相同的编译器族/标准库 ABI 构建 |
| C6 | 驱动对象由 TypeScript 侧创建和销毁 | 引擎只“借用”指针，绝不 `Delete*` / `Destroy*` |

### 1.3 非目标

- 不在本包内实现 CLI 参数解析、TUI 渲染、CSV 解析、设备扫描流程。
- 不重新实现驱动协议、CAN/EtherCAT 传输或插件系统。
- 不把 `@encos/encos-driver-native` 的全部 JS API 再包一层；本包只提供性能会话。
- 不支持 macOS（当前驱动 npm 包也没有 darwin 平台包）；后续驱动支持时再扩展。

---

## 2. 结论摘要

### 2.1 包结构

采用与驱动一致的“选择器包 + 平台包”模式：

| 包 | 作用 | 是否含二进制 |
| --- | --- | --- |
| `@encos/emcli-native` | 平台选择、路径解析、TS API、SEA 辅助 | 否 |
| `@encos/emcli-native-linux-x64-gnu` | Linux x64 glibc 二进制 | 是 |
| `@encos/emcli-native-linux-arm64-gnu` | Linux arm64 glibc 二进制 | 是 |
| `@encos/emcli-native-win32-x64` | Windows x64 二进制 | 是 |

### 2.2 两个原生产物

每个平台包内包含两个文件：

```text
native/
  emcli_loader.node          # N-API 薄壳，零 encos 依赖，只做动态加载 + JS/C 编组
  libemcli_perf.so           # C++ 引擎（Windows: emcli_perf.dll），C ABI，热路径
```

> 本文中的“两个 `.node`”指驱动侧 `encosdriver.node` 与本包 `emcli_loader.node`；引擎是普通共享库
> （`libemcli_perf.so` / `emcli_perf.dll`），不是第三个 `.node`。

为什么不是单个 `.node`：

- `.node` 若直接 `DT_NEEDED libencosdriver.so.4`，在 Node 加载它之前无法先执行 `dlopen`，会因找不到依赖而失败；
- 若给 `.node` 写死 `RPATH`，又回到“构建期绑定路径”，无法满足 SEA / 可重定位要求；
- 因此拆成“无 encos 依赖的加载器”+“依赖驱动、但不带 RPATH 的引擎”。加载器先 `dlopen` 驱动，再 `dlopen` 引擎，后者的 `DT_NEEDED` 由已加载的驱动实例满足。

### 2.3 动态链接链路（一句话）

```text
TS 解析驱动平台包
  → 得到 <driverPkg>/runtime/lib/libencosdriver.so.4
  → 传给 emcli_loader.node
  → dlopen(driver, RTLD_NOW | RTLD_GLOBAL)
  → 校验 encos_get_version() 与指针身份
  → dlopen(libemcli_perf.so, RTLD_NOW)
  → 引擎的 NEEDED(SONAME=libencosdriver.so.4) 复用同一实例
```

### 2.4 单例保障（一句话）

同一进程 + 同一 `realpath` + 加载前冲突扫描 + 加载后 `encos_get_version()` 指针同一性校验 + 禁止 Worker/子进程；任一条件不满足直接失败，不静默降级。

### 2.5 本次落地的设计产物

| 路径 | 作用 |
| --- | --- |
| `packages/emcli-native/package.json` | 选择器包清单（peer/optional 依赖、导出） |
| `packages/emcli-native/manifest.json` | 构建基线（驱动 4.1.2、ABI 1、NAPI 8） |
| `packages/emcli-native/native/include/emcli_perf_abi.h` | 引擎 C ABI 契约 |
| `packages/emcli-native/native/cmake/ResolveEncosDriver.cmake` | 构建期本地 SDK 精确版本解析 |
| `packages/emcli-native/src/resolve.ts` | 运行期驱动/平台包/库路径解析 |
| `packages/emcli-native/src/types.ts` | 公共 TypeScript 类型 |
| `packages/emcli-native/src/index.ts` | 加载与会话包装（M1 接原生实现） |
| `packages/emcli-native/scripts/resolve-driver.mjs` | 本地 SDK 解析 CLI（可独立运行） |
| `packages/emcli-native/scripts/select-platform.mjs` | 平台选择（与驱动规则一致） |
| `packages/emcli-native/test/platform.test.mjs` | 平台选择/本地解析冒烟测试 |

---

## 3. 术语

| 术语 | 含义 |
| --- | --- |
| 本地 SDK | 本机安装或源码构建的 `encos_driver` 开发包，提供头文件、CMake config、`libencosdriver.so` |
| 驱动 npm 包 | `@encos/encos-driver-native` 选择器包及其平台包 `@encos/encos-driver-native-<platform>` |
| 驱动库 | 平台包 `runtime/lib`（Windows 为 `native/`）下的 `libencosdriver.so.<major>` / `encosdriver.dll` |
| 引擎 | `libemcli_perf.so` / `emcli_perf.dll`，C++ 热路径 |
| 加载器 | `emcli_loader.node`，N-API 薄壳 |
| 会话 | 一次 `bench` / `stress` / `play` 运行实例 |
| 借用 | 引擎通过驱动管理器按地址取到裸指针，但不拥有、不销毁 |

---

## 4. 总体架构

```text
┌──────────────────────────────── emcli 进程（唯一） ────────────────────────────────┐
│                                                                                    │
│  TypeScript 冷路径                                                                  │
│  ┌──────────────────────────────────────────────────────────────────────────────┐  │
│  │ CLI 解析 / TUI / CSV 解析 / 设备扫描 / 生命周期 / 日志目录管理                  │  │
│  └───────────────┬──────────────────────────────────────────┬───────────────────┘  │
│                  │                                          │                      │
│  ┌───────────────▼────────────────┐       ┌─────────────────▼──────────────────┐   │
│  │ @encos/encos-driver-native     │       │ @encos/emcli-native                │   │
│  │   encosdriver.node             │       │   emcli_loader.node (N-API 薄壳)    │   │
│  │   （JS 对象/回调/生命周期）      │       │   （只做 open/poll/stop 编组）       │   │
│  └───────────────┬────────────────┘       └─────────────────┬──────────────────┘   │
│                  │ DT_NEEDED                                │ dlopen               │
│                  │                                          │                      │
│  ┌───────────────▼──────────────────────────────────────────▼──────────────────┐   │
│  │ libencosdriver.so.4（进程内唯一实例）                                         │   │
│  │   ├─ EncosDriverManager 单例                                                │   │
│  │   ├─ BaseAdapter / Bus / Motor 对象树                                       │   │
│  │   └─ encosPlugins/*.so                                                     │   │
│  └───────────────▲─────────────────────────────────────────────────────────────┘   │
│                  │ NEEDED(SONAME only, 无 RPATH)                                   │
│  ┌───────────────┴─────────────────────────────────────────────────────────────┐   │
│  │ libemcli_perf.so（C++ 引擎，C ABI）                                          │   │
│  │   bench 会话 / stress 会话 / play 会话 / 遥测 / 事件环                        │   │
│  │   引擎内部线程：sender / sampler / control / telemetry                       │   │
│  └─────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                    │
│  禁止：child_process 跑性能会话；Worker 中加载上述任一 .node                         │
└────────────────────────────────────────────────────────────────────────────────────┘
```

### 4.1 冷热路径划分

| 职责 | 归属 | 原因 |
| --- | --- | --- |
| CLI 参数、帮助、错误提示 | TS | 迭代快、无性能要求 |
| 平台/版本/路径解析 | TS | 需要 npm/SEA 语义 |
| 适配器创建、参数配置、扫描 | TS + 驱动 JS API | 已有成熟封装，避免引擎重复实现 |
| 采样点计算、批量下发、`Commit` | C++ 引擎 | 微秒级周期、避免 JS GC/事件循环抖动 |
| `GetParameter` 计时 | C++ 引擎 | 计时必须紧贴调用 |
| 轨迹插值与控制循环 | C++ 引擎 | 1 kHz 稳定性 |
| 状态展示、排序、TUI 刷新 | TS | 20 Hz，非热路径 |
| 停止/暂停/日志开关 | TS 发命令，引擎执行 | 控制面低频 |
| 会话结果统计 | C++ 引擎 | 与采样同线程，避免拷贝 |

### 4.2 加载顺序

推荐并在文档/代码中强制如下顺序：

1. `resolveNativePaths()` 一次性解析出驱动平台包根、驱动库、插件目录、加载器、引擎。
2. 用**同一个** `driverPackageRoot` 创建驱动运行时（`createEncosRuntime({ packageRoot })`，需要 4.1.2+ 支持，见 §11.5）。
3. 通过驱动 JS API 创建适配器、总线、扫描电机。
4. `loadEmcliNative({ driverPackageRoot })`，加载器 `open`。
5. 创建会话，TS 把“借用地址”交给引擎。

反向顺序（先加载性能模块再创建驱动）在“驱动库路径一致”时也能工作，但适配器必须由其中一方先创建；为避免“引擎误创建默认配置适配器”，不推荐。

---

## 5. npm 包设计

### 5.1 命名

推荐主包名：`@encos/emcli-native`。

理由：

- 与可执行文件名 `emcli` 一致；
- 作用域内已有 `encos-driver-native`，`emcli-native` 不会与驱动混淆；
- 平台包后缀可完全复用驱动的命名规则，降低解析器复杂度。

备选：`@encos/encos-emcli-native`、`@encos/motor-cli-native`。若最终产品更名，仅需改包名与 `manifest.json`，不影响 ABI。

### 5.2 依赖关系

```json
{
  "peerDependencies": {
    "@encos/encos-driver-native": ">=4.1.2 <4.2.0"
  },
  "optionalDependencies": {
    "@encos/emcli-native-linux-x64-gnu": "0.1.0",
    "@encos/emcli-native-linux-arm64-gnu": "0.1.0",
    "@encos/emcli-native-win32-x64": "0.1.0"
  }
}
```

关键点：

- **驱动必须是 `peerDependencies`，不能是普通 `dependencies`**。否则 npm/pnpm 可能安装第二份驱动平台包，导致两个不同路径的 `libencosdriver`，直接违反 C2。
- 平台包用 `optionalDependencies`，由 npm 根据 `os` / `cpu` / `libc` 自动选择；未匹配的平台不会安装。
- 版本锁步：`@encos/emcli-native` 的平台包版本必须与主包完全一致；平台包内 `manifest.json` 记录构建时的驱动版本。
- 应用（新版 emcli）应同时精确锁定 `@encos/emcli-native` 与 `@encos/encos-driver-native`，避免 peer 范围漂移。
- `peerDependencies` 的范围只用于表达“可安装的驱动代际”；运行期默认仍要求与 `builtAgainstDriver` 精确一致（见 §6.4）。因此应用必须锁定精确版本，否则安装可通过、加载会报 `EMCLI_DRIVER_VERSION_MISMATCH`。

### 5.3 平台矩阵

| npm 后缀 | `process.platform` | `process.arch` | libc | 驱动 SONAME / DLL |
| --- | --- | --- | --- | --- |
| `linux-x64-gnu` | `linux` | `x64` | glibc >= 2.28 | `libencosdriver.so.4` |
| `linux-arm64-gnu` | `linux` | `arm64` | glibc >= 2.28 | `libencosdriver.so.4` |
| `win32-x64` | `win32` | `x64` | — | `encosdriver.dll` |

不支持：

- musl / Alpine：驱动本身不支持，直接报错，不做 glibc 兼容层。
- `linux-ia32`、`darwin-*`：报 `EMCLI_PLATFORM_UNSUPPORTED`。

### 5.4 选择器包内容

```text
@encos/emcli-native/
  package.json
  manifest.json
  README.md
  API.md
  LICENSE
  dist/
    index.js          # ESM
    index.cjs         # CJS（供 SEA/CJS bundle）
    index.d.ts
    sea.js / sea.cjs  # SEA 资产释放辅助
    sea.d.ts
```

`package.json` 的 `exports` 同时提供 `import` 与 `require`，因为最终 SEA 入口建议打成 CJS：

```json
{
  "name": "@encos/emcli-native",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.cjs",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    },
    "./sea": {
      "types": "./dist/sea.d.ts",
      "import": "./dist/sea.js",
      "require": "./dist/sea.cjs"
    },
    "./manifest": "./manifest.json"
  },
  "files": ["dist", "manifest.json", "API.md", "README.md", "LICENSE"],
  "engines": { "node": ">=22" },
  "peerDependencies": { "@encos/encos-driver-native": ">=4.1.2 <4.2.0" },
  "optionalDependencies": {
    "@encos/emcli-native-linux-x64-gnu": "0.1.0",
    "@encos/emcli-native-linux-arm64-gnu": "0.1.0",
    "@encos/emcli-native-win32-x64": "0.1.0"
  },
  "publishConfig": { "registry": "https://git.in.encos.cn/api/packages/packages/npm/" },
  "license": "MIT"
}
```

`manifest.json`（选择器包，发布时生成）：

```json
{
  "schema": 1,
  "package": "@encos/emcli-native",
  "version": "0.1.0",
  "nativeAbi": 1,
  "napi": 8,
  "builtAgainstDriver": "4.1.2",
  "driverPeerRange": ">=4.1.2 <4.2.0",
  "platforms": {
    "linux-x64-gnu": "@encos/emcli-native-linux-x64-gnu",
    "linux-arm64-gnu": "@encos/emcli-native-linux-arm64-gnu",
    "win32-x64": "@encos/emcli-native-win32-x64"
  }
}
```

### 5.5 平台包内容

以 Linux x64 为例：

```text
@encos/emcli-native-linux-x64-gnu/
  package.json
  index.js
  index.d.ts
  native/
    emcli_loader.node
    libemcli_perf.so
    manifest.json
  LICENSE
```

`package.json`：

```json
{
  "name": "@encos/emcli-native-linux-x64-gnu",
  "version": "0.1.0",
  "type": "module",
  "os": ["linux"],
  "cpu": ["x64"],
  "libc": ["glibc"],
  "main": "./index.js",
  "types": "./index.d.ts",
  "files": ["index.js", "index.d.ts", "native", "LICENSE"],
  "engines": { "node": ">=22" },
  "license": "MIT"
}
```

`native/manifest.json`：

```json
{
  "schema": 1,
  "package": "@encos/emcli-native-linux-x64-gnu",
  "version": "0.1.0",
  "nativeAbi": 1,
  "napi": 8,
  "driverVersion": "4.1.2",
  "driverSoname": "libencosdriver.so.4",
  "compiler": "gcc 12.2 (Debian 10 sysroot, glibc 2.28)",
  "glibcBaseline": "2.28",
  "files": {
    "native/emcli_loader.node": { "sha256": "…", "mode": "0755" },
    "native/libemcli_perf.so": { "sha256": "…", "mode": "0755" }
  }
}
```

Windows 平台包额外注意：

- 引擎使用 MinGW-w64 时，静态链接 `libstdc++` / `libgcc` / `libwinpthread`（`-static-libgcc -static-libstdc++`），避免再分发运行时 DLL。
- 若无法完全静态，则把所需 DLL 放在 `native/`，加载器用 `AddDllDirectory(nativeDir)` 注册。
- 核心 DLL 名由驱动决定（当前构建为 `encosdriver.dll` / `encosdriver_base.dll`）；平台包布局以 CI 产出的实际内容为准，解析器同时搜索 `native/` 与 `runtime/lib/`。

### 5.6 为什么不把驱动库复制进本包

- 复制会造成两份 `libencosdriver`，违反 C2；
- 驱动平台包已经负责驱动库、插件、许可证与权限 helper；
- 本包只声明 peer 依赖，并通过解析器拿到其路径；
- SEA 打包时由**应用构建器**把驱动平台包内容与本包内容一起嵌入，而不是由本包再复制一份。

### 5.7 发布顺序

1. 先发布三个平台包（`npm pack` 产出带 `manifest.json` 的 tgz）。
2. 再发布选择器包（其 `optionalDependencies` 指向已发布的精确版本）。
3. 发布后跑一次“干净目录 + `npm install` + `node -e "require('@encos/emcli-native')"`”冒烟。
4. 若任一平台包缺失，选择器包仍可安装，但对应平台加载时抛 `EMCLI_PLATFORM_PACKAGE_MISSING`，并提示 `npm install --include=optional`。

---

## 6. 动态链接机制

### 6.1 构建期：只借用本地 SDK 的头文件与导入库

CMake 入口（设计）：

```bash
cmake -S native -B build/native -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DEMCLI_DRIVER_CMAKE_DIR=/usr/local/lib/cmake/encos_driver \
  -DEMCLI_EXPECTED_DRIVER_VERSION=4.1.2 \
  -DNODE_INCLUDE_DIR="$HOME/.nvm/versions/node/v24.22.1/include/node"
```

`native/cmake/ResolveEncosDriver.cmake` 的职责：

1. 读取 `manifest.json` 的 `builtAgainstDriver`（或 `EMCLI_EXPECTED_DRIVER_VERSION`）。
2. `find_package(encos_driver ${expected} EXACT CONFIG REQUIRED)`。
3. 校验：
   - `encos_driver_VERSION` 与 expected 完全一致；
   - `encos_driver_INCLUDE_DIRS` 下存在 `encos/encos_driver.h`；
   - 存在 `libencosdriver.so.<major>`（Linux）或导入库（Windows）。
4. 输出 `driver.json` 到构建目录，记录版本、前缀、SONAME、插件目录，供打包与诊断使用。

**不允许**在构建脚本中联网下载 SDK。解析器只在以下位置查找：

- `EMCLI_DRIVER_CMAKE_DIR`
- `EMCLI_DRIVER_PREFIX` / `ENCOS_DRIVER_ROOT`
- `CMAKE_PREFIX_PATH`
- 常见前缀 `/usr/local`、`/usr`、`/opt/encos`
- 仓库同级 `../motor_driver/build*`（开发用，必须版本匹配）

### 6.2 链接参数：只保留 SONAME，不写 RPATH

引擎目标（Linux）：

```cmake
add_library(emcli_perf SHARED ${ENGINE_SOURCES})
target_link_libraries(emcli_perf PRIVATE Encos::encos_driver)
set_target_properties(emcli_perf PROPERTIES
  PREFIX "lib"
  OUTPUT_NAME "emcli_perf"
  BUILD_WITH_INSTALL_RPATH FALSE
  SKIP_BUILD_RPATH TRUE
  INSTALL_RPATH ""
  CXX_VISIBILITY_PRESET hidden
  VISIBILITY_INLINES_HIDDEN YES)
target_link_options(emcli_perf PRIVATE -Wl,-z,now -Wl,--no-undefined)
```

结果：

```text
$ readelf -d libemcli_perf.so | grep -E 'NEEDED|RPATH|RUNPATH'
 (NEEDED) 共享库：[libencosdriver.so.4]
 (NEEDED) 共享库：[libencosdriver_base.so.4]
 (NEEDED) 共享库：[libstdc++.so.6]
 ...
# 没有 RPATH / RUNPATH
```

> 注意：由于 `Encos::encos_driver` 的 `INTERFACE_LINK_LIBRARIES` 传递了 `encos_driver_base`，引擎可能显式带 `libencosdriver_base.so.4` 的 `NEEDED`。这是可接受的：只要主库实例唯一，它依赖的 base 也会唯一（见 §6.6 的冲突扫描）。

Windows：

- 链接导入库 `encosdriver.lib` / `libencosdriver.dll.a`，PE 导入表记录 DLL 名；
- 不写 `/DELAYLOAD`；
- 加载器先 `LoadLibraryExW(driverDll, ..., LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS)`，再 `LoadLibraryExW(engineDll, ...)`；
- 引擎依赖的 MinGW 运行库尽量静态链接。

macOS（暂不支持，预留）：

- 引擎 `LC_LOAD_DYLIB` 使用 `@rpath/libencosdriver.<major>.dylib`；
- 由于 dyld 不能在运行时追加 rpath，需依赖“先加载驱动、按 install name 复用”；
- 待驱动提供 darwin 平台包后，用 CI 实测后再启用。

### 6.3 运行期：TS 解析路径

解析器的输入优先级：

1. 显式选项 `{ driverPackageRoot, driverLibPath, pluginPath, nativeRoot }`；
2. 环境变量 `ENCOS_DRIVER_NATIVE_ROOT` / `ENCOS_DRIVER_LIB`（仅开发/诊断）；
3. 从 `@encos/emcli-native` 自身位置解析 peer `@encos/encos-driver-native` 入口；
4. 以该入口为锚点，解析平台包 `@encos/encos-driver-native-<suffix>`；
5. SEA 模式：从释放目录 `<nativeRoot>/driver/` 直接读取。

第 4 步必须用 `createRequire(driverSelectorEntry)` 作为锚点，而不是从本包位置解析。原因：pnpm 严格布局下，驱动的平台包嵌套在驱动的虚拟 store 目录中，本包的同级 `node_modules` 看不到它；以驱动入口为锚点才能命中同一份平台包，避免解析到另一份副本。

伪代码：

```ts
const driverEntry = resolveDriverSelectorEntry()          // …/node_modules/@encos/encos-driver-native/dist/index.js
const driverRequire = createRequire(driverEntry)
const platformEntry = driverRequire.resolve(platformName) // …/dist/index-native.js
const driverRoot = packageRootOf(platformEntry)           // 向上找到 package.json
const driverVersion = readPackageJson(driverRoot).version
const libPath = join(driverRoot, 'runtime/lib', soname)   // Windows: native/encosdriver.dll
const pluginPath = join(driverRoot, 'runtime/lib/encosPlugins')
```

如果 `import.meta.resolve` / `require.resolve` 不可用（被打包进单文件），解析器回退到：

- 从 `process.cwd()`、`process.execPath` 所在目录、`nativeRoot` 向上逐级查找 `node_modules/@encos/...`；
- 读取 `package.json` 的 `exports['.'].import` / `main` 得到入口；
- 仍失败则提示用户显式传 `driverPackageRoot`。

### 6.4 加载器 `open` 的步骤

`emcli_loader.node` 暴露：

```ts
open(options: {
  driverLib: string
  engineLib: string
  expectedDriverVersion: string
  pluginPath?: string
  expectedAbi?: number
  verifyIntegrity?: boolean
}): {
  info: NativeInfo
  bench: BenchNativeApi
  stress: StressNativeApi
  play: PlayNativeApi
  dispose(): void
}
```

内部顺序（C++）：

1. 校验参数非空、路径存在、`engineLib` 与 `driverLib` 不是同一文件。
2. **冲突扫描**（Linux `dl_iterate_phdr` / Windows `EnumProcessModules`）：
   - 已加载对象中若存在 basename 匹配 `libencosdriver.so.*` / `libencosdriver_base.so.*`（Windows：`encosdriver*.dll`），其 `realpath` 必须位于期望的驱动目录（或正是 `driverLib`）；
   - 否则返回 `EMCLI_DRIVER_INSTANCE_CONFLICT`，并列出冲突路径。
3. `dlopen(driverLib, RTLD_NOW | RTLD_GLOBAL)`（Windows：`LoadLibraryExW` + 目录注册）。
4. `dlsym(driver, "encos_get_version")`，调用并读取版本字符串：
   - 与 `expectedDriverVersion` 比较；默认要求完全一致；
   - 不一致时返回 `EMCLI_DRIVER_VERSION_MISMATCH`（除非显式 `allowDriverVersionMismatch` 且 major 相同）。
5. `dlopen(engineLib, RTLD_NOW)`（Windows：`LoadLibraryExW`）。
6. `dlsym(engine, "emcli_perf_abi_version")`：
   - 与加载器内编译的 `EMCLI_PERF_ABI_VERSION` 比较；
   - 不一致返回 `EMCLI_ENGINE_ABI_MISMATCH`。
7. `dlsym(engine, "emcli_perf_driver_version_ptr")`，调用并**比较指针值**与第 4 步 `encos_get_version()` 返回的指针：
   - 相等：证明引擎实际链接到同一驱动实例；
   - 不相等：返回 `EMCLI_DRIVER_INSTANCE_CONFLICT`（引擎绑定到了另一份库）。
8. `emcli_perf_global_init({pluginPath, driverVersion, ...} JSON)`：
   - 引擎可选择调用 `encos::SetPluginPath`（仅当 `pluginPath` 显式提供且 `setPluginPath=true`）；
   - 默认不调用，避免覆盖驱动 JS 运行时已经设置的路径。
9. 缓存句柄与 API 表；重复 `open` 相同路径直接返回缓存，不同路径返回 `EMCLI_ALREADY_OPEN`。
10. 注册 `napi_add_env_cleanup_hook`：env 销毁时停止所有会话并 `emcli_perf_global_shutdown`。

### 6.5 为什么这条链路能复用同一实例（已验证）

2026-10-28 在本地 glibc（Ubuntu，Node 24）做了最小 C++/N-API 验证：

| 试验 | 结果 |
| --- | --- |
| `dlopen(libfoo.so.1, RTLD_GLOBAL)` 后 `dlopen(libbar.so.1)`（bar 的 `NEEDED` 为 foo，无 RPATH） | 成功，且 `dl_iterate_phdr` 只看到 1 份 foo |
| 先 `dlopen(foo, RTLD_LOCAL)` 再 `dlopen(foo, RTLD_GLOBAL)` | 返回同一 handle，局部实例被提升为全局 |
| 通过符号链接路径加载 foo，再加载 bar | 仍复用同一实例（按 inode 识别） |
| 在 N-API 加载器中先 `dlopen(foo)` 再 `dlopen(bar)`，调用 bar 中依赖 foo 的函数 | 返回正确结果（43） |
| `process.dlopen(new Module(path), path)` 加载 `.node` | 成功，可在 SEA/自定义加载路径中使用 |

这证明了设计核心假设成立。CI 仍需在目标基线（glibc 2.28 容器、Windows）重复同样试验，作为发布门禁。

### 6.6 冲突检测的边界

必须检测的冲突：

1. 进程里已有一份系统 `libencosdriver`（例如被其他插件 `LD_PRELOAD` 或应用自身加载），路径与 npm 包不同。
2. 应用通过 `@encos/encos-driver-native` 解析到平台包 A，而本包解析到平台包 B（pnpm 多副本）。
3. 引擎 `dlopen` 时，`NEEDED` 被系统 `/etc/ld.so.cache` 中的同名库满足，而不是我们传入的路径。
4. Windows 上同名 DLL 已被其他目录加载（Windows 按 basename 复用，可能“看起来成功”但路径不对）。

检测手段：

- Linux：`dl_iterate_phdr` 枚举所有已加载对象，取 `dlpi_name`，`realpath` 后与期望目录比较；加载后再枚举一次。
- Windows：`EnumProcessModules` + `GetModuleFileNameW`，按 basename 过滤 `encosdriver*.dll`，比较完整路径。
- macOS：`_dyld_image_count` / `_dyld_get_image_name`。
- 指针同一性：主库 `encos_get_version` 返回的静态字符串地址必须一致；这是最终的“同一实例”证明。

### 6.7 不采用的方案

| 方案 | 不采用原因 |
| --- | --- |
| 给 `.node` 写 `RPATH=$ORIGIN/../runtime/lib` | 构建期绑定布局；SEA 释放目录、npm 布局变化都会失效；无法满足“TS 传路径” |
| 设置 `LD_LIBRARY_PATH` / `PATH` | glibc 在进程启动时缓存搜索路径，运行期修改不可靠；且影响全进程 |
| 用 `process.dlopen` 直接加载引擎 | 无法在加载前 `dlopen` 驱动；引擎的 `NEEDED` 会先失败 |
| 把驱动库复制到本包 `native/` | 产生第二份驱动实例，直接违反 C2 |
| 独立 helper 进程跑 bench/stress/play | 违反 C1；两个进程会各自打开同一硬件接口，单例不共享 |
| Worker 线程加载 | 同一进程但独立 `napi_env`；回调/生命周期/线程归属复杂，且没有收益 |
| 在引擎里 `dlsym` 所有 C++ 符号并手工调用 | 模板/内联/虚函数太多，不现实；两层加载已足够 |
| 静态链接 `libencosdriver` | 驱动是插件化动态库，且会复制单例；不可行 |

### 6.8 失败码与处置

| 码 | 含义 | 用户处置 |
| --- | --- | --- |
| `EMCLI_DRIVER_PACKAGE_MISSING` | 平台包未安装 | `npm install --include=optional` / 检查私有 registry |
| `EMCLI_DRIVER_LIB_MISSING` | 平台包缺少驱动库 | 重装驱动包；核对平台包版本 |
| `EMCLI_DRIVER_VERSION_MISMATCH` | 驱动库版本与构建版本不一致 | 安装匹配版本；或开发时显式允许 |
| `EMCLI_DRIVER_INSTANCE_CONFLICT` | 进程中存在第二份驱动 | 移除 `LD_PRELOAD` / 统一依赖版本 / `npm dedupe` |
| `EMCLI_DRIVER_LOAD_FAILED` | `dlopen` 失败 | 检查 `ldd` 缺失依赖、权限、架构 |
| `EMCLI_ENGINE_ABI_MISMATCH` | 加载器与引擎 ABI 不一致 | 重装同版本包 |
| `EMCLI_WRONG_ENV` | 在非属主线程/Worker 调用 | 回到主线程 |
| `EMCLI_ALREADY_OPEN` | 不同路径重复 open | 进程内只初始化一次 |

---

## 7. C ABI 设计

完整头文件见 `packages/emcli-native/native/include/emcli_perf_abi.h`。本节说明约定。

### 7.1 基本原则

1. **引擎不包含 Node-API 头文件**，只导出纯 C ABI；N-API 编组全部在 `emcli_loader.node`。
2. 所有导出函数 `extern "C"`、`noexcept`，内部捕获全部 C++ 异常并转换为状态码。
3. 不跨 ABI 传递 C++ 类型（`std::string`、`std::vector`、`nlohmann::json`、异常、回调 `std::function`）。
4. 字符串统一 UTF-8、NUL 结尾；除版本等静态字符串外，生命周期至少到下一次调用。
5. 结构体首字段为 `uint32_t size`，用于向后兼容扩展；只允许在尾部追加字段。
6. 破坏性变更必须提升 `EMCLI_PERF_ABI_VERSION`，并同时提升 npm 主版本。
7. 句柄是不透明 `uint64_t`，0 无效；不复用已销毁句柄。
8. 控制面使用 JSON（低频），数据面使用 POD 结构 + 调用方缓冲区（高频）。

### 7.2 生命周期

```text
进程启动
  └─ emcli_perf_abi_version() / emcli_perf_version() / build_info
       └─ emcli_perf_global_init(config_json)
            ├─ bench_create → start → poll* → stop → destroy
            ├─ stress_create → start → poll* → stop → destroy
            └─ play_create → start → pause/resume/logging → poll* → stop → destroy
                 └─ emcli_perf_global_shutdown()
```

- `global_init` 幂等；重复调用返回 `EMCLI_PERF_OK`，但配置必须一致。
- `global_shutdown` 会先停止并销毁全部会话；用于 `napi_env` 清理钩子。
- 会话创建后处于 `created`；`start` 后 `running`；`stop` 后 `finished`；`destroy` 后句柄失效。
- `stop` 可重复调用；`destroy` 对无效句柄是 no-op（便于清理路径）。

### 7.3 会话配置 JSON

所有配置带 `"schema": 1`。未知字段报 `EMCLI_PERF_EINVAL`（避免拼写错误静默生效），但保留 `extensions` 对象供实验。

通用部分采用**扁平电机列表**，列表顺序就是遥测数组顺序，避免“按适配器分组”后重排导致轨迹列错位：

```json
{
  "schema": 1,
  "driverVersion": "4.1.2",
  "pluginPath": "/path/to/runtime/lib/encosPlugins",
  "motors": [
    {
      "adapterType": "Can",
      "interfaceName": "can0",
      "slaveId": null,
      "busId": 0,
      "motorId": 1,
      "canfd": false,
      "role": "trajectory",
      "trajectoryIndex": 0
    }
  ]
}
```

- `slaveId`：`null` 表示无从站；EtherCAT 使用整数。引擎按 `(adapterType, interfaceName, slaveId, busId)` 归并出适配器/总线，但**不重排**电机。
- `role`：`trajectory` / `holding`；`trajectoryIndex` 为轨迹列号。bench/stress 可省略 `role`。
- 引擎只借用对象：适配器用 `encos::MakeAdapter(type, interfaceName, "", LogLevel::Off)` 取缓存实例；总线用 `EncosDriverManager::Instance().GetBuses(adapter)` 快照匹配——`slaveId != null` 时期望 `GetBusIndex() == (slaveId << 16) | busId`，否则期望 `GetBusIndex() == busId`（与旧 `DecodeStressBusAddress` 编码一致），不调用会创建对象的 `GetBus(slave,bus)`；电机用 `Bus::SelectMotor(id)`（不创建）。
- 若匹配不到，返回 `EMCLI_PERF_ENOENT`，并指出 `type/interface/slave/bus/motor`。

`bench` 段：

```json
{
  "bench": {
    "periodsMs": [10, 5, 3, 2, 1],
    "attempts": 500,
    "sampleGapMs": 5,
    "sampleJitterUs": 1000,
    "warmupMs": 200,
    "drainMs": 200,
    "minPacketThreshold": 50,
    "maxDropCountBeforeThreshold": 5,
    "maxDropRateAfterThreshold": 0.1,
    "realtime": true,
    "cpuAffinity": true,
    "mlock": true,
    "seed": 0
  }
}
```

- `periodsMs` 长度 1..8，每个 > 0；默认 `[10,5,3,2,1]`。
- `seed=0` 表示随机种子；非 0 用于可复现测试。
- `realtime` / `cpuAffinity` / `mlock` 失败只记事件，不终止（与旧实现一致）。

`stress` 段：

```json
{
  "stress": {
    "loopPeriodMs": 1,
    "warmupDelayMs": 100,
    "drainDelayMs": 200,
    "realtime": true,
    "cpuAffinity": true,
    "mlock": true
  }
}
```

`play` 段：

```json
{
  "play": {
    "controlPeriodUs": 1000,
    "mode": "pvt",
    "kp": 0.0,
    "kd": 1.0,
    "velocity": 0.0,
    "torque": 0.0,
    "maxSpeedRadS": 1.0,
    "maxCurrentA": 1.0,
    "endless": false,
    "returnToInitial": true,
    "startupTransitionMs": 2000,
    "returnTransitionMs": 2000,
    "log": { "enabled": false, "directory": "./logs" },
    "trajectoryMotorCount": 3,
    "holdingMotorCount": 1
  }
}
```

- `mode`：`pvt` 或 `pos`，对应旧实现的 `PVTControl<0>` / `PosControl<0>`。
- `holdingMotors` 指“同总线但不参与轨迹”的电机，作为 `motors` 数组中 `role="holding"` 的尾部条目；`positionRad=null` 表示启动时读取当前位置并保持。
- 轨迹数据不放在 JSON 中，单独通过 `emcli_perf_trajectory_view` 传入，避免大数组字符串化。

### 7.4 轨迹二进制视图

```c
typedef struct emcli_perf_trajectory_view {
  uint32_t size;
  uint32_t sample_count;
  uint32_t motor_count;
  uint32_t reserved;
  const double* times_sec;        /* sample_count */
  const float* positions_deg;     /* sample_count * motor_count, row-major */
} emcli_perf_trajectory_view;
```

校验（引擎侧，全部失败返回 `EINVAL` 并指出索引）：

- `size == sizeof` 或至少覆盖已知字段；
- `sample_count >= 1`、`motor_count == 配置中 role="trajectory" 的电机数`；
- `times_sec` 有限且严格递增；
- `positions_deg` 全部有限（拒绝 NaN/Inf）；
- `times_sec[0] == 0`（允许容差）或做整体平移；
- 若 `sample_count == 1`，持续时间按 0 处理（保持该点）。

引擎在 `play_create` 内**同步复制**数据到自有 `std::vector`；返回后 JS 的 TypedArray 可以释放/GC。

### 7.5 遥测结构

`emcli_perf_motor_snapshot`：

```c
typedef struct emcli_perf_motor_snapshot {
  uint32_t size;
  int32_t  adapter_index;
  int32_t  slave_id;        /* INT32_MIN 表示无 */
  int32_t  bus_id;
  int32_t  motor_id;
  uint32_t error_code;      /* encos::MotorError */
  uint32_t flags;           /* bit0 online, bit1 busy, bit2 logging, bit3 has_status */
  uint64_t sent;
  uint64_t received;
  uint64_t lost;
  double   position_rad;
  double   speed_rad_s;
  double   current_a;
  double   torque_nm;
  double   motor_temperature_c;
  double   mos_temperature_c;
  double   last_sample_us;
} emcli_perf_motor_snapshot;
```

- 计数器保持 `uint64_t`；加载器转成 JS `number`（2^53 内安全；1 kHz 连续运行 285 年才溢出，文档注明）。
- 位置/速度等用 `double`，避免 `float` 在 JS 侧看起来“精度突变”；驱动内部本来就是 `float`。

`bench` 更新：

```c
typedef struct emcli_perf_bench_period_result {
  uint32_t size;
  uint32_t period_ms;
  uint32_t state;          /* 0 pending, 1 warmup, 2 sampling, 3 done */
  uint32_t stop_reason;    /* 0 ok, 1 loss-limit, 2 interrupted, 3 error */
  uint32_t reserved;
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
  uint32_t phase;          /* 0 idle, 1 running, 2 stopping, 3 finished, 4 error */
  uint32_t current_period;
  uint32_t period_count;
  uint32_t motor_count;
  uint32_t reserved;
  double elapsed_seconds;
  emcli_perf_bench_period_result periods[EMCLI_PERF_MAX_PERIODS];
} emcli_perf_bench_update;
```

`stress` / `play` 类似，分别暴露总收发、丢包、循环超时次数、播放阶段、当前段、日志状态等。具体字段见头文件。

### 7.6 事件环

用于传递非致命诊断（实时优先级失败、CPU 亲和失败、丢帧超限、驱动警告）：

```c
typedef struct emcli_perf_event {
  uint32_t size;
  uint32_t level;      /* 0 debug, 1 info, 2 warn, 3 error */
  uint32_t code;       /* 稳定的事件码 */
  uint32_t reserved0;
  uint64_t time_ns;
  char message[512];
} emcli_perf_event;

int32_t emcli_perf_drain_events(emcli_perf_session s,
                                emcli_perf_event* events,
                                uint32_t capacity,
                                uint32_t* out_count);
```

- 引擎内部固定容量环形队列，满时丢弃最旧并置 `dropped` 计数。
- 事件只由引擎线程写入，JS 线程读取；使用无锁 SPSC 或短临界区，不在热循环中加锁。
- 加载器把事件转成 JS 对象数组；TS 决定是否打印/去重。

### 7.7 ABI 版本演进规则

| 变更 | 版本动作 |
| --- | --- |
| 尾部追加字段 | 不改 `ABI_VERSION`，提升包次版本 |
| 新增函数 | 不改 `ABI_VERSION`，加载器按 `dlsym` 可选 |
| 修改字段含义/顺序、删除函数 | 提升 `ABI_VERSION` 与主版本 |
| 驱动大版本升级 | 重新构建引擎，提升本包主版本 |

加载器启动时打印 `engine abi / package abi / driver version / build info`，便于现场诊断。

---

## 8. TypeScript API

### 8.1 入口

```ts
import {
  loadEmcliNative,
  resolveNativePaths,
  EmcliNativeError,
  type MotorAddress,
  type BenchOptions,
  type StressOptions,
  type PlayOptions,
} from '@encos/emcli-native'
```

### 8.2 路径解析

```ts
export interface NativePaths {
  packageRoot: string          // @encos/emcli-native
  loaderPath: string
  enginePath: string
  manifest: PlatformManifest
  driver: {
    packageRoot: string
    version: string
    libPath: string
    pluginPath: string
    addonPath: string
  }
}

export function resolveNativePaths(options?: {
  nativeRoot?: string
  driverPackageRoot?: string
  driverLibPath?: string
  pluginPath?: string
  platform?: NodeJS.Platform
  arch?: string
}): NativePaths
```

- 纯函数，不加载原生模块；便于 CLI 在打印诊断时先解析。
- SEA 模式下 `nativeRoot` 指向释放目录，内部布局固定（见 §11）。

### 8.3 加载

```ts
export interface EmcliNativeInfo {
  packageVersion: string
  engineVersion: string
  abi: number
  driverVersion: string
  driverLibPath: string
  loaderPath: string
  enginePath: string
  platform: string
  arch: string
  build: Record<string, string>
}

export interface EmcliNative {
  readonly info: EmcliNativeInfo
  readonly bench: BenchApi
  readonly stress: StressApi
  readonly play: PlayApi
  dispose(): void
  [Symbol.dispose](): void
}

export function loadEmcliNative(options?: LoadOptions): EmcliNative
```

- 同步加载：路径解析、`process.dlopen`、`open` 都是短操作（<50 ms）。SEA 资产释放是异步的，由 `@encos/emcli-native/sea` 在启动时先 `await`。
- 模块级缓存：同一进程重复调用返回同一实例。
- `dispose()`：停止所有会话、调用引擎 `global_shutdown`，但不 `dlclose`（避免 Node/驱动回调悬空）。进程退出前调用即可。

### 8.4 会话 API

```ts
export interface BenchOptions {
  motors: MotorAddress[]
  periodsMs?: number[]
  attempts?: number
  sampleGapMs?: number
  sampleJitterUs?: number
  warmupMs?: number
  minPacketThreshold?: number
  maxDropCountBeforeThreshold?: number
  maxDropRateAfterThreshold?: number
  realtime?: boolean
  cpuAffinity?: boolean
  seed?: number
}

export interface BenchSession {
  readonly id: number
  start(): void
  poll(): BenchUpdate
  stop(drainMs?: number): BenchResult
  dispose(): void
  [Symbol.dispose](): void
}

export interface BenchApi {
  create(options: BenchOptions): BenchSession
}
```

`BenchUpdate`：

```ts
export interface BenchPeriodResult {
  periodMs: number
  state: 'pending' | 'warmup' | 'sampling' | 'done'
  stopReason: 'ok' | 'loss-limit' | 'interrupted' | 'error'
  attempts: number
  valid: number
  lost: number
  meanUs: number
  p1Us: number
  p5Us: number
  p50Us: number
  p95Us: number
  p99Us: number
  opsPerSecond: number
  errorPercent: number
}

export interface BenchUpdate {
  phase: 'idle' | 'running' | 'stopping' | 'finished' | 'error'
  currentPeriod: number
  periods: BenchPeriodResult[]
  motors: MotorSnapshot[]
  elapsedSeconds: number
  events: NativeEvent[]
}
```

`StressSession` / `PlaySession` 类似；`PlaySession` 额外：

```ts
export interface PlaySession {
  start(): void
  pause(): void
  resume(): void
  setLogging(enabled: boolean): void
  poll(): PlayUpdate
  stop(): PlayResult
  dispose(): void
}
```

### 8.5 错误模型

```ts
export class EmcliNativeError extends Error {
  readonly code: string          // EMCLI_*
  readonly status?: number       // emcli_perf_status
  readonly detail?: string
  readonly osErrno?: number
  constructor(code: string, message: string, options?: { status?: number; detail?: string; osErrno?: number; cause?: unknown })
}
```

原则：

- 所有失败都抛 `EmcliNativeError`，不返回 `undefined`/静默；
- 错误消息包含：期望值、实际值、路径、建议动作；
- 原生层 `message` 与 `detail` 分开：`message` 面向用户，`detail` 面向诊断（含 `dlerror`、已加载模块列表）。

### 8.6 使用示例

Bench：

```ts
const native = loadEmcliNative({ driverPackageRoot })
const session = native.bench.create({
  motors: discoveredMotors,          // TS 扫描得到
  periodsMs: [10, 5, 3, 2, 1],
  attempts: 500,
})
session.start()
for (;;) {
  const update = session.poll()
  renderBench(update)
  if (update.phase === 'finished' || update.phase === 'error') break
  await sleep(100)
}
const result = session.stop()
session.dispose()
```

Play：

```ts
const trajectory = parseTrajectoryCsv(path)   // TS 冷路径
const session = native.play.create({
  motors: trajectory.motors,
  trajectory: trajectory.data,                // { timesSec, positionsDeg, motorCount }
  holdingMotors,
  mode: 'pvt',
  kp: 0, kd: 1, velocity: 0, torque: 0,
  endless: false,
  returnToInitial: true,
})
session.start()
```

Stress：

```ts
const session = native.stress.create({ motors, loopPeriodMs: 1 })
session.start()
setInterval(() => renderStress(session.poll()), 100)
process.once('SIGINT', () => { session.stop(); session.dispose() })
```

### 8.7 与 CLI/TUI 的边界

- TUI 只消费 `poll()` 返回的普通对象；不直接触达原生句柄。
- 暂停/恢复/日志开关通过会话方法，不在渲染循环里直接调用驱动。
- 退出顺序：`session.stop()` → `session.dispose()` → 驱动 wrapper `dispose()` → `native.dispose()`。
- `process.on('SIGINT')` 必须只设置标志并调用 `stop()`；不要在信号处理里做重活。

---

## 9. C++ 引擎设计

### 9.1 源码结构

```text
native/
  CMakeLists.txt
  cmake/
    ResolveEncosDriver.cmake
    Platform.cmake
  include/
    emcli_perf_abi.h
  loader/
    loader.cc                 # N-API，open/info/dispose
    marshal.cc/.h             # JSON/结构体/数组编组
    dynamic_library_posix.cc
    dynamic_library_win32.cc
    module_guard_posix.cc     # dl_iterate_phdr
    module_guard_win32.cc     # EnumProcessModules
  engine/
    abi.cc                    # C ABI 入口、异常边界
    runtime.cc/.h             # global init、会话注册表
    address.cc/.h             # 适配器/总线/电机借用
    bench_session.cc/.h
    stress_session.cc/.h
    play_session.cc/.h
    trajectory.cc/.h          # 校验、插值、前后向
    telemetry.cc/.h           # 双缓冲/序列锁快照
    event_ring.cc/.h
    thread_hints.cc/.h        # 优先级/亲和/mlock
    version.h.in
```

### 9.2 线程模型

| 线程 | 数量 | 职责 | 优先级（默认） |
| --- | --- | --- | --- |
| JS 主线程 | 1 | create/start/poll/stop、编组 | 普通 |
| bench sender | 每个适配器 1 | 每周期 `PVTControl<0>(0,1,0,0,0)` + `Commit` | 10 |
| bench sampler | 1 | 预热、随机选电机、CAS、`GetParameter<Position>` 计时 | 50 |
| stress sender | 每个适配器 1 | 每周期 PVT + `Commit` | 10 |
| play control | 1 | 1 kHz 轨迹插值、PVT/Pos、holding、commit | 10 |
| telemetry | 每个会话 1（可选） | 20 Hz 采样状态/丢包窗口，写快照 | 普通 |
| driver 接收线程 | 驱动内部 | 回调计数 | 驱动决定 |

规则：

- 引擎线程是 `std::thread`，不是 libuv 线程；绝不从引擎线程调用 N-API。
- `poll` 只读快照，不触发驱动调用（play 的状态快照由 telemetry 线程更新；`GetStatus` 不在 JS 线程执行）。
- `stop` 设置原子标志并 `join`；最大等待由 `drain_ms + 2s` 限制。若超时，返回 `EBUSY`，会话保持 `stopping`，由后续 `stop`/`destroy` 继续。
- 每个会话一个 `std::jthread` 或 `std::thread` 集合；析构时确保 join。
- 线程创建失败（资源不足）返回 `EINTERNAL`，不要部分启动。

### 9.3 热路径规则

在 sender / sampler / control 循环内：

- 禁止 `new` / `malloc` / `std::string` 拼接 / `std::vector` 扩容；
- 禁止互斥锁、条件变量、文件 I/O、日志格式化；
- 禁止调用 JS 回调、`napi_*`；
- 计数器用 `std::atomic<uint64_t>` + `memory_order_relaxed`；
- 失败信息写入固定大小 `char[512]` + 原子标志，由 cold path 读取；
- 时间使用 `std::chrono::steady_clock`，周期推进用“下一 tick += period”，落后时重置为 now（与旧实现一致）。

### 9.4 bench 行为对齐

必须保持旧实现的语义（`src/cli/bench.cc`）：

1. 适配器 `SetSyncMode(false)`；每个总线 `SetSyncMode(true)`；采样期间保持软同步。
2. 每个适配器一个 sender 线程，每周期：
   - 对该适配器所有总线上的电机发 `PVTControl<0>(0.0f, 1.0f, 0.0f, 0.0f, 0.0f)`；
   - 对每个电机做 `busy` CAS，跳过正在被采样的电机；
   - 对每条总线 `Commit()`。
3. sampler：
   - 预热 `warmupMs`；
   - 每次从所有电机中均匀随机选择；
   - 等待 `sampleGapMs + U[0, sampleJitterUs]`；
   - 以 50 µs 间隔自旋等待目标电机 `busy=false`，CAS 置 true；
   - 仅包围 `GetParameter<MotorParameter::Position>()` 计时；
   - 异常算 lost；成功样本取 `max(0.001, elapsed_us)`；
   - 尝试数达到 `attempts` 或丢包限制触发则停止。
4. 每个周期结束计算：
   - `mean`、`P1/P5/P50/P95/P99`（线性插值，`index=(n-1)*p`）；
   - `op/s = 1e6 / P50`；
   - `err% = 100 * median(|x - P50| / x)`（nanobench MdAPE 定义）。
5. 丢包限制：
   - `attempts < minPacketThreshold` 时，`lost > maxDropCountBeforeThreshold` 停止；
   - 否则 `lost/attempts > maxDropRateAfterThreshold` 停止。
6. 任一 sender/sampler 异常：记录 `failure`，停止所有线程，当前档标记 error。
7. `Ctrl-C`：设置取消标志，保留已完成档结果，当前档标记 interrupted，退出码 1。

### 9.5 stress 行为对齐

1. 不改变总线同步模式；每适配器 sender 线程直接 PVT + `adapter->Commit()`。
2. 每个电机注册 `SetOnStatus` 回调，测量窗口内 `received++`；回调只做原子加。
3. 预热 `warmupDelayMs` 后清零计数器；测量开始。
4. 每 500 ms 由 telemetry/JS 读取快照；`sent`、`received`、`lost`、速率、每总线/电机明细。
5. 停止后：
   - join sender；
   - 记录停止前计数；
   - 等待 `drainDelayMs`；
   - 注销回调；
   - 返回 drain 前后差值与最终统计。
6. 实时优先级/亲和/mlock 失败只发事件（`WARN`），不终止。

### 9.6 play 行为对齐

1. TS 解析 CSV、建立轨迹与电机映射；引擎只接收二进制视图。
2. 启动阶段：读取各轨迹电机当前位置，用 `startupTransitionMs` 线性过渡到轨迹首点。
3. 播放阶段：
   - 每 `controlPeriodUs`（默认 1000）计算 `elapsed`；
   - 按旧 `EvaluateTrajectory` 规则做前向/后向插值；
   - `pvt` 模式：`PVTControl<0>(kp, kd, position_rad, velocity, torque)`；
   - `pos` 模式：`PosControl<0>(position_rad, maxSpeed, maxCurrent, 1)`；
   - 对 `holdingMotors` 每周期发 `PosControl<0>(holdingPosition, maxSpeed, maxCurrent, 1)`；
   - 对每个适配器 `Commit()`。
4. 结束阶段：
   - 有限播放结束且 `returnToInitial=true`：从终点线性过渡回初始位置，时长 `returnTransitionMs`；
   - `endless=true`：总时长 `2 * duration` 为一个循环，前向到终点后反向回到起点，如此往复；
   - 单样本轨迹：保持该点。
5. 暂停：暂停控制时钟（`elapsed` 不增长），仍可继续发送保持位置？旧实现暂停时继续发当前位置（`SendPositions` 使用暂停时状态）。设计：暂停时保持最后一帧位置并继续 commit，避免电机失力；`paused` 标志与时钟偏移由引擎维护。
6. 日志：
   - `log.enabled` 时对轨迹与 holding 电机调用 `EnableLog(baseName)`；
   - 动态 `setLogging` 调用 `EnableLog`/`DisableLog`；
   - 停止时确保 `DisableLog`，再注销回调。
7. 循环超时统计：记录 `overruns`、`maxOverrunUs`、最近一次超时时间；事件环只报告首次和每分钟一次，避免刷屏。
8. 接收计数：每个电机 `SetOnStatus` 原子加；停止/注销顺序与 stress 一致。

### 9.7 对象借用与生命周期

- 引擎在 `create` 时解析并缓存 `BaseAdapter*` / `Bus*` / `Motor*`，会话期间不重复查找。
- 引擎**不拥有**这些对象，不调用任何 `Delete*` / `Destroy*`。
- TS 必须在 `session.stop()` 完成后才能 `adapter.dispose()` / `motor.dispose()`。
- 若检测到会话仍活跃时驱动对象被销毁，驱动内部会拒绝/等待（其生命周期门禁），但引擎无法保证安全；因此 API 层强制：
  - `EmcliNative.dispose()` 先停止全部会话；
  - `napi_add_env_cleanup_hook` 再停止一次；
  - 文档与测试明确“先 stop 再 dispose”。
- 建议上游增加 `FindAdapter(interface_name)`，让引擎严格“只查找不创建”；当前用 `MakeAdapter` + 空总线校验兜底。

### 9.8 遥测与快照

- 每个会话维护 `TelemetryBuffer`：
  - 写线程（sender/control/telemetry）更新计数器；
  - telemetry 线程每 50 ms 组装一次 `MotorSnapshot` 数组；
  - 使用序列锁（seqlock）或双缓冲 + `atomic<uint32_t> index`，读者无锁拷贝；
  - `poll` 只做 `memcpy` 到调用方缓冲区，复杂度 O(motors)。
- bench 的每档结果在档结束时写入固定数组，`poll` 直接读取。
- 事件环与遥测分离，避免错误信息影响快照布局。

### 9.9 日志与诊断

- 引擎不直接使用 spdlog；驱动日志由驱动自身管理。
- 引擎自有的 `EMCLI_LOG` 在 Release 下编译为 no-op；诊断通过事件环。
- `emcli_perf_build_info_json()` 返回：
  ```json
  {
    "packageVersion": "0.1.0",
    "engineVersion": "0.1.0",
    "abi": 1,
    "driverVersion": "4.1.2",
    "compiler": "gcc 12.2.0",
    "buildType": "Release",
    "gitCommit": "…",
    "buildTime": "2026-10-28T…"
  }
  ```
- 崩溃诊断：捕获 `SIGSEGV` 不做（会干扰 Node）；依靠 core dump + `build info`。可选集成 Tracy 作为开发构建。

---

## 10. 同进程单例约束（重点）

> 用户明确约束：两个 `.node` 必须在同一进程中被加载使用，否则会影响单例共享的 adapter 实例。

### 10.1 为什么必须同进程

`EncosDriverManager` 是**进程级单例**（`Instance()`），`MakeAdapter` 以 `interface_name` 去重并返回同一 `BaseAdapter*`。如果性能模块在另一个进程：

- 会产生第二个管理器单例；
- 会再次打开同一个 CAN/EtherCAT 接口，导致总线冲突、重复收发、设备状态错乱；
- TS 侧持有的 adapter/motor 与性能模块看到的不是同一对象，计数、配置、生命周期全部失真。

即使在同一进程，如果加载了两份 `libencosdriver`（不同路径/不同副本），同样会产生两个单例。因此约束不仅是“同进程”，而是“同进程 + 同库实例”。

### 10.2 强制规则

| 规则 | 实现层 | 违反时 |
| --- | --- | --- |
| R1 只在主进程、主线程加载两个原生模块 | TS + loader（记录 owner thread/env） | `EMCLI_WRONG_ENV` |
| R2 禁止 `child_process` / `fork` 跑 bench/stress/play | TS CLI 代码审查 + 测试 | 设计禁止 |
| R3 禁止在 `worker_threads` 中加载/调用 | loader 检查 `napi_env` 属主 | `EMCLI_WRONG_ENV` |
| R4 进程内只允许一份驱动库 | loader 冲突扫描 + 指针同一性 | `EMCLI_DRIVER_INSTANCE_CONFLICT` |
| R5 驱动包解析必须锚定驱动入口 | TS resolver（`createRequire(driverEntry)`） | 解析失败或冲突 |
| R6 引擎只借用、不销毁 | 引擎 API 设计 + 代码审查 | 测试断言 |
| R7 先 stop 会话，再 dispose 驱动对象 | TS 退出编排 + 文档 | 驱动生命周期门禁/崩溃 |
| R8 不 `dlclose` 驱动/引擎 | loader 设计 | 进程退出才释放 |
| R9 不混用系统库与 npm 包 | 冲突扫描 + 错误提示 | 失败即退出，不降级 |
| R10 不在信号处理/回调线程调用引擎 | TS 编排 | 事件循环阻塞/竞态 |

### 10.3 属主检查

加载器在 `open` 时记录：

```c
pthread_t owner_thread;
napi_env owner_env;
pid_t owner_pid;
```

所有导出到 JS 的函数入口检查：

- 当前 `napi_env` 是否等于 `owner_env`；
- 当前线程是否等于 `owner_thread`；
- 进程号未变（防 fork）。

不匹配返回 `EMCLI_WRONG_ENV`，消息包含期望/实际 env 与线程 ID。这样即使用户在 Worker 中 `require` 本包，也会得到明确错误，而不是悄悄共享或崩溃。

### 10.4 冲突检测流程

```text
open(driverLib):
  1. realpath(driverLib)
  2. 枚举已加载模块，找所有 basename ∈ {libencosdriver.so.*, libencosdriver_base.so.*,
     encosdriver.dll, encosdriver_base.dll}
  3. 对每个命中项 realpath：
       - 属于期望目录（driverLib 所在目录 / 其 runtime/lib）→ ok
       - 其他 → 收集冲突，返回 CONFLICT
  4. dlopen(driverLib, RTLD_GLOBAL)
  5. 再枚举一次（防止 dlopen 期间被依赖带入其他副本）
  6. 指针同一性校验（主库）
  7. dlopen(engineLib)
  8. 再枚举 + 指针同一性校验（引擎实际绑定）
```

期望目录判定：

- `driverLib` 的 `realpath` 所在目录；
- 其父目录下的 `runtime/lib`（兼容符号链接布局）；
- Windows 额外允许 `driverDir` 与 `native/`。

### 10.5 失败信息示例

```text
EMCLI_DRIVER_INSTANCE_CONFLICT: detected a second libencosdriver instance.
  expected: /app/node_modules/@encos/encos-driver-native-linux-x64-gnu/runtime/lib/libencosdriver.so.4
  loaded:   /usr/local/lib/libencosdriver.so.4
  This would create a second EncosDriverManager singleton and break adapter sharing.
  Fix: remove LD_PRELOAD / uninstall the conflicting system copy, or run `npm dedupe`.
```

### 10.6 测试约束

CI 必须包含：

1. **正向**：同一进程加载驱动 + 性能模块，`Fake` 适配器上跑 bench/stress/play，断言看到同一电机、同一计数器。
2. **负向 - 系统库**：子进程中 `LD_PRELOAD=/usr/local/lib/libencosdriver.so.4`，加载 npm 包驱动后再 open 性能模块，断言 `CONFLICT`。
3. **负向 - 双副本**：把平台包复制到临时目录，先让驱动加载副本 A，再让性能模块 open 副本 B，断言 `CONFLICT`。
4. **负向 - Worker**：在 `new Worker` 中调用 `loadEmcliNative`，断言 `WRONG_ENV`。
5. **负向 - 子进程**：文档/测试禁止；如果用户用 `spawn` 跑 `emcli bench`，那是独立进程，硬件层面由用户负责，不属于本包可检测范围。

---

## 11. SEA（单可执行文件）兼容性

### 11.1 目标形态

```text
emcli(.exe)                # 单文件
  ├─ Node.js runtime + SEA blob
  ├─ 应用 JS（CJS bundle）
  └─ assets:
       assets/perf/native/emcli_loader.node
       assets/perf/native/libemcli_perf.so
       assets/driver/...（驱动平台包运行时内容）
```

### 11.2 启动流程

```text
1. 读取 manifest（编译进 bundle 或 SEA asset）
2. 计算缓存目录：<os-cache>/emcli/native/<version>-<platform>-<arch>-<buildId>/
3. 若目录完整且 hash 匹配 → 直接使用
4. 否则解压资产到临时目录（同卷），fsync 后原子 rename
5. chmod 0755（Linux/macOS）
6. 把 nativeRoot 传给 resolveNativePaths / loadEmcliNative
7. 加载驱动、创建适配器、加载性能模块
```

缓存目录：

| 平台 | 路径 |
| --- | --- |
| Linux | `$XDG_CACHE_HOME/emcli/native/…`，缺省 `~/.cache/emcli/native/…` |
| Windows | `%LOCALAPPDATA%\emcli\native\…` |
| macOS | `~/Library/Caches/emcli/native/…`（未来） |

### 11.3 资产布局

```text
<nativeRoot>/
  perf/
    native/
      emcli_loader.node
      libemcli_perf.so
      manifest.json
  driver/
    package.json
    native/encosdriver.node
    runtime/lib/libencosdriver.so.4
    runtime/lib/libencosdriver_base.so.4
    runtime/lib/encosPlugins/*.so
    ...
```

- 驱动部分直接复制 `@encos/encos-driver-native-<platform>` 平台包的运行时子树，保持相对布局；
- 不要只复制 `libencosdriver.so`：插件、base、broker、BPF/固件依赖都可能需要；
- 通过 `native/manifest.json` 列出每个文件的 `sha256`、`mode`、`size`，释放后校验；
- 可选 gzip 压缩资产（`.gz`），释放时解压，降低单文件体积。

### 11.4 加载原生模块

SEA 中不能假设 `require` 能加载外部文件。加载器统一走：

```ts
import { Module } from 'node:module'

function loadAddon(path: string): NodeModule {
  const mod = new Module(path)
  process.dlopen(mod, path)
  return mod
}
```

- 已在 Node 24 验证 `process.dlopen(new Module(path), path)` 可用；
- 若未来 Node 版本限制，回退 `createRequire(import.meta.url)(path)`；
- 不使用 `require.resolve` 解析包路径（SEA 中没有 node_modules）。

### 11.5 驱动包的 `packageRoot` 问题（必须上游配合）

当前 `@encos/encos-driver-native` 的 `create-runtime-native.ts`：

```ts
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const addon = require(resolve(packageRoot, 'native/encosdriver.node'))
```

在 SEA / 任意 bundler 产物中，`import.meta.url` 指向 bundle 文件，`packageRoot` 错误，导致找不到 `native/encosdriver.node`。
此外，SEA 中 `require(绝对路径)` 加载外部 `.node` 并不可靠，驱动 loader 需要改用
`process.dlopen(new Module(path), path)`。

**建议上游改动（4.1.2）**：

```ts
export interface NativeRuntimeOptions {
  pluginPath?: string
  /** 覆盖由 import.meta.url 推导的包根；SEA/打包场景必填 */
  packageRoot?: string
  /** 覆盖 addon 加载方式；SEA 场景传 process.dlopen 实现 */
  loadAddon?: (path: string) => { createRuntime(pluginPath: string): NativeContext }
}

export async function createEncosRuntime(options: NativeRuntimeOptions = {}): Promise<Runtime> {
  const packageRoot = options.packageRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const addon = (options.loadAddon ?? defaultRequireAddon)(resolve(packageRoot, 'native/encosdriver.node'))
  ...
}
```

新版 emcli 从 `resolveNativePaths().driver.packageRoot` 取值，同时传给 `createEncosRuntime` 和
`loadEmcliNative`，保证两边看到同一路径；`loadAddon` 使用与 `emcli_loader.node` 相同的
`process.dlopen` 实现，确保两处加载行为一致。

在 4.1.2 发布前，临时方案：

- 应用侧复制 `create-runtime-native` 的 20 行逻辑，使用导出的 `Runtime` 与内部 `createNativeBackend`（需 deep import，版本脆弱）；
- 或用 esbuild alias 替换该模块；
- **不推荐**在生产 SEA 中使用临时方案，应尽快上游化。

### 11.6 CJS vs ESM

- Node 22 的 SEA 对 ESM 入口支持有限；为兼容 22/24，应用入口统一 bundle 为 **CJS**。
- `@encos/emcli-native` 同时发布 ESM/CJS；`@encos/encos-driver-native` 目前是 ESM-only，esbuild 可以将其打包进 CJS 产物。
- 打包时避免 `import.meta.url` / `__dirname` 决定原生路径；全部走显式 `nativeRoot`。
- 动态 `import()` 外部文件在 SEA 中不可靠；不要用。

### 11.7 版本与缓存失效

缓存 key 包含：

- `emcli` 版本；
- 本包版本 + `nativeAbi`；
- 驱动版本；
- 平台/架构；
- 资产内容 hash（构建时生成 `buildId`）。

任一变化 → 新目录，不覆盖旧目录；旧目录可保留最近 2 个版本，启动时异步清理。

### 11.8 并发与安全

- 多个 emcli 进程同时首次启动：各自写临时目录，`rename` 原子提交；失败方检测到目标已存在且 hash 正确则直接使用。
- 缓存目录权限 `0700`，文件 `0700`（可执行）/ `0600`（数据）；拒绝符号链接目标。
- 解压路径必须来自 manifest 白名单，禁止 `..` / 绝对路径 / 盘符。
- Windows Defender 可能短暂锁定新文件：`rename`/`chmod` 重试 3 次（指数退避）。
- 可选 `--verify-native` 启动时强制校验 hash；默认缓存命中时跳过以缩短启动。

### 11.9 SEA 验收

1. 在无 `node_modules`、无源码、只读 CWD 的目录运行单文件，`bench/stress/play --help` 与 Fake 适配器自测通过。
2. 冷启动（首次释放）< 1 s（不含驱动初始化）；热启动 < 200 ms。
3. 删除缓存后自动重建；缓存损坏（截断文件）能被 hash 检测并重建。
4. 两个进程并发启动不产生半成品文件。
5. Linux `ldd` 显示引擎只依赖系统库 + 驱动库；无构建机绝对路径。
6. Windows 在无 Node 安装、无 MinGW 运行时的干净机器上运行。

---

## 12. 构建与发布

### 12.1 开发流程

```bash
# 1. 解析本地 SDK（必须 4.1.2）
node packages/emcli-native/scripts/resolve-driver.mjs --expected 4.1.2 --out build/driver.json

# 2. 构建原生
cmake -S packages/emcli-native/native -B build/native -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DEMCLI_DRIVER_CMAKE_DIR=/usr/local/lib/cmake/encos_driver \
  -DEMCLI_EXPECTED_DRIVER_VERSION=4.1.2 \
  -DNODE_INCLUDE_DIR="$HOME/.nvm/versions/node/v24.22.1/include/node"
cmake --build build/native -j

# 3. 自检：加载器 + 引擎 + 驱动同实例
node packages/emcli-native/test/native/smoke.mjs

# 4. 打包平台包
node packages/emcli-native/scripts/pack-platform.mjs --platform linux --arch x64 \
  --native build/native --out build/npm

# 5. 打包选择器
node packages/emcli-native/scripts/pack-selector.mjs --out build/npm
```

### 12.2 CMake 关键配置

- `CMAKE_CXX_STANDARD 17`（与驱动一致；若驱动要求 20 则跟随）。
- `-O3 -DNDEBUG -fno-omit-frame-pointer`（保留诊断）。
- `-Wall -Wextra -Werror`（CI），但驱动头文件可能触发警告 → 对驱动 include 使用 `SYSTEM`。
- `-fvisibility=hidden`，仅导出 C ABI。
- Linux：`-Wl,-z,now -Wl,-z,relro`；不写 RPATH。
- Windows：`/EHsc` 或 MinGW 默认；静态运行库；导出 `.def` 或 `__declspec(dllexport)`。
- 引擎与加载器分别设置 `OUTPUT_NAME`，避免与驱动 `encosdriver` 同名。

### 12.3 CI 矩阵

| 任务 | 环境 | 产物 |
| --- | --- | --- |
| Linux x64 | Debian 10 / glibc 2.28 容器，GCC 与驱动一致 | 平台包 + 测试报告 |
| Linux arm64 | 同容器交叉/原生 | 平台包 |
| Windows x64 | MinGW-w64（与驱动 CI 一致） | 平台包 |
| 选择器 | Linux | 选择器包 |
| 集成 | Linux + Windows | Fake 适配器 bench/stress/play、SEA 冒烟 |

CI 必须从**已发布的驱动平台包**（或 CI 产出的等价 tgz）安装依赖，而不是只用本地 `/usr/local`，以验证真实的 `runtime/lib` 布局。

### 12.4 版本同步

- `manifest.json` 的 `builtAgainstDriver` 由发布脚本从驱动平台包 `package.json` 读取并写入。
- `scripts/sync-version.mjs` 校验：
  - 选择器与三个平台包版本一致；
  - `native/manifest.json.driverVersion` 与 peer 范围下界一致；
  - `package.json` 的 `optionalDependencies` 精确指向当前版本。
- 任一不一致 → CI 失败。

### 12.5 发布检查清单

- [ ] `readelf -d libemcli_perf.so` 无 RPATH/RUNPATH，且 `NEEDED` 为 SONAME。
- [ ] `ldd -r libemcli_perf.so` 无未解析符号。
- [ ] `emcli_loader.node` 无 encos NEEDED（`readelf -d` 检查）。
- [ ] 同进程自检通过（驱动 + 性能模块）。
- [ ] 冲突检测负向测试通过。
- [ ] SEA 冒烟通过。
- [ ] 许可证/第三方声明齐全。
- [ ] `npm pack` 内容不含构建机路径、`.debug`、源码。

---

## 13. 测试与验收

### 13.1 测试分层

| 层 | 内容 | 工具 |
| --- | --- | --- |
| TS 单元 | 平台选择、版本比较、路径解析、SEA 解压（mock `node:sea`）、错误码 | vitest |
| C++ 单元 | 百分位/MdAPE、丢包限制、轨迹插值（前向/后向/往返/单点）、配置校验 | CTest |
| 集成 | Fake 适配器上 bench/stress/play；同实例断言；事件/快照 | Node test runner |
| 负向 | 双库冲突、Worker、错误版本、缺平台包、损坏缓存 | Node test runner |
| 性能 | 1 kHz 抖动、CPU 占用、RSS、10 分钟 soak | 脚本 + CI nightly |
| SEA | 单文件冷/热启动、只读 CWD、无 node_modules | CI |
| 平台 | glibc 2.28、Windows 路径含空格/中文 | CI |

### 13.2 行为等价基线

- 用旧 C++ `emcli bench` 与新版在**同一 Fake 适配器配置**下对比：
  - 档位、尝试数、丢包限制、分位数定义一致；
  - 计时噪声允许 ±5%（Fake 环境）。
- `play`：
  - 轨迹插值用黄金向量逐点对比（误差 < 1e-5）；
  - 启动/回零过渡时长、无限往返周期、单点保持；
  - holding 电机位置保持；
  - 暂停期间 `elapsed` 不增长。
- `stress`：
  - 每周期发送次数 = `periods × motors`；
  - 接收计数回调与驱动一致；
  - drain 前后差值输出。

### 13.3 性能验收

| 指标 | 目标 |
| --- | --- |
| play 1 kHz 控制周期抖动 | p99 < 100 µs（空闲机器，4 核+） |
| play 超时率 | 10 分钟 < 0.01% |
| bench sampler 额外开销 | 不影响测量区间（只包围 `GetParameter`） |
| stress 1 kHz × 64 motors | 单适配器 < 1 核 |
| 会话创建 | < 50 ms（不含驱动/扫描） |
| poll 20 Hz × 64 motors | < 1 ms |
| RSS | 每会话 < 16 MB（不含驱动日志） |
| 线程 | 每适配器 1 sender + 1 sampler/control + 1 telemetry |

### 13.4 通过标准

- 所有单元/集成/负向测试通过；
- 行为等价基线通过；
- 性能目标在 CI nightly 连续 3 次达标；
- SEA 在干净环境通过；
- 无 ASan/TSan 报告（至少 nightly 跑一次）；
- 代码审查确认热路径无分配/锁/JS 回调。

---

## 14. 风险与备选

| 风险 | 影响 | 缓解 | 备选 |
| --- | --- | --- | --- |
| glibc 不按 SONAME 复用已加载库 | 引擎加载失败或双实例 | 已在本地验证；CI 在 2.28 复验；加载后指针校验 | 引擎改为只 `dlsym` 一小撮 C 函数（工作量大） |
| Windows 按 basename 复用错误 DLL | 静默用错驱动 | `GetModuleFileNameW` 校验 + 冲突扫描 | 每次加载前 `FreeLibrary`（危险，不采用） |
| C++ ABI 与驱动不一致 | 崩溃/未定义行为 | 同工具链/同标准库构建；版本锁定；CI 链接冒烟 | 推动驱动提供稳定 C ABI（长期） |
| pnpm 多副本驱动 | 双实例 | peer 依赖 + 解析锚定驱动入口 + 冲突检测 | 应用强制 `pnpm dedupe` / overrides |
| SEA 资产体积大（驱动 base 37 MB + 插件 51 MB） | 单文件过大 | 按适配器裁剪插件；gzip 资产 | 外置驱动包（放弃单文件） |
| Node SEA 不支持外部 addon | 无法加载 | 释放到缓存 + `process.dlopen` | 不用 SEA，改用安装包 |
| 驱动 `packageRoot` 不可覆盖 | SEA 找不到 addon | 上游加 `packageRoot` 选项（4.1.2） | 本地复制 20 行 loader（临时） |
| 1 kHz 抖动不达标 | play 性能回退 | 实时优先级 + 亲和 + 预分配；CI 性能门禁 | 降低控制频率（需产品确认） |
| 旧行为细节遗漏（holding/暂停/回零） | 用户可见差异 | 黄金向量 + 旧实现对照测试 | 分阶段迁移，先 bench/stress 后 play |
| 驱动回调线程与引擎 stop 竞态 | 崩溃 | 先 join sender，再 drain，再注销回调；原子计数 | 延长 drain / 引用计数 |

---

## 15. 里程碑

| 阶段 | 内容 | 交付 |
| --- | --- | --- |
| M0（本次） | 包设计、ABI 草案、解析器 | 设计文档 + 骨架 |
| M1 | 加载器 + 引擎骨架 + Fake 自检 | `open` 成功、同实例断言、CI |
| M2 | bench 迁移 | 行为/性能对照通过 |
| M3 | stress 迁移 | 计数器/drain 对照通过 |
| M4 | play 迁移 | 轨迹/过渡/日志对照通过 |
| M5 | SEA 打包 | 单文件冷/热启动通过 |
| M6 | 发布 | 三平台包 + 选择器包 + 文档 |

---

## 16. 已定决策与待确认

### 16.1 已定

1. 包名 `@encos/emcli-native`，平台包后缀复用驱动规则。
2. 两个原生产物：`emcli_loader.node` + `libemcli_perf.so`。
3. 引擎使用纯 C ABI，不依赖 Node-API。
4. 驱动为 `peerDependency`，平台包为 `optionalDependencies`。
5. TS 解析驱动入口并锚定平台包，传入绝对路径；加载器负责 `dlopen` 顺序与校验。
6. 引擎只借用驱动对象，不拥有、不销毁。
7. 禁止 Worker/子进程加载/运行性能模块。
8. 默认要求驱动版本完全一致；开发模式可显式放宽。
9. SEA 采用“释放到缓存 + 显式 nativeRoot + `process.dlopen`”。
10. 应用入口打成 CJS，兼容 Node 22/24。

### 16.2 需要上游/产品确认

| 事项 | 建议 | 影响 |
| --- | --- | --- |
| 驱动 4.1.2 增加 `createEncosRuntime({ packageRoot })` | 强烈建议 | 决定 SEA 是否能干净实现 |
| 驱动增加 `FindAdapter(interfaceName)` | 建议 | 引擎可严格“只查不建” |
| Windows 工具链 | 与驱动 CI 的 MinGW-w64 完全一致 | 否则 C++ ABI 不兼容 |
| 是否首版支持 play 的全部模式 | 建议完整对齐 | 否则需明确降级范围 |
| SEA 是否允许按适配器裁剪插件 | 建议允许 | 单文件体积 |
| 最低 Node 版本 | 22 | 与驱动一致 |

---

## 附录 A：平台包 `index.js` 约定

```js
// @encos/emcli-native-linux-x64-gnu/index.js
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const packageRoot = dirname(fileURLToPath(import.meta.url))
export const loaderPath = join(packageRoot, 'native', 'emcli_loader.node')
export const enginePath = join(packageRoot, 'native', 'libemcli_perf.so')
export const manifest = JSON.parse(
  await import('node:fs').then(fs => fs.readFileSync(join(packageRoot, 'native', 'manifest.json'), 'utf8')),
)
```

选择器解析时只依赖 `packageRoot`（或从入口向上找 `package.json`），不要求平台包导出更多内容。

## 附录 B：加载器错误映射

| C 状态 | JS `code` | 是否可重试 |
| --- | --- | --- |
| `EMCLI_PERF_EINVAL` | `EMCLI_INVALID_ARGUMENT` | 否 |
| `EMCLI_PERF_ENOENT` | `EMCLI_NOT_FOUND` | 否（检查地址/扫描） |
| `EMCLI_PERF_EBUSY` | `EMCLI_BUSY` | 是（等待 stop 完成） |
| `EMCLI_PERF_EDRIVER` | `EMCLI_DRIVER_CALL_FAILED` | 视驱动错误 |
| `EMCLI_PERF_EABI` | `EMCLI_ABI_MISMATCH` | 否 |
| `EMCLI_PERF_ESTATE` | `EMCLI_INVALID_STATE` | 否 |
| `EMCLI_PERF_ECONFLICT` | `EMCLI_DRIVER_INSTANCE_CONFLICT` | 否（需修复环境） |
| `EMCLI_PERF_EINTERNAL` | `EMCLI_INTERNAL` | 否 |

## 附录 C：旧实现到新模块的映射

| 旧 C++ | 新位置 |
| --- | --- |
| `src/cli/bench.cc` 的 `RunBenchFrequency` / `SummarizeBenchSamples` | 引擎 `bench_session.cc` |
| `src/cli/stress.cc` 的 `SenderLoop` / 回调计数 | 引擎 `stress_session.cc` |
| `src/cli/play.cc` 的 `TrajectoryRunner::Run` | 引擎 `play_session.cc` |
| `src/trajectory_player.cc` 的 `EvaluateTrajectory` | 引擎 `trajectory.cc` |
| `src/trajectory_csv_parser.cc` | TS（冷路径） |
| `src/cli/*` 的参数解析/帮助 | TS CLI |
| FTXUI 渲染 | TS TUI |
| `platform_compat.cc` 的 CPU 亲和/锁页 | 引擎 `thread_hints.cc` |

## 附录 D：参考资料（仓库内）

- `../motor_driver/npm-native/package.json`：驱动选择器包与平台包命名。
- `../motor_driver/npm-native/src/loader.js`：平台选择逻辑。
- `../motor_driver/scripts/node/pack.mjs`：平台包布局与驱动版本写入。
- `../motor_driver/npm/src/create-runtime-native.ts`：`packageRoot` 推导（需改）。
- `../motor_driver/cmake/EncosNode.cmake`：现有 Node addon 的 RPATH 方案（本设计不采用）。
- `/usr/local/lib/cmake/encos_driver/`：本地 4.1.2 SDK。
