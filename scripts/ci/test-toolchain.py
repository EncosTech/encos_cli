#!/usr/bin/env python3
"""Behavioral checks for fail-fast, offline-only CI environment selection."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from prepare import validate_toolchain, NODE, DRIVER


class ToolchainTests(unittest.TestCase):
    def fixture(self, root, windows=False):
        files = {}
        node = f'node-v{NODE}-win-x64/node.exe' if windows else f'node-v{NODE}-linux-x64/bin/node'
        headers = f'node-v{NODE}/include/node/node_api.h' if windows else f'node-v{NODE}-linux-x64/include/node/node_api.h'
        for name in [node, headers, 'sdk/usr/include/encos/adapter/base_adapter.h']:
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'prebuilt')
            files[name] = hashlib.sha256(path.read_bytes()).hexdigest()
        for name in ['corepack', 'pnpm-store', 'cache'] + (['python'] if windows else []):
            (root / name).mkdir()
        (root / 'toolchain.json').write_text(json.dumps({'schemaVersion': 1, 'node': NODE, 'driver': DRIVER, 'pnpm': '12.15.0', 'platform': 'Windows' if windows else 'Linux', 'arch': 'x64', 'lockSha256': 'lock', 'files': files}))

    def test_missing_environment_fails_without_attempting_provisioning(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaisesRegex(ValueError, 'provision the base'):
                validate_toolchain(root, 'Linux', 'x64', 'lock')
            self.assertEqual(list(root.iterdir()), [])

    def test_prebuilt_files_are_used_and_mismatches_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.fixture(root)
            config = validate_toolchain(root, 'Linux', 'x64', 'lock')
            self.assertEqual(Path(config['sdk']), root / 'sdk/usr')
            for arch, lock in [('arm64', 'lock'), ('x64', 'changed-lock')]:
                with self.assertRaisesRegex(ValueError, 'rebuild the base'):
                    validate_toolchain(root, 'Linux', arch, lock)
            Path(config['node']).write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
                validate_toolchain(root, 'Linux', 'x64', 'lock')

    def test_windows_uses_matching_headers_and_preinstalled_python(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.fixture(root, windows=True)
            config = validate_toolchain(root, 'Windows', 'x64', 'lock')
            self.assertEqual(Path(config['headers']), root / f'node-v{NODE}/include/node')
            self.assertEqual(Path(config['node']).name, 'node.exe')
            (root / 'python').rmdir()
            with self.assertRaisesRegex(ValueError, 'dependency cache missing: python'):
                validate_toolchain(root, 'Windows', 'x64', 'lock')

    def test_missing_package_store_is_an_error(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.fixture(root)
            (root / 'pnpm-store').rmdir()
            with self.assertRaisesRegex(ValueError, 'dependency cache missing'):
                validate_toolchain(root, 'Linux', 'x64', 'lock')


if __name__ == '__main__':
    unittest.main()
