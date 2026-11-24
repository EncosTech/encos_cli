#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Encos
# SPDX-License-Identifier: MIT
"""Package the tested SEA and its matching installed runtime; never rebuild."""
import hashlib
import tarfile
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess

from prepare import DRIVER

ROOT = Path(__file__).resolve().parents[2]


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def checked_version(value):
    if not isinstance(value, str) or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.]+)?', value):
        raise ValueError(f'Unsupported release version: {value}')
    return value


def version(root=ROOT):
    result = checked_version(json.loads((root / 'package.json').read_text())['version'])
    if json.loads((root / 'apps/emcli/package.json').read_text())['version'] != result:
        raise ValueError('Workspace and CLI versions differ')
    return result


def package():
    windows = platform.system() == 'Windows'
    arch = {'AMD64': 'amd64', 'x86_64': 'amd64', 'aarch64': 'arm64'}[platform.machine()]
    target = ('windows-' if windows else 'linux-') + arch
    node_arch = {'amd64': 'x64', 'arm64': 'arm64'}[arch]
    executable = f'emcli-{"win32" if windows else "linux"}-{node_arch}' + ('.exe' if windows else '')
    binary = ROOT / 'dist' / executable
    metadata = json.loads(binary.with_suffix(binary.suffix + '.json').read_text())
    if metadata['sha256'] != digest(binary) or metadata['arch'] != node_arch or metadata['platform'] != ('win32' if windows else 'linux'):
        raise ValueError('SEA executable differs from build metadata')
    release = version()
    output = ROOT / 'dist/artifacts' / target
    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True)
    shutil.copy2(binary, output / executable)
    shutil.copy2(binary.with_suffix(binary.suffix + '.json'), output / (executable + '.json'))
    if not windows:
        work = ROOT / 'build/package' / target
        if work.exists():
            shutil.rmtree(work)
        stage = work / 'stage'
        (stage / 'usr/bin').mkdir(parents=True)
        runtime = metadata['runtime']
        archive = ROOT / 'dist' / runtime['file']
        if digest(archive) != runtime['sha256'] or runtime['assetId'] != metadata['assetId']:
            raise ValueError('Installed runtime differs from SEA build metadata')
        runtime_root = stage / 'usr/lib/emcli'
        runtime_root.mkdir(parents=True)
        with tarfile.open(archive) as bundle:
            bundle.extractall(runtime_root)
        shutil.copy2(ROOT / 'scripts/packaging/emcli.sh', stage / 'usr/bin/emcli')
        (stage / 'usr/bin/emcli').chmod(0o755)
        rules = stage / 'etc/udev/rules.d'
        rules.mkdir(parents=True)
        shutil.copy2(ROOT / 'scripts/packaging/70-encos-cdc.rules', rules)
        documentation = stage / 'usr/share/doc/emcli'
        documentation.mkdir(parents=True)
        shutil.copy2(ROOT / 'LICENSE', documentation / 'copyright')
        hooks = work / 'control'
        hooks.mkdir()
        for name in ['postinst', 'postrm']:
            source = 'authorize-helpers.sh' if name == 'postinst' else 'reload-udev.sh'
            shutil.copy2(ROOT / 'scripts/packaging' / source, hooks / name)
            (hooks / name).chmod(0o755)
        (hooks / 'conffiles').write_text('/etc/udev/rules.d/70-encos-cdc.rules\n')
        # Tilde sorts prereleases before the final version in both dpkg and RPM.
        package_version = release.replace('-', '~', 1)
        config = work / 'CPackConfig.cmake'
        config.write_text(f'''
set(CPACK_GENERATOR "TGZ;DEB;RPM")
set(CPACK_PACKAGE_NAME "emcli")
set(CPACK_PACKAGE_VERSION "{package_version}")
set(CPACK_PACKAGE_CONTACT "Encos <Sales002@encos.cn>")
set(CPACK_PACKAGE_VENDOR "Encos")
set(CPACK_PACKAGE_DESCRIPTION_SUMMARY "Encos motor CLI and terminal UI")
set(CPACK_PACKAGE_DESCRIPTION "Self-contained terminal UI and command-line motor diagnostics")
set(CPACK_PACKAGE_FILE_NAME "emcli_{release}_linux_{arch}")
set(CPACK_PACKAGE_DIRECTORY "{output}")
set(CPACK_INSTALLED_DIRECTORIES "{stage};/")
set(CPACK_PACKAGING_INSTALL_PREFIX "/")
set(CPACK_INCLUDE_TOPLEVEL_DIRECTORY OFF)
set(CPACK_DEBIAN_PACKAGE_ARCHITECTURE "{arch}")
set(CPACK_DEBIAN_PACKAGE_DEPENDS "libc6 (>= 2.28), libstdc++6 (>= 8), libgcc-s1 | libgcc1, libcap2-bin")
set(CPACK_DEBIAN_PACKAGE_CONTROL_EXTRA "{hooks}/postinst;{hooks}/postrm;{hooks}/conffiles")
set(CPACK_DEBIAN_PACKAGE_CONTROL_STRICT_PERMISSION TRUE)
set(CPACK_RPM_PACKAGE_ARCHITECTURE "{'x86_64' if arch == 'amd64' else 'aarch64'}")
set(CPACK_RPM_PACKAGE_RELEASE "1")
set(CPACK_RPM_PACKAGE_LICENSE "MIT")
set(CPACK_RPM_PACKAGE_AUTOREQPROV OFF)
set(CPACK_RPM_SPEC_MORE_DEFINE "%define __os_install_post %{{nil}}\\n%define _build_id_links none")
set(CPACK_RPM_PACKAGE_REQUIRES "glibc >= 2.28, libstdc++ >= 8, libgcc, libcap")
set(CPACK_RPM_POST_INSTALL_SCRIPT_FILE "{hooks}/postinst")
set(CPACK_RPM_POST_UNINSTALL_SCRIPT_FILE "{hooks}/postrm")
set(CPACK_RPM_USER_FILELIST "%config(noreplace) /etc/udev/rules.d/70-encos-cdc.rules")
''')
        subprocess.run(['cpack', '--config', str(config)], cwd=work, check=True)
        # CPack puts temporary trees beneath the package directory.
        shutil.rmtree(output / '_CPack_Packages', ignore_errors=True)
    files = {p.name: digest(p) for p in sorted(output.iterdir())}
    manifest = {
        'schemaVersion': 1, 'target': target, 'version': release,
        'source_commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
        'source_dirty': bool(subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=normal'], cwd=ROOT, text=True).strip()),
        'node': metadata['nodeVersion'], 'driver': DRIVER, 'files': files,
    }
    (output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    (output / 'SHA256SUMS').write_text(''.join(f'{digest(p)}  {p.name}\n' for p in sorted(output.iterdir()) if p.is_file()))
    print(f'Packaged {target}: {output}')


if __name__ == '__main__':
    package()
