#!/usr/bin/env bash
set -euo pipefail
[[ $(getconf GNU_LIBC_VERSION) == 'glibc 2.28' ]] || { echo 'Use the portable glibc 2.28 image' >&2; exit 1; }
python3 scripts/ci/prepare.py
ci_root=${EMCLI_CI_TOOLCHAIN_ROOT:?Use the prebuilt emcli CI image}
ci_arch=$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/')
export PATH="$ci_root/node-v24.22.1-linux-$ci_arch/bin:$PATH"
export NODE_INCLUDE_DIR="$ci_root/node-v24.22.1-linux-$ci_arch/include/node"
export EMCLI_DRIVER_PREFIX="$ci_root/sdk/usr"
export NPM_CONFIG_USERCONFIG="$ci_root/npmrc"
export XDG_CACHE_HOME="$ci_root/cache"
export COREPACK_HOME="$ci_root/corepack"
export COREPACK_ENABLE_NETWORK=0
export COREPACK_DEFAULT_TO_LATEST=0
pnpm install --offline --frozen-lockfile --store-dir "$ci_root/pnpm-store"
pnpm typecheck
pnpm build:single
pnpm test:single
python3 scripts/ci/package.py
