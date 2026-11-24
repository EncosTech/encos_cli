#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Encos
# SPDX-License-Identifier: MIT
"""Offline regression checks for candidate integrity and publication gating."""
import importlib.util
import json
import io
import hashlib
import urllib.error
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import publish
import provision
from package import digest, version
from prepare import DRIVER

spec = importlib.util.spec_from_file_location('gate', Path(__file__).with_name('release-gate.py'))
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        for target in publish.TARGETS:
            folder = self.root / target
            folder.mkdir()
            arch = target.split('-')[1]
            binary = 'emcli-win32-x64.exe' if target.startswith('windows') else 'emcli-linux-' + ('x64' if arch == 'amd64' else 'arm64')
            (folder / binary).write_bytes(b'tested executable')
            (folder / (binary + '.json')).write_text(json.dumps({'sha256': digest(folder / binary), 'arch': 'arm64' if arch == 'arm64' else 'x64', 'platform': 'win32' if target.startswith('windows') else 'linux'}))
            if target.startswith('linux'):
                for extension in ('deb', 'rpm', 'tar.gz'):
                    (folder / f'emcli_{version()}_linux_{arch}.{extension}').write_bytes(b'tested package')
            files = {p.name: digest(p) for p in folder.iterdir()}
            (folder / 'manifest.json').write_text(json.dumps({'schemaVersion': 1, 'target': target, 'version': version(), 'driver': DRIVER, 'source_commit': 'a' * 40, 'source_dirty': False, 'files': files}))
            self.sums(folder)
        self.environment = patch.dict(os.environ, {'GITHUB_SHA': 'a' * 40})
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def sums(self, folder):
        (folder / 'SHA256SUMS').write_text(''.join(f'{digest(p)}  {p.name}\n' for p in sorted(folder.iterdir()) if p.name != 'SHA256SUMS'))

    def change_manifest(self, target, **changes):
        folder = self.root / target
        path = folder / 'manifest.json'
        value = json.loads(path.read_text())
        value.update(changes)
        path.write_text(json.dumps(value))
        self.sums(folder)

    def test_download_credentials_are_scoped_to_gitea_packages(self):
        with patch.dict(os.environ, {'USER_PASSWORD': 'test-only-secret'}):
            private = provision.download_request('https://git.in.encos.cn/api/packages/packages/generic/sdk')
            self.assertTrue(private.get_header('Authorization').startswith('Basic '))
            for url in ('https://nodejs.org/dist/node.tar.gz', 'https://git.in.encos.cn.evil.invalid/api/packages/sdk', 'http://git.in.encos.cn/api/packages/sdk'):
                self.assertIsNone(provision.download_request(url).get_header('Authorization'))

    def test_download_retries_tls_timeout_and_checks_pin_before_installing(self):
        output = self.root / 'download.tar.xz'
        content = b'verified runtime'
        with patch.dict(provision.PINS, {output.name: hashlib.sha256(content).hexdigest()}), \
             patch.object(provision.urllib.request, 'build_opener') as opener, \
             patch.object(provision.time, 'sleep'):
            opener.return_value.open.side_effect = [urllib.error.URLError(TimeoutError('TLS handshake')), io.BytesIO(content)]
            provision.fetch('https://nodejs.org/runtime', output)
            self.assertEqual(output.read_bytes(), content)
            self.assertEqual(opener.return_value.open.call_count, 2)
            self.assertEqual(opener.return_value.open.call_args.kwargs['timeout'], 45)
            self.assertFalse(output.with_name(output.name + '.download').exists())

    def test_download_retry_budget_is_bounded(self):
        output = self.root / 'download.tar.xz'
        with patch.dict(provision.PINS, {output.name: 'unused'}), \
             patch.object(provision.urllib.request, 'build_opener') as opener, \
             patch.object(provision.time, 'sleep'):
            opener.return_value.open.side_effect = TimeoutError('TLS handshake')
            with self.assertRaises(TimeoutError):
                provision.fetch('https://nodejs.org/runtime', output)
            self.assertEqual(opener.return_value.open.call_count, 3)
            self.assertFalse(output.exists())

    def test_bad_checksum_is_not_cached_or_retried(self):
        output = self.root / 'download.tar.xz'
        with patch.dict(provision.PINS, {output.name: hashlib.sha256(b'expected').hexdigest()}), \
             patch.object(provision.urllib.request, 'build_opener') as opener:
            opener.return_value.open.return_value = io.BytesIO(b'corrupt')
            with self.assertRaisesRegex(ValueError, 'Checksum mismatch'):
                provision.fetch('https://nodejs.org/runtime', output)
            self.assertEqual(opener.return_value.open.call_count, 1)
            self.assertFalse(output.exists())
            self.assertFalse(output.with_name(output.name + '.download').exists())

    def test_unpinned_driver_release_is_rejected_before_download(self):
        output = self.root / 'unpublished-driver.tar.gz'
        with patch.object(provision.urllib.request, 'build_opener') as opener:
            with self.assertRaisesRegex(ValueError, 'No reviewed checksum'):
                provision.fetch('https://example.invalid/driver', output)
            opener.assert_not_called()

    def test_previous_driver_candidate_is_rejected(self):
        self.change_manifest('linux-amd64', driver='4.2.0')
        with self.assertRaisesRegex(ValueError, 'identity mismatch'):
            publish.candidates(self.root)

    def test_existing_repository_targets(self):
        plan = publish.candidates(self.root, True)
        endpoints = [endpoint for _, endpoint in plan]
        for endpoint in ['debian/pool/jammy/main/upload', 'debian/pool/noble/main/upload', 'rpm/portable/upload']:
            self.assertEqual(endpoints.count(endpoint), 2)
        self.assertTrue(any('/emcli-win32-x64.exe' in x for x in endpoints))

    def test_tamper_aborts_before_upload(self):
        (self.root / 'linux-arm64/emcli-linux-arm64').write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'Checksum'):
            publish.candidates(self.root)

    def test_missing_windows_aborts(self):
        (self.root / 'windows-amd64/emcli-win32-x64.exe').unlink()
        with self.assertRaises(ValueError):
            publish.candidates(self.root)

    def test_extra_files_rejected(self):
        (self.root / 'linux-amd64/extra').write_text('unexpected')
        with self.assertRaises(ValueError):
            publish.candidates(self.root)

    def test_dirty_source_rejected(self):
        self.change_manifest('linux-amd64', source_dirty=True)
        with self.assertRaisesRegex(ValueError, 'clean'):
            publish.candidates(self.root, True)

    def test_wrong_version_rejected(self):
        self.change_manifest('linux-arm64', version='0.0.0')
        with self.assertRaises(ValueError):
            publish.candidates(self.root)

    def test_wrong_commit_rejected(self):
        self.change_manifest('windows-amd64', source_commit='b' * 40)
        with self.assertRaises(ValueError):
            publish.candidates(self.root)

    def test_duplicate_checksums_rejected(self):
        path = self.root / 'linux-amd64/SHA256SUMS'
        path.write_text(path.read_text() * 2)
        with self.assertRaises(ValueError):
            publish.candidates(self.root)

    def test_manual_release_requires_main_and_opt_in(self):
        self.assertFalse(gate.should_publish('workflow_dispatch', 'refs/heads/main', {}))
        self.assertFalse(gate.should_publish('workflow_dispatch', 'refs/heads/feature', {'inputs': {'publish': True}}))
        self.assertTrue(gate.should_publish('workflow_dispatch', 'refs/heads/main', {'inputs': {'publish': True}}))
        self.assertTrue(gate.should_publish('workflow_dispatch', 'refs/heads/main', {'inputs': {'publish': 'true'}}))
        self.assertFalse(gate.should_publish('workflow_dispatch', 'refs/heads/main', {'inputs': {'publish': 'false'}}))

    def test_pull_requests_never_publish(self):
        self.assertFalse(gate.should_publish('pull_request', 'refs/heads/main', {}))

    def test_push_requires_version_change(self):
        with patch.object(gate.subprocess, 'check_output', return_value=json.dumps({'version': version()})):
            self.assertFalse(gate.should_publish('push', 'refs/heads/main', {'before': 'a' * 40}))
        with patch.object(gate.subprocess, 'check_output', return_value=json.dumps({'version': '1.0.0'})):
            self.assertTrue(gate.should_publish('push', 'refs/heads/main', {'before': 'a' * 40}))
        self.assertFalse(gate.should_publish('push', 'refs/heads/main', {'before': '0' * 40}))


if __name__ == '__main__':
    unittest.main()
