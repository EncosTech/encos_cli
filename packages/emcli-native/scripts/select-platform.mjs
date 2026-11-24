#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// 与 motor_driver/npm-native/src/loader.js 相同的平台选择规则。
// 保持独立实现，避免本包在构建前依赖驱动包。

import process from 'node:process'
import { fileURLToPath } from 'node:url'

export const PLATFORM_PACKAGES = {
  'linux-x64-gnu': '@encos/emcli-native-linux-x64-gnu',
  'linux-arm64-gnu': '@encos/emcli-native-linux-arm64-gnu',
  'win32-x64': '@encos/emcli-native-win32-x64',
}

export function readGlibcVersion() {
  try {
    return process.report.getReport().header.glibcVersionRuntime
  } catch {
    return undefined
  }
}

export function selectPlatform(platform = process.platform, arch = process.arch, glibcVersion) {
  if (platform === 'win32' && arch === 'x64') {
    return {
      suffix: 'win32-x64',
      packageName: PLATFORM_PACKAGES['win32-x64'],
      driverPackageName: '@encos/encos-driver-native-win32-x64',
    }
  }
  if (platform === 'linux' && (arch === 'x64' || arch === 'arm64')) {
    const version = glibcVersion ?? readGlibcVersion()
    if (typeof version !== 'string' || !/^\d+\.\d+/.test(version)) {
      throw new Error('Encos native modules require glibc >= 2.28 on Linux; musl and unknown libc are unsupported.')
    }
    const [major, minor] = version.split('.').map(Number)
    if (major < 2 || (major === 2 && minor < 28)) {
      throw new Error(`Encos native modules require glibc >= 2.28; found ${version}.`)
    }
    const suffix = arch === 'x64' ? 'linux-x64-gnu' : 'linux-arm64-gnu'
    return {
      suffix,
      packageName: PLATFORM_PACKAGES[suffix],
      driverPackageName: `@encos/encos-driver-native-${suffix}`,
    }
  }
  throw new Error(
    `Unsupported platform: ${platform}/${arch}. Supported: Linux glibc x64/arm64, Windows x64.`,
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(selectPlatform(), null, 2))
}
