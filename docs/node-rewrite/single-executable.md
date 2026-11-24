# Single executable build and FakeAdapter verification

The host-platform build packages Node, the application (CLI and TUI), production JavaScript
packages, the native driver/platform libraries and the emcli performance addon in one SEA binary.
It uses [Node's single executable application mechanism](https://nodejs.org/api/single-executable-applications.html).
Linux x64 and Windows x64 are verified. This is a native executable, not a JavaScript file requiring Node on PATH.
System libraries such as glibc/libstdc++ are still required; this is not a static binary or a cross-platform binary.

## Build

Use Node >=22 and a locally installed driver SDK matching the project's driver dependency.
The existing native build requires the C++ compiler and Node headers.

```sh
pnpm build:single
```

If the shell uses an older Node, select the runtime to embed explicitly:

```sh
EMCLI_SEA_NODE=/path/to/node24/bin/node pnpm build:single
```

The outputs are `dist/emcli-linux-x64` and `dist/emcli-win32-x64.exe`, built on their respective hosts.
`dist/emcli-linux-x64.json` records its size, SHA-256, embedded Node version and asset identity.
Only the executable needs to be distributed; the JSON metadata is optional.
Build intermediates live under `build/single`.

## Run

```sh
./dist/emcli-linux-x64 --version --json
./dist/emcli-linux-x64 config Fake:demo:0:1 position --json
./dist/emcli-linux-x64 bench Fake:demo:0:1 --periods 5 --attempts 10 --json
./dist/emcli-linux-x64 tui --demo
```

The first launch extracts embedded modules and native libraries to a private, content-addressed
runtime cache (`$XDG_CACHE_HOME/emcli/single`, or `~/.cache/emcli/single`). Subsequent launches
reuse it. Set `EMCLI_SEA_CACHE` to choose a different writable cache directory. The executable
and working directory can be read-only. Extraction validates each asset hash and publishes
an atomic completion marker, so simultaneous first launches do not use partially extracted files.
The cache can be deleted when no emcli process is using it; the next launch recreates it.

The bootstrap also handles re-execution for JSON worker and TUI driver IPC processes.
These processes use the embedded Node runtime and do not launch a system `node` command.

## Verification

```sh
pnpm test:single
```

The runner copies only the executable into a temporary directory, empties PATH and NODE_PATH,
uses a fresh cache and a read-only working directory, and checks:

- Cold/warm startup, help, version, structured failures and clean JSON stdout.
- Fake motor scan, parameter read/write, brake and all continuous control modes.
- IMU, battery, PMS and glove status streams; command submission and expected calibration failure.
- Native bench/stress and actual Fake playback with motor log files and smooth return on SIGINT.
- Embedded dependency links remain inside the extracted cache; Linux process maps confirm
  the loaded driver libraries also come from that cache, not the system SDK installation.
- A real PTY starts the Fake TUI, displays motors, communicates with the driver worker,
  exits after double Ctrl+C, and restores the alternate screen.

The PTY test uses Python 3 and Linux/POSIX facilities. Fake does not acknowledge glove calibration;
its timeout is verified as a failed JSON result, not counted as successful calibration. No physical
adapter or motor is contacted. Native Fake performance targets enable automatic motor creation,
matching the ordinary CLI Fake initialization; scans still do not fabricate devices.

## Windows build and CI verification

The Windows CI host was tested with Node 24.22.1, MinGW-w64 14.2 and the 4.1.2 driver.
Set `NODE_INCLUDE_DIR` to Node's headers and `EMCLI_DRIVER_PREFIX` to the matching driver SDK
(with `include/encos` and `lib/libencosdriver{,_base}.dll.a`). Put `g++`, `gendef` and `dlltool`
on PATH. `pnpm build:single` then builds the addon, derives the Node-API import library and
packages the executable. It also uses the system Windows PowerShell at build time.

The MinGW binding imports `node.exe` by name. The build includes a small DLL with that import
name, whose exported trampolines resolve Node-API against the actual executable's exports.
This supports renaming the SEA without loading a second Node runtime. Windows junctions point
at final cache paths rather than the renamed staging directory.

The executable preserves Node's application manifest and adds a
[UTF-8 process code page](https://learn.microsoft.com/en-us/windows/apps/design/globalizing/use-utf8-code-page)
for native plugin/CSV/log paths. This requires Windows 10 version 1903 or newer.
Console Ctrl+C is forwarded to the JSON worker over IPC, avoiding Windows' forceful child.kill behavior.

For tests, install `pywinpty` in the **test runner's** Python environment (it is not a product
dependency), then use `pnpm test:single`, or directly:

```powershell
python scripts/test-single-windows.py dist/emcli-win32-x64.exe
```

The Windows suite has 41 cases, including Chinese/space paths, empty PATH, native FakeAdapter
bench/stress/play, smooth return on a real console Ctrl+C, motor log creation and TUI double-Ctrl+C
exit. `dist/windows-test-results.json` and `dist/windows-test.log` record the run. Glove calibration
is an expected timeout test; physical hardware behavior is not covered.

## Linux installed packages and SSH authorization

DEB/RPM install a self-contained, expanded runtime under `/usr/lib/emcli`, including
Node, application modules and native helpers. `/usr/bin/emcli` launches that runtime;
it does not extract into a user's cache or require a system Node installation.
The runtime is built from the same asset manifest as the portable SEA, and its
archive hash is checked before packaging. Linux tar packages contain the same
layout and can be extracted together to a separate prefix.

Package installation and upgrades grant the driver helpers their required file
capabilities using libcap tools. Only the broker and priority helper executables
receive capabilities; Node and emcli do not. Installation into a filesystem that
cannot store capabilities emits a warning; use `emcli doctor` to verify the result.
The tar package requires separate authorization after extraction.

Portable SEA authorization persists only while its extracted helper files remain
in the same cache. A new asset hash, cache deletion or a different user requires
fresh authorization. In an SSH terminal, authorize **before** launching the TUI:

```sh
emcli doctor --request-permissions
emcli doctor
emcli
```

Run the interactive authorization command without `--json`. It requires polkit
and a terminal authentication agent, plus permission to authorize the helpers.
Headless SSH TUI connections check helper permissions before opening native CAN,
EtherCAT or Ethernet adapters, including playback loading. Missing permissions
produce an actionable error instead of starting an invisible password prompt.

The TUI driver worker has its own process session and cannot read the TUI's
controlling terminal. A worker request timeout terminates the worker and its
process group on Linux, rejects queued requests and marks the UI offline. Restart
emcli to reconnect; controls are not automatically replayed after an unknown
connection outcome. Ordinary connection errors leave the add form available for
retry. Memory locking limits are separate from helper capabilities.
