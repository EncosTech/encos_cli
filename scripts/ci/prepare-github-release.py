#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Encos
# SPDX-License-Identifier: MIT
"""Prepare download assets from the tested, versioned Gitea candidates."""
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

from package import checked_version, digest
from publish import TARGETS, candidate_layout, candidates


def download(repository, path):
    auth = os.environ.get('GITEA_RELEASE_AUTH')
    result = subprocess.run([
        'curl', '--fail-with-body', '--silent', '--show-error', '--location',
        '--proto-redir', '=https', '--connect-timeout', '15', '--max-time', '300',
        '--header', '@-', '--output', str(path), f'{repository}/{path.name}',
    ], input=f'Authorization: Basic {auth}\n' if auth else '', text=True)
    if result.returncode:
        raise ValueError(f'Download failed: {path.parent.name}/{path.name}')


def prepare(registry, release, source_commit, destination):
    checked_version(release)
    if not re.fullmatch(r'[a-f0-9]{40}', source_commit):
        raise ValueError('A complete source commit is required')
    assets = []
    with tempfile.TemporaryDirectory(dir=destination.parent) as temporary:
        root = Path(temporary)
        for target in TARGETS:
            folder = root / target
            folder.mkdir()
            binary, packages = candidate_layout(target, release)
            repository = f'{registry}/emcli-{target}/{release}'
            for name in ('manifest.json', 'SHA256SUMS', binary, binary + '.json', *packages):
                download(repository, folder / name)
            assets.extend(folder / name for name in (binary, *packages))

        candidates(root, require_clean=True, release=release, source_commit=source_commit)
        checksums = []
        for path in sorted(assets, key=lambda asset: asset.name):
            checksums.append(f'{digest(path)}  {path.name}\n')
            path.replace(destination / path.name)
        (destination / 'SHA256SUMS').write_text(''.join(checksums), encoding='utf-8')


if __name__ == '__main__':
    try:
        registry, release, source_commit, destination = sys.argv[1:]
        prepare(registry.rstrip('/'), release, source_commit, Path(destination))
    except (KeyError, OSError, TypeError, ValueError) as error:
        print(f'GitHub release preparation aborted: {error}', file=sys.stderr)
        sys.exit(1)
