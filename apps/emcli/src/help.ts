// SPDX-License-Identifier: MIT

import { VERSION } from './version.js'

export function helpText(): string {
  return `Usage:
  emcli
  emcli <command> [args]

Encos Motor terminal debugger and command line configuration tool

Options:
  --json                     JSON result or JSONL stream; diagnostics on stderr
  -h, --help                 Show this help message and exit
  -v, --version              Print version information and exit

Commands:
  tui [Type:Interface ...]   Open Motor Studio (default in an interactive terminal)
  tui --demo                 Open Motor Studio with eight native Fake motors
  scan                       List adapter interfaces or scan motors
  config                     Read or set motor configuration
  control                    Continuously send motor control commands
  imu                        Show IMU status or start/stop bus IMU forwarding
  battery                    Show or clear battery status from a bus device
  pms                        Show or control the power management system
  glove                      Show or calibrate glove encoders
  play                       Play motors from a trajectory CSV
  bench                      Benchmark selected motors under PVT load
  stress                     Stress test one or more adapters
  doctor                     Check Node, driver and native module paths

Run 'emcli <command> -h' for command-specific help.

CAN timing options (optional; applied to every adapter this command opens):
  --bitrate BPS              CAN arbitration-phase bitrate in bit/s
  --dbitrate BPS             CAN FD data-phase bitrate in bit/s
  --sample-point RATIO       CAN arbitration-phase sample point in (0, 1]
  --dsample-point RATIO      CAN FD data-phase sample point in (0, 1]

emcli ${VERSION}
`
}

