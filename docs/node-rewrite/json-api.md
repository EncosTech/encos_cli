# emcli JSON API v1

Add `--json` to any noninteractive CLI command. Default text output remains available.
`tui --json` returns an `EMCLI_INTERACTIVE_COMMAND` error; use the corresponding CLI command.
Help and version also accept `--json`.

```sh
emcli --version --json
emcli scan Ethercat --json
emcli scan Ethercat:eth0 --json
emcli config Ethercat:eth0:0:1:1 position --json
emcli stress Ethercat:eth0 --json > stress.jsonl 2> driver.log
emcli play trajectory.csv --dry-run --json
```

## Transport and lifecycle

stdout contains UTF-8 JSON, one record per line, without ANSI codes or human tables.
Native driver stdout and stderr are redirected to **stderr**, including firmware progress.
Consume both pipes concurrently. Do not merge stderr into stdout when parsing.

One-shot commands emit one final record. Continuous commands and bench emit zero or more
`sample` records, then exactly one `result` or `error`. A sample alone never proves success.
Require a successful final record **and** exit code zero. Forced termination can interrupt
the parent itself, so callers must also detect EOF without a final record.

```json
{"schemaVersion":1,"command":"config","type":"result","ok":true,"timestamp":"2026-11-02T00:00:00.000Z","data":{"item":"position","results":[{"target":{"adapterType":"Ethercat","interfaceName":"eth0","slaveId":0,"busId":1,"motorId":1},"ok":true,"action":"read","value":{"positionDeg":12.5}}]},"exitCode":0}
```

- `schemaVersion`: integer protocol version; currently 1.
- `command`: CLI command, or `help` / `version`.
- `type`: `sample`, `result`, or `error`.
- `ok`: command/report success. A final result can be false, e.g. a failed bench threshold or calibration.
- `timestamp`: UTC ISO 8601 emission time; not a hardware sampling timestamp.
- `data`: command payload; may be null if failure occurred before a result existed.
- `exitCode`: final records only. Zero means successful command completion.
- `error`: thrown/process errors contain `code` and `message`. Messages are diagnostic, not stable identifiers.

Known codes: `EMCLI_COMMAND_FAILED`, `EMCLI_UNKNOWN_COMMAND`,
`EMCLI_INTERACTIVE_COMMAND`, `EMCLI_PROCESS_FAILED`; driver-specific error codes may also occur.
Batch config/brake failures additionally identify failed targets in `data.results`.
Numeric values stay numeric; unavailable/nonfinite values become null. Big integers are decimal
strings to avoid IPC serialization failure. Consumers should tolerate additional fields.

On POSIX, send SIGINT to the API parent: it forwards once to its isolated worker.
Continuous reads/control/stress then finish; play performs its existing smooth return first.
A second SIGINT forces termination. JSON mode does not change motor control or stop semantics.
On Windows, console Ctrl+C is read by the API frontend and forwarded over IPC to the isolated
worker, so graceful stop and play's smooth return work there too. Externally killing a Windows
process (including Node child.kill('SIGINT')) still forcibly terminates it and cannot guarantee a return.
No real hardware actions are implied by parsing success: `submitted:true` means submitted,
whereas `acknowledged:true` means a device acknowledgement was received.

## Payloads

| Command | Payload |
| --- | --- |
| version | `version`, `apiVersion:1` |
| help | `text` |
| scan (no target) | `kind:"adapters"`, `adapters:[{adapterType,interfaceName}]` |
| scan Type | `kind:"interfaces"`, `adapterType`, `interfaces:string[]` |
| scan target | `kind:"motors"`, `motors:[{adapterType,interfaceName,slaveId,busId,motorId,eff,canfd}]` |
| scan --slave | `kind:"slaves"`, adapter identity, `slaves:[{index,uuid}]` |
| config motor | `item`, `results:[{target,ok,action,value,error?}]`; position value is `{positionDeg}`; ranges `{min,max}`; gains `{kp,ki}` or `{kp,kd}`; scalar parameters are numbers; brake `{state}` |
| config slave | `kind:"slave"` plus native operation metadata, `code`, `replies:string[]` for gateway protocol replies. Firmware progress is stderr; completion code remains structured |
| control brake | `mode`, `results:[{target,ok,acknowledged,state,error?}]` |
| control other | sample: `mode,target,feedback`; final: `mode,values,stopMode,targets,stopped` |
| imu / battery / pms / glove show | sample: `target,status`; final: `action:"show",target` |
| imu start/stop, battery clear | `action,target,submitted` |
| pms enable/disable | `action,target,channels,mask,submitted` |
| glove calibrate | `action,target,status,message`, with `scope:"all"` or `finger,selection` |
| bench | sample: period and summary; final: `motors,reports` |
| stress | addressed motor counters, total `sent,received`, `elapsedMs,measurementMs,drainMs,drainAdditional,outstandingBefore,outstandingAfter,final,error` |
| play | `phase,elapsedMs,sent,received,final,motors`; final also `logDirectory` |
| doctor | runtime/platform details, permissions and native module information, optional error |

Motor target identity uses `adapterType,interfaceName,slaveId,busId,motorId`.
Sensor targets currently follow the CLI target parser: `adapterType,adapterId,slaveId?,busId?,index?`;
gloves are slave devices. Missing optional address components mean not applicable.

### Units and device fields

- Config position: degrees. Config PVT ranges: driver-native units (position radians, speed rad/s,
  torque Nm, current A); gains and timeouts retain driver units.
- Control feedback: `positionDeg`, `speed` (rad/s), `torque` (Nm), `current` (A),
  `motorTemperature,mosTemperature` (C), `error` (descriptive motor error).
- IMU status: `acceleration:{x,y,z}`, `angularVelocity:{x,y,z}`,
  `eulerAngle:{pitch,roll,heading}`, and any other driver status fields. Values retain
  the driver sensor units; absent groups mean no such measurement has been received.
- Battery/PMS status preserves the native status object's fields and numeric enums;
  no formatted voltage/current strings are introduced.
- Glove status is a five-by-ten finger/encoder array, radians; unavailable entries are null.
- Bench: `periodMs,count,meanUs,p1Us,p5Us,p50Us,p95Us,p99Us,opsPerSecond,errorPercent,
  attempts,lost,status,error`. Percentiles are microseconds.
- Play motors include address, `trajectoryIndex,holding,sent,received,positionRad` (command radians),
  `feedbackPosition` (feedback radians), speed/current/torque/temperatures and `motorError`.
- Stress `measurementMs` excludes drain time in the final report. Derive drop as
  `max(0,sent-received)`; loss fraction is drop/sent (zero when sent is zero).

## h130_script

The companion application adds `--json` to emcli invocations, validates the final envelope and
reads business data only from stdout. It requires emcli >= 2.0.0 with API version 1
(the development 2.0.0-alpha build is accepted). Historical text parser functions remain
available for saved reports; live command execution rejects missing/invalid JSON.
