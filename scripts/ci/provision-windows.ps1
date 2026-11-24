# SPDX-FileCopyrightText: 2026 Encos
# SPDX-License-Identifier: MIT
$ErrorActionPreference = 'Stop'
$envFile = Join-Path $env:USERPROFILE 'work/tools/ci-env.cmd'
$lines = & cmd.exe /d /c "`"$envFile`" >nul && set"
if ($LASTEXITCODE -ne 0) { throw 'CI environment initialization failed' }
foreach ($line in $lines) { if ($line -match '^([^=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process') } }
$env:EMCLI_CI_NODE_CACHE = Join-Path $env:USERPROFILE 'work/tools/node-v24.22.1-win-x64'
$root = Join-Path $env:USERPROFILE 'work/tools/emcli-ci/20261123-v2'
& python scripts/ci/provision.py $root
if ($LASTEXITCODE -ne 0) { throw 'Toolchain provisioning failed' }
