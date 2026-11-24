# SPDX-License-Identifier: MIT
"""Safe package extraction across distro tarfile security backports."""
import os
import tarfile


def package_data_filter(member, destination):
    if not member.issym():
        return tarfile.data_filter(member, destination)
    # Some Python 3.10 backports validate symlink targets relative to the archive
    # root (correct for hard links), rather than the symlink's parent directory.
    filtered = tarfile.tar_filter(member, destination)
    if os.path.isabs(filtered.linkname):
        raise tarfile.AbsoluteLinkError(filtered)
    root = os.path.realpath(destination)
    target = os.path.realpath(os.path.join(root, os.path.dirname(filtered.name), filtered.linkname))
    if os.path.commonpath([root, target]) != root:
        raise tarfile.LinkOutsideDestinationError(filtered, target)
    return filtered.replace(mode=None, uid=None, gid=None, uname=None, gname=None)
