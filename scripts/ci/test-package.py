#!/usr/bin/env python3
"""Install a Linux candidate in a disposable CI container and exercise the bundled runtime."""
import argparse
import json
import os
import shutil
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
from package import digest
from archive import package_data_filter

parser = argparse.ArgumentParser()
parser.add_argument('directory', type=Path)
parser.add_argument('format', choices=['deb', 'rpm', 'tar.gz'])
args = parser.parse_args()
manifest = json.loads((args.directory / 'manifest.json').read_text())
arch = manifest['target'].split('-', 1)[1]
path = args.directory / f'emcli_{manifest["version"]}_linux_{arch}.{args.format}'
if digest(path) != manifest['files'][path.name]:
    raise ValueError('Package checksum mismatch')
with tempfile.TemporaryDirectory(prefix='emcli-package-') as directory:
    work = Path(directory)
    if args.format == 'tar.gz':
        with tarfile.open(path) as package:
            package.extractall(work, filter=package_data_filter)
        binary = work / 'usr/bin/emcli'
    else:
        if not shutil.which('setcap') or not shutil.which('getcap'):
            raise RuntimeError('CI base image must include libcap tools; rebuild the image')
        subprocess.run(['dpkg', '-i', str(path)] if args.format == 'deb' else ['rpm', '-Uvh', str(path)], check=True)
        binary = Path('/usr/bin/emcli')
    runtime = binary.parent.parent / 'lib/emcli'
    assert (runtime / 'bin/node').is_file(), 'Missing bundled Node'
    assert (runtime / 'app/dist/main.js').is_file(), 'Missing installed application'
    # Installation must authorize the exact files the driver loads. Repeat
    # installation after removing a capability to exercise upgrade restoration.
    if args.format != 'tar.gz':
        helpers = list((runtime / 'modules').glob('*/runtime/lib/encosPlugins/*'))
        expected = {'ThreadPriorityHelper': {'cap_sys_nice'},
                    'EthercatFdBrokerExecutable': {'cap_net_raw', 'cap_net_admin'},
                    'CanFdBrokerExecutable': {'cap_net_raw', 'cap_net_admin'},
                    'EthernetXdpBrokerExecutable': {'cap_net_raw', 'cap_net_admin', 'cap_bpf'}}
        found = {p.name: p for p in helpers if p.name in expected}
        assert set(found) == set(expected), 'Missing authorization helpers'
        def check_caps():
            for name, helper in found.items():
                text = subprocess.check_output(['getcap', str(helper)], universal_newlines=True)
                assert all(cap in text for cap in expected[name]), text
        check_caps()
        subprocess.run(['setcap', '-r', str(found['ThreadPriorityHelper'])], check=True)
        subprocess.run(['dpkg', '-i', str(path)] if args.format == 'deb' else ['rpm', '-Uvh', '--replacepkgs', str(path)], check=True)
        check_caps()
    env = {**os.environ, 'PATH': '', 'NODE_PATH': '', 'NODE_OPTIONS': '', 'EMCLI_SEA_CACHE': str(work / 'cache')}
    for key in ('LD_LIBRARY_PATH', 'EMCLI_PERF_ADDON', 'EMCLI_NATIVE_ROOT', 'ENCOS_PLUGIN_PATH', 'ENCOS_DRIVER_PLUGIN_PATH'):
        env.pop(key, None)
    for command in (['--version'], ['scan', 'Fake:package:0'], ['config', 'Fake:package:0:1', 'position'],
                    ['bench', 'Fake:package:0:1', '--periods', '5', '--attempts', '10', '--warmup-ms', '0']):
        result = subprocess.run([str(binary), *command, '--json'], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True, timeout=45)
        if result.returncode:
            raise RuntimeError(result.stdout + result.stderr)
        final = json.loads(result.stdout.splitlines()[-1])
        if not final['ok']:
            raise ValueError(result.stdout)
        print('PASS', args.format, ' '.join(command))
    assert not (work / 'cache').exists(), 'Installed package unexpectedly extracted a SEA cache'
    subprocess.run([sys.executable, 'scripts/test-single-tui.py', str(binary), '--installed'], check=True)
    if args.format != 'tar.gz':check_caps()
