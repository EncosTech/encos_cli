"""Windows SEA verification. Requires pywinpty in the test runner, not the product."""
import json, os, re, shutil, subprocess, sys, tempfile, threading, time
from pathlib import Path
from winpty import PtyProcess

expected_version = json.loads((Path(__file__).resolve().parents[1] / 'package.json').read_text())['version']

binary_source = Path(sys.argv[1] if len(sys.argv) > 1 else 'dist/emcli-win32-x64.exe').resolve()
ansi = re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)')
results = []

def records(text):
    clean = ansi.sub('', text).replace('\r', '')
    rows = [json.loads(line) for line in clean.splitlines() if line.strip()]
    assert rows and all(row['schemaVersion'] == 1 for row in rows), clean
    return rows

with tempfile.TemporaryDirectory(prefix='emcli Windows ', ignore_cleanup_errors=True) as temporary:
    root = Path(temporary) / '中文 space'
    root.mkdir()
    binary = root / 'emcli.exe'
    shutil.copy2(binary_source, binary)
    env = {k: v for k, v in os.environ.items() if k.upper() not in
           ('PATH', 'NODE_PATH', 'NODE_OPTIONS', 'EMCLI_PERF_ADDON', 'EMCLI_NATIVE_ROOT',
            'EMCLI_JSON_WORKER', 'EMCLI_STUDIO_OPTIONS', 'LD_LIBRARY_PATH')}
    env.update(CI='true', PATH='', NODE_PATH='', NODE_OPTIONS='', EMCLI_SEA_CACHE=str(root / 'cache'))

    def one(args, expected=0, timeout=30):
        started = time.monotonic()
        result = subprocess.run([str(binary), *args, '--json'], cwd=root, env=env,
                                capture_output=True, encoding='utf8', errors='replace', timeout=timeout)
        elapsed = time.monotonic() - started

        rows = records(result.stdout)
        assert result.returncode == expected, (args, result.returncode, result.stdout, result.stderr)
        assert rows[-1]['type'] != 'sample' and rows[-1]['ok'] == (expected == 0), rows
        results.append({'command': args, 'ok': True, 'exitCode': result.returncode,
                        'elapsedSeconds': round(elapsed, 3), 'timeoutSeconds': timeout})
        print('PASS', ' '.join(args), f'({elapsed:.2f}s, timeout {timeout}s)', flush=True)
        return rows[-1]

    def console(args, tui=False):
        proc = PtyProcess.spawn([str(binary), *args, *([] if tui else ['--json'])],
                                cwd=str(root), env=env, dimensions=(40, 150 if tui else 4000))
        chunks = []
        def read():
            try:
                while True:
                    chunks.append(proc.read(65536))
            except EOFError:
                pass
        reader = threading.Thread(target=read, daemon=True)
        reader.start()
        try:
            # The demo starts a separate driver process before it discovers motors.
            startup_timeout = 120 if tui else 30
            deadline = time.monotonic() + startup_timeout
            while time.monotonic() < deadline:
                text = ansi.sub('', ''.join(chunks))
                if ('Motor 1' in text if tui else '"type":"sample"' in text):
                    break
                assert proc.isalive(), text
                time.sleep(.05)
            else:
                raise AssertionError(f'No initial output after {startup_timeout}s for {args}: {text[-12000:]}')
            stopped = time.monotonic()
            proc.write('\x03')
            if tui:
                time.sleep(.5)
                proc.write('\x03')
            while proc.isalive() and time.monotonic() - stopped < 15:
                time.sleep(.05)
            assert not proc.isalive(), 'Failed to stop: ' + str(args)
            reader.join(3)
            text = ''.join(chunks)
            assert proc.exitstatus == 0, (args, proc.exitstatus, text[-5000:])
            if tui:
                assert 'Devices' in ansi.sub('', text)
            else:
                rows = records(text)
                assert len(rows) > 1 and rows[-1]['type'] == 'result' and rows[-1]['ok'], rows
                if args[0] == 'play':
                    assert time.monotonic() - stopped >= 1.8, 'Missing smooth return'
            results.append({'command': args, 'ok': True, 'console': True})
            print('PASS console', ' '.join(args), flush=True)
        finally:
            if proc.isalive():
                proc.terminate(force=True)
            proc.close(force=True)

    for attempt in range(2):
        # The first launch extracts the embedded runtime into an empty cache.
        # Keep the normal deadline for the warm launch and all other commands.
        result = one(['--version'], timeout=120 if attempt == 0 else 30)['data']
        assert result['apiVersion'] == 1
        assert result['version'] == expected_version
    for cmd in ['scan', 'config', 'control', 'imu', 'battery', 'pms', 'glove', 'bench', 'stress', 'play', 'doctor', 'tui']:
        one([cmd, '--help'])
    one(['not-a-command'], expected=1)
    one(['scan', 'Fake:windows:0'])
    one(['config', 'Fake:windows:0:1', 'position'])
    position = one(['config', 'Fake:windows:0:1', 'position', 'set', '12.5'])
    assert abs(position['data']['results'][0]['value']['positionDeg'] - 12.5) < .01
    one(['config', 'Fake:windows:0:1', 'pvt-kp-range'])
    one(['config', 'Fake:windows:0:1', 'cur-pi', 'set', '1', '2'])
    one(['control', 'brake', 'Fake:windows:0:1', 'engage'])
    for mode, values in [('pvt', ['1', '1', '0', '0', '0']), ('position', ['10', '20', '1']),
                         ('speed', ['1', '1']), ('current', ['1']), ('torque', ['0.1']), ('stop', ['full'])]:
        console(['control', mode, 'Fake:windows:0:1', *values])
    for cmd, target in [('imu', 'Fake:windows:0:1'), ('battery', 'Fake:windows:0:1'),
                        ('pms', 'Fake:windows:0'), ('glove', 'Fake:windows:0')]:
        console([cmd, 'show', target])
    for cmd, action, target in [('imu', 'start', 'Fake:windows:0'), ('imu', 'stop', 'Fake:windows:0'),
                                ('battery', 'clear', 'Fake:windows:0:1')]:
        one([cmd, action, target])
    for action in ['enable', 'disable']:
        one(['pms', action, 'Fake:windows:0', 'V48_1'])
    calibration = one(['glove', 'calibrate', 'Fake:windows:0', 'all'], expected=1)
    assert calibration['data']['message'] == 'Calibration timed out'
    bench = one(['bench', 'Fake:windows:0:1', '--periods', '5', '--attempts', '10', '--warmup-ms', '0'])
    assert bench['data']['reports']
    console(['stress', 'Fake:windows:0:1', '--warmup-delay-ms', '0'])
    csv = root / 'trajectory.csv'
    csv.write_text('time,Fake:windows:0:1\n0,0\n0.1,5\n', encoding='utf8')
    console(['play', str(csv), '--endless', '--control-frequency', '20', '--log=' + str(root / 'logs')])
    assert list((root / 'logs').glob('*')), 'Missing native motor logs'
    console(['tui', '--demo'], tui=True)
    # Junctions must point at published cache paths, never at the removed staging directory.
    for manifest in (root / 'cache').glob('*/app/package.json'):
        assert (manifest.parent / 'node_modules' / 'ink' / 'package.json').is_file()

Path('dist/windows-test-results.json').write_text(json.dumps(results, indent=2), encoding='utf8')
print(f'Windows single executable: {len(results)} cases passed; empty PATH, Chinese/space paths, cold/warm cache, console Ctrl+C and TUI.', flush=True)
