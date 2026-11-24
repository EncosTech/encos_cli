#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Encos
# SPDX-License-Identifier: MIT
"""Provision a versioned CI base environment; network is allowed only here."""
import base64
import hashlib
import http.client
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import shutil
import tarfile
import time
import urllib.error
import urllib.request
import zipfile

from prepare import DRIVER, NODE, ROOT

PINS = {
    'libencosdriver_4.3.1_linux-glibc2.28_amd64.tar.gz': '533311d07c4b53a706b027cc575be899e0e44c897f468e81c22ebcaf4469560f',
    'libencosdriver_4.3.1_linux-glibc2.28_arm64.tar.gz': '4afa9fdf9fd00be0738f059c16e9e20f03b6a2781215e79b87098f8d0692f517',
    'node-v24.22.1-linux-x64.tar.xz': '6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6',
    'node-v24.22.1-linux-arm64.tar.xz': 'dbabf7a1cbf947e6059ffad2c27b80041db97dea1e553b62afdee7f13fca336e',
    'node-v24.22.1-win-x64.zip': 'd2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5',
    'node-v24.22.1-headers.tar.gz': '322e0a27db9088093ab8347bdc8c7e0aaa21dc9ed548390bf06b394494c09267',
}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def download_request(url):
    headers = {}
    if url.startswith('https://git.in.encos.cn/api/packages/') and os.environ.get('USER_PASSWORD'):
        user = os.environ.get('GITEA_PACKAGE_USER', 'bismarckkk')
        headers['Authorization'] = 'Basic ' + base64.b64encode(f"{user}:{os.environ['USER_PASSWORD']}".encode()).decode()
    return urllib.request.Request(url, headers=headers)


def fetch(url, output):
    expected = PINS.get(output.name)
    if expected is None:
        raise ValueError(f'No reviewed checksum for {output.name}; publish the matching driver and pin its release checksum before provisioning')
    if output.exists() and hashlib.sha256(output.read_bytes()).hexdigest() == expected:
        return
    partial = output.with_name(output.name + '.download')
    try:
        for attempt in range(1, 4):
            print(f'Downloading {output.name} (attempt {attempt}/3)', flush=True)
            try:
                with urllib.request.build_opener(NoRedirect).open(download_request(url), timeout=45) as response, partial.open('wb') as stream:
                    shutil.copyfileobj(response, stream)
            except (OSError, urllib.error.URLError, http.client.IncompleteRead) as error:
                if isinstance(error, urllib.error.HTTPError) and error.code not in (429, 500, 502, 503, 504):
                    raise
                if attempt == 3:
                    raise
                print(f'Download transport failed ({type(error).__name__}); retrying', flush=True)
                time.sleep(attempt)
                continue
            if hashlib.sha256(partial.read_bytes()).hexdigest() != expected:
                raise ValueError('Checksum mismatch: ' + output.name)
            partial.replace(output)
            return
    finally:
        if partial.exists():
            partial.unlink()


def extract(archive, destination):
    destination.mkdir(parents=True, exist_ok=True)
    if archive.suffix == '.zip':
        with zipfile.ZipFile(archive) as package:
            for name in package.namelist():
                if Path(name).is_absolute() or '..' in Path(name).parts:
                    raise ValueError('Unsafe archive member')
            package.extractall(destination)
    else:
        with tarfile.open(archive) as package:
            # Official pinned archives only. Python's data filter rejects escaping links.
            package.extractall(destination, filter='data')


