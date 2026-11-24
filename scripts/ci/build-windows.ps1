# SPDX-FileCopyrightText: 2026 Encos
# SPDX-License-Identifier: MIT
$ErrorActionPreference = 'Stop'
# Import the existing CI toolchain without modifying the shared host environment.
$envFile = Join-Path $env:USERPROFILE 'work/tools/ci-env.cmd'
$lines = & cmd.exe /d /c "`"$envFile`" >nul && set"
if ($LASTEXITCODE -ne 0) { throw 'CI environment initialization failed' }
foreach ($line in $lines) { if ($line -match '^([^=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process') } }
function Run($command, [string[]]$arguments) {
    & $command @arguments
    if ($LASTEXITCODE -ne 0) { throw "$command failed with exit code $LASTEXITCODE" }
}
$env:EMCLI_CI_TOOLCHAIN_ROOT = Join-Path $env:USERPROFILE 'work/tools/emcli-ci/20261123-v2'
Run python @('scripts/ci/prepare.py')
$config = Get-Content build/ci/environment.json -Raw | ConvertFrom-Json
$env:PATH = (Split-Path $config.node) + ';' + $env:PATH
$env:NODE_INCLUDE_DIR = $config.headers
$env:EMCLI_DRIVER_PREFIX = $config.sdk
$env:NPM_CONFIG_USERCONFIG = $config.npmrc
$env:PYTHONIOENCODING = 'utf-8'
$env:COREPACK_HOME = $config.corepack
$env:COREPACK_ENABLE_NETWORK = '0'
$env:COREPACK_DEFAULT_TO_LATEST = '0'
$env:PYTHONPATH = $config.python
$env:XDG_CACHE_HOME = $config.cache
$env:LOCALAPPDATA = $config.cache
Run python @('-c', "import importlib.metadata; assert importlib.metadata.version('pywinpty') == '3.1.2'")
Run pnpm.cmd @('install', '--offline', '--frozen-lockfile', '--store-dir', $config.store)
Run node @('scripts/ci/windows-imports.mjs')
Run pnpm.cmd @('typecheck')
Run pnpm.cmd @('build:single')
Run pnpm.cmd @('test:single')
Run python @('scripts/ci/package.py')