/** CLI output is plain text; interactive controls live exclusively in tui. */
export function commandHelpText(command:string,positionals:string[]=[]):string {
 const usage:Record<string,string>={
  tui:'emcli tui [Type:Interface ...] [--demo]',
  scan:'emcli scan [Type | Type:Interface[:Slave:Bus]]\nemcli scan --slave Ethernet:Interface\nemcli scan --slave Ethercat:Interface',
  config:'emcli config [--canfd] <motor-target> <item> [set <values...>]\nemcli config <motor-target> position reset\nemcli config <motor-target> brake engage|release',
  control:'emcli control [--canfd] [--wait-feedback] <mode> <motor-target> <values...>',
  imu:'emcli imu show Type:Interface:[Slave:]Bus:ImuId\nemcli imu start|stop Type:Interface:[Slave:]Bus:ImuId\nemcli imu start|stop Type:Interface:Bus',
  battery:'emcli battery show|clear Type:Interface:[Slave:]Bus:BatteryId',
  pms:'emcli pms show Type:Interface:[Slave:]Bus\nemcli pms enable|disable Type:Interface:[Slave:]Bus V48_1 [V48_2 ... V48_6]',
  glove:'emcli glove show Type:Interface:Slave\nemcli glove calibrate Type:Interface:Slave all\nemcli glove calibrate Type:Interface:Slave <finger 0..4> <encoder 0..9>\nemcli glove calibrate Type:Interface:Slave <finger 0..4> mask <10-bit mask>',
  play:'emcli play <trajectory.csv> [options]',
  bench:'emcli bench <Type:Interface[:Bus[:Motor|ALL]] ...> [options]\nemcli bench <Type:Interface:Slave:Bus:Motor|ALL ...> [options]',
  stress:'emcli stress <Type:Interface[:Slave:Bus:Motor|ALL] ...> [options]',
  doctor:'emcli doctor [--request-permissions]',
 }
 const detail:Record<string,string>={
  tui:'--demo  Open eight Fake motors. All interactive UI and keyboard controls are available here.',
  scan:'--slave  List slave indices and UUIDs (Ethernet); Ethercat plugins list indices.\nMotor rows: slave, bus, id, eff, canfd.',
  config:'Items: id, position, kt (read-only), pvt-kp-range, pvt-kd-range, pvt-pos-range,\npvt-spd-range, pvt-tor-range, pvt-cur-range, cur-pi, spd-pi, pos-pd, can-timeout, brake (barke), comm.\nRanges take min max; PI/PD take two gains. Position uses degrees.\ncomm set can|canfd|canopen; brake engage|release waits for acknowledgement.',
  control:'pvt: kp kd position_deg speed_rad_s torque_nm\nposition: position_deg max_speed_rad_s max_current_a\nspeed: speed_rad_s max_current_a\ncurrent: current_a; torque: torque_nm\nstop: full | dynamic max_current_a | regenerative max_current_a\nbrake: engage|release (one-shot, acknowledged)\n--canfd  Send CAN FD frames. --wait-feedback  Wait for control feedback.\nOther modes run continuously. Ctrl+C stops.',
  imu:'show prints acceleration, angular velocity and Euler angles at 50 Hz.\nstart/stop submits a bus-wide forwarding command; an optional ImuId is ignored.',
  battery:'show prints battery state and errors at 50 Hz; clear clears faults.',
  pms:'show prints V48_1..V48_6, V19, V5 and battery data at 50 Hz.\nenable/disable controls V48_1..V48_6.',
  glove:'show prints E0..E9 by F0..F4 at 50 Hz; unavailable encoders show OFF.\nCalibration waits for acknowledgement; failure or timeout exits with code 1.',
  play:'--dry-run                 Preview without connecting to hardware\n--endless                 Repeat forward/backward\n--control-frequency HZ    Integer 1..1000000000 (default 1000)\n--max-speed RAD_S         Positive speed limit (default 20)\n--max-current A           Positive current limit (default 10)\n--kp N --kd N --vel N --tor N  PVT playback; supply all four\n--log[=DIR]               Native motor logs (default ./logs)\n--log-directory DIR       Native motor log directory\nStart ramps to the CSV first point over 2 s. Completion or first Ctrl+C returns\nto the pre-play position over 2 s. Second Ctrl+C exits immediately.\nDry run has no motor logs. Status is plain text; use tui for interactive playback.',
  bench:'--sample-jitter-us N                 Default 1000\n--min-packet-threshold N             Default 50\n--max-drop-count-before-threshold N  Default 5\n--max-drop-rate-after-threshold R    Default 0.1\n--attempts N                        Default 500\n--warmup-ms N                       Default 200\n--periods MS,MS,...                 Default 10,5,3,2,1',
  stress:'--loop-period-ms N    Default 1\n--warmup-delay-ms N   Default 100\n--drain-delay-ms N    Default 200\nPrints periodic status and a final report; Ctrl+C stops.',
  doctor:'Checks runtime, driver and native module availability.\n--request-permissions  Request driver helper permissions.',
 }
 const slaveItems=new Set(['ip','slave','mode','version','reboot','raw','download'])
 if(command==='config'&&positionals.some(v=>slaveItems.has(v))){
  return 'Usage:\n  emcli config <slave-target> <action>\n\nTargets:\n  Ethernet:Interface:SlaveId|UUID (UDP)\n  Ethernet:/dev/ttyACM0 or Ethercat:/dev/ttyACM0 (CDC; Windows: COMx)\n\nActions:\n  ip [get | set 192.168.100.1..253]\n  slave [get | set 0..252]\n  mode [get | set ecat|enet|usb3can|usb8can|sim|simsensors]\n  version [get]\n  reboot\n  raw <single command>\n  download <firmware.upd|firmware.bin|firmware.elf> (CDC only)\n\nWrites save configuration and reboot. Download requires an OTA bootloader,\naccepts UPD packages preserving their version, or packages OTA BIN/ELF at\n0x80041000 with an incremented version, then verifies startup.\n\n--json  Versioned JSON result; firmware progress uses stderr.\n'
 }
 if(!usage[command])return helpText()
 let text='Usage:\n  '+usage[command].replaceAll('\n','\n  ')+'\n\n'+detail[command]+'\n'
 if(command==='config'||command==='control')text+='\nMotor target: Type:Interface:Bus:Id, Type:Interface:Slave:Bus:Id,\nor replace Id with ALL; Type:Interface:ALL selects all motors.\n'
 if(command!=='doctor')text+='\nAdapter options: --plugin-path PATH, --bitrate BPS, --dbitrate BPS,\n--sample-point RATIO, --dsample-point RATIO (0 < RATIO <= 1).\n'
 return text+'\n--json  Versioned JSON result or JSONL samples followed by a final result. Diagnostics use stderr.\n'
}