def main():
    windows = platform.system() == 'Windows'
    arch = {'AMD64': 'x64', 'x86_64': 'x64', 'aarch64': 'arm64'}[platform.machine()]
    if windows and arch != 'x64':
        raise ValueError('Only Windows x64 is supported')
    work = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else ROOT / 'build/ci-provision'
    work.mkdir(parents=True, exist_ok=True)
    archive = f'node-v{NODE}-' + (f'win-{arch}.zip' if windows else f'linux-{arch}.tar.xz')
    node_root = work / archive.removesuffix('.zip').removesuffix('.tar.xz')
    cache = Path(os.environ.get('EMCLI_CI_NODE_CACHE', str(work / 'no-node-cache')))
    cached_exe = cache / 'node.exe'
    if windows and cached_exe.is_file() and hashlib.sha256(cached_exe.read_bytes()).hexdigest() == 'd702daa815eabbff763c7d3808e235cf031cf2ca70211b56847bc72f51e240e5':
        # Copy the trusted runner toolchain; corepack must not modify the shared copy.
        shutil.copytree(cache, node_root, dirs_exist_ok=True)
        print('Using checksum-verified cached Windows Node', flush=True)
    else:
        fetch(f'https://nodejs.org/dist/v{NODE}/{archive}', work / archive)
        extract(work / archive, work)
    headers = node_root / 'include/node'
    if windows:
        archive = f'node-v{NODE}-headers.tar.gz'
        fetch(f'https://nodejs.org/dist/v{NODE}/{archive}', work / archive)
        extract(work / archive, work)
        headers = work / f'node-v{NODE}/include/node'
    # Windows uses this matching SDK's headers only; import libraries are generated
    # from the Windows DLLs installed by the integrity-locked npm package.
    sdk_arch = 'amd64' if arch == 'x64' else 'arm64'
    archive = f'libencosdriver_{DRIVER}_linux-glibc2.28_{sdk_arch}.tar.gz'
    fetch(f'https://git.in.encos.cn/api/packages/packages/generic/encos-driver-linux/{DRIVER}/{archive}', work / archive)
    sdk = work / 'sdk'
    if windows:
        # Do not extract Linux symlinks on Windows (no administrator privilege needed).
        with tarfile.open(work / archive) as package:
            for item in package:
                parts = Path(item.name).parts
                if item.isfile() and parts[:3] == ('usr', 'include', 'encos'):
                    target = sdk / item.name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with package.extractfile(item) as source, target.open('wb') as out:
                        shutil.copyfileobj(source, out)
    else:
        extract(work / archive, sdk)
    if not (sdk / 'usr/include/encos').is_dir():
        raise ValueError('SDK headers missing')
    config = '@encos:registry=https://git.in.encos.cn/api/packages/packages/npm/\n'
    if os.environ.get('USER_PASSWORD'):
        config += '//git.in.encos.cn/api/packages/packages/npm/:_auth=${EMCLI_NPM_AUTH}\n'
    (work / 'npmrc').write_text(config)
    node_bin = node_root if windows else node_root / 'bin'
    env = {**os.environ, 'PATH': str(node_bin) + os.pathsep + os.environ['PATH'],
           'COREPACK_HOME': str(work / 'corepack'), 'COREPACK_DEFAULT_TO_LATEST': '0',
           'XDG_CACHE_HOME': str(work / 'cache'),
           'NPM_CONFIG_USERCONFIG': str(work / 'npmrc')}
    if windows:
        env['LOCALAPPDATA'] = str(work / 'cache')
    if os.environ.get('USER_PASSWORD'):
        env['EMCLI_NPM_AUTH'] = base64.b64encode((os.environ.get('GITEA_PACKAGE_USER', 'bismarckkk') + ':' + os.environ['USER_PASSWORD']).encode()).decode()
    def run(command):
        if windows:
            command = ['cmd.exe', '/d', '/c', *command]
        subprocess.run(command, cwd=ROOT, env=env, check=True)
    run(['corepack', 'enable'])
    run(['corepack', 'prepare', 'pnpm@12.15.0', '--activate'])
    # Install also populates pnpm 12's separate supply-chain metadata cache.
    run(['pnpm', 'install', '--frozen-lockfile', '--store-dir', str(work / 'pnpm-store')])
    run(['pnpm', 'install', '--offline', '--frozen-lockfile', '--store-dir', str(work / 'pnpm-store')])
    if windows:
        run(['python', '-m', 'pip', 'install', '--target', str(work / 'python'), 'pywinpty==3.1.2'])
    # Do not retain credentials or redundant compressed downloads in the image.
    (work / 'npmrc').write_text('@encos:registry=https://git.in.encos.cn/api/packages/packages/npm/\n')
    files = [node_root / ('node.exe' if windows else 'bin/node'), headers / 'node_api.h', sdk / 'usr/include/encos/adapter/base_adapter.h']
    (work / 'toolchain.json').write_text(json.dumps({
        'schemaVersion': 1, 'node': NODE, 'driver': DRIVER, 'pnpm': '12.15.0',
        'platform': platform.system(), 'arch': arch,
        'lockSha256': hashlib.sha256((ROOT / 'pnpm-lock.yaml').read_bytes()).hexdigest(),
        'files': {str(path.relative_to(work)).replace('\\', '/'): hashlib.sha256(path.read_bytes()).hexdigest() for path in files},
    }, indent=2) + '\n')
    for name in PINS:
        (work / name).unlink(missing_ok=True)
    print(f'Provisioned Node {NODE}, driver SDK {DRIVER}, pnpm and locked dependencies: {work}')


if __name__ == '__main__':
    main()
