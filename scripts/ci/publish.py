#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Encos
# SPDX-License-Identifier: MIT
"""Validate all three tested candidates, then optionally upload to existing Gitea repositories."""
import argparse
import base64
import json
import os
from pathlib import Path
import re
import sys
import urllib.request
from package import digest, version
from prepare import DRIVER

TARGETS = ('linux-amd64', 'linux-arm64', 'windows-amd64')
BASE = 'https://git.in.encos.cn/api/packages/packages/'


def candidate_layout(target, release):
    if target == 'windows-amd64':
        return 'emcli-win32-x64.exe', ()
    arch = target.split('-')[1]
    binary = 'emcli-linux-' + {'amd64': 'x64', 'arm64': 'arm64'}[arch]
    stem = f'emcli_{release}_linux_{arch}'
    return binary, tuple(stem + extension for extension in ('.deb', '.rpm', '.tar.gz'))


def candidates(root, require_clean=False, *, release=None, source_commit=None):
    plan, commits = [], set()
    if release is None:
        release = version()
    if source_commit is None:
        source_commit = os.environ.get('GITHUB_SHA')
    for target in TARGETS:
        folder = root / target
        for path in folder.iterdir():
            if path.is_symlink() or not path.is_file():
                raise ValueError('Candidate must contain only regular files')
        manifest = json.loads((folder / 'manifest.json').read_text())
        if manifest['schemaVersion'] != 1 or manifest['target'] != target or manifest['version'] != release or manifest['driver'] != DRIVER:
            raise ValueError('Candidate identity mismatch: ' + target)
        commit = manifest['source_commit']
        if not re.fullmatch('[a-f0-9]{40}', commit):
            raise ValueError('Invalid commit provenance')
        commits.add(commit)
        if source_commit and commit != source_commit:
            raise ValueError(f'Candidate belongs to another commit: {target} ({commit}, expected {source_commit})')
        if require_clean and manifest['source_dirty'] is not False:
            raise ValueError('Publishing requires clean source provenance')
        arch = target.split('-')[1]
        binary, packages = candidate_layout(target, release)
        expected = {binary, binary + '.json', *packages}
        if set(manifest['files']) != expected or {p.name for p in folder.iterdir()} != expected | {'manifest.json', 'SHA256SUMS'}:
            raise ValueError('Incomplete or unexpected artifact set: ' + target)
        sums = {}
        for line in (folder / 'SHA256SUMS').read_text().splitlines():
            match = re.fullmatch(r'([a-f0-9]{64})  ([^/\\]+)', line)
            if not match or match[2] in sums:
                raise ValueError('Malformed checksums')
            sums[match[2]] = match[1]
        if set(sums) != expected | {'manifest.json'}:
            raise ValueError('Incomplete checksum coverage')
        for name, checksum in sums.items():
            if digest(folder / name) != checksum or (name in expected and manifest['files'][name] != checksum):
                raise ValueError('Checksum mismatch: ' + name)
        sea = json.loads((folder / (binary + '.json')).read_text())
        if sea['sha256'] != sums[binary] or sea['arch'] != ('arm64' if arch == 'arm64' else 'x64') or sea['platform'] != ('win32' if target.startswith('windows') else 'linux'):
            raise ValueError('SEA metadata mismatch')
        if packages:
            deb, rpm, _ = packages
            for distro in ('jammy', 'noble'):
                plan.append((folder / deb, f'debian/pool/{distro}/main/upload'))
            plan.append((folder / rpm, 'rpm/portable/upload'))
        for path in sorted(folder.iterdir()):
            # Target in the generic package name prevents manifest/checksum collisions.
            plan.append((path, f'generic/emcli-{target}/{release}/{path.name}'))
    if len(commits) != 1:
        raise ValueError('Candidate commits differ')
    return plan


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    parser.add_argument('--publish', action='store_true')
    parser.add_argument('--require-clean', action='store_true')
    args = parser.parse_args()
    plan = candidates(args.directory, args.require_clean or args.publish)
    if not args.publish:
        for path, endpoint in plan:
            print(f'Verified: {path.name} -> {endpoint}')
        return
    # A script invocation alone cannot accidentally publish a PR or feature branch.
    if os.environ.get('GITHUB_REF') != 'refs/heads/main' or os.environ.get('GITHUB_EVENT_NAME') not in ('push', 'workflow_dispatch'):
        raise ValueError('Publishing is restricted to trusted main workflows')
    secret = os.environ.get('USER_PASSWORD')
    if not secret:
        raise ValueError('USER_PASSWORD is required')
    username = os.environ.get('GITEA_PACKAGE_USER', 'bismarckkk')
    auth = base64.b64encode(f'{username}:{secret}'.encode()).decode()
    opener = urllib.request.build_opener(NoRedirect)
    for path, endpoint in plan:
        request = urllib.request.Request(BASE + endpoint, data=path.read_bytes(), method='PUT', headers={
            'Authorization': 'Basic ' + auth, 'Content-Type': 'application/octet-stream'})
        with opener.open(request, timeout=300) as response:
            if response.status not in (200, 201, 204):
                raise ValueError(f'Upload failed: {path.name}, HTTP {response.status}')
        print(f'Published: {path.name} -> {endpoint}')


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError) as error:
        print(f'Publication aborted: {error}', file=sys.stderr)
        sys.exit(1)
