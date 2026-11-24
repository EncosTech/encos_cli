#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Encos
# SPDX-License-Identifier: MIT
# Assemble/publish a toolchain bundle produced by provision-ci on its native CPU.
set -euo pipefail
arch=${1:?Expected amd64 or arm64}
bundle=${2:?Expected toolchain.tar.gz}
case "$arch" in amd64|arm64) ;; *) echo 'Unsupported architecture' >&2; exit 1;; esac
context=$(mktemp -d)
trap 'rm -rf "$context"' EXIT
cp "$bundle" "$context/toolchain.tar.gz"
cp "$(dirname "$0")/Dockerfile" "$context/Dockerfile"
repo=$(cd "$(dirname "$0")/../../.." && pwd)
python3 - "$context/toolchain.tar.gz" "$arch" "$repo/packages/emcli-native/manifest.json" <<'PY'
import hashlib, json, sys, tarfile
with tarfile.open(sys.argv[1]) as archive:
    manifest = json.load(archive.extractfile('./toolchain.json'))
    for name, digest in manifest['files'].items():
        assert hashlib.sha256(archive.extractfile('./' + name).read()).hexdigest() == digest, name
    assert archive.extractfile('./npmrc').read() == b'@encos:registry=https://git.in.encos.cn/api/packages/packages/npm/\n'
assert manifest['platform'] == 'Linux'
assert manifest['arch'] == {'amd64': 'x64', 'arm64': 'arm64'}[sys.argv[2]]
with open(sys.argv[3]) as driver_manifest:
    assert manifest['driver'] == json.load(driver_manifest)['builtAgainstDriver']
assert manifest['node'] == '24.22.1'
PY
image="git.in.encos.cn/container/ubuntu:emcli-ci-glibc2.28-20261123-v2-$arch"
docker build --platform "linux/$arch" \
  --build-arg "BASE_IMAGE=git.in.encos.cn/container/ubuntu:emd-ci-portable-glibc2.28-20261027-v1-$arch" \
  -t "$image" "$context"
docker push "$image"
