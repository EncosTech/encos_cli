#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
import io
from pathlib import Path
import tarfile
import tempfile
import unittest
from archive import package_data_filter


class ArchiveTests(unittest.TestCase):
    def extract(self, entries, destination):
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode='w') as archive:
            for name, target in entries:
                member = tarfile.TarInfo(name)
                if target is None:
                    member.size = 2
                    archive.addfile(member, io.BytesIO(b'ok'))
                else:
                    member.type = tarfile.SYMTYPE
                    member.linkname = target
                    archive.addfile(member)
        stream.seek(0)
        with tarfile.open(fileobj=stream) as archive:
            archive.extractall(destination, filter=package_data_filter)

    def test_nested_runtime_links_are_relative_to_their_parent(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.extract([
                ('usr/lib/emcli/app/node_modules/@encos/native', '../../../modules/native'),
                ('usr/lib/emcli/modules/native/index.js', None),
            ], root)
            self.assertEqual((root / 'usr/lib/emcli/app/node_modules/@encos/native/index.js').read_bytes(), b'ok')

    def test_absolute_and_escaping_links_are_rejected(self):
        for target in ['/etc', '../../outside']:
            with self.subTest(target=target), tempfile.TemporaryDirectory() as directory:
                with self.assertRaises(tarfile.FilterError):
                    self.extract([('folder/link', target)], directory)

    def test_existing_symlink_cannot_redirect_extraction_outside(self):
        with tempfile.TemporaryDirectory() as directory, tempfile.TemporaryDirectory() as outside:
            root = Path(directory)
            (root / 'escape').symlink_to(outside, target_is_directory=True)
            with self.assertRaises(tarfile.FilterError):
                self.extract([('nested/link', '../escape')], root)
            self.assertEqual(list(Path(outside).iterdir()), [])


if __name__ == '__main__':
    unittest.main()
