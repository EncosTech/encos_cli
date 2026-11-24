// SPDX-License-Identifier: MIT

import { EmcliNativeError } from './errors.js'
import type { PlatformSuffix } from './types.js'

export interface PlatformSelection {
  suffix: PlatformSuffix
  packageName: string
  driverPackageName: string
}

const PLATFORM_PACKAGES: Record<PlatformSuffix, string> = {
  'linux-x64-gnu': '@encos/emcli-native-linux-x64-gnu',
  'linux-arm64-gnu': '@encos/emcli-native-linux-arm64-gnu',
  'win32-x64': '@encos/emcli-native-win32-x64',
}

/** @internal 与 motor_driver/npm-native/src/loader.js 的选择规则保持一致。 */
export function selectPlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  glibcVersion: string | undefined = platform === 'linux' ? readGlibcVersion() : undefined,
): PlatformSelection {
  let suffix: PlatformSuffix
  if (platform === 'win32' && arch === 'x64') {
    suffix = 'win32-x64'
  } else if (platform === 'linux' && (arch === 'x64' || arch === 'arm64')) {
    if (typeof glibcVersion !== 'string' || !/^\d+\.\d+/.test(glibcVersion)) {
      throw new EmcliNativeError(
        'EMCLI_PLATFORM_UNSUPPORTED',
        'Encos native modules require glibc >= 2.28 on Linux; musl and unknown libc are unsupported.',
      )
    }
    const [major, minor] = glibcVersion.split('.').map(Number)
    if (major < 2 || (major === 2 && minor < 28)) {
      throw new EmcliNativeError(
        'EMCLI_GLIBC_TOO_OLD',
        `Encos native modules require glibc >= 2.28; found ${glibcVersion}.`,
      )
    }
    suffix = arch === 'x64' ? 'linux-x64-gnu' : 'linux-arm64-gnu'
  } else {
    throw new EmcliNativeError(
      'EMCLI_PLATFORM_UNSUPPORTED',
      `Unsupported platform: ${platform}/${arch}. Supported: Linux glibc x64/arm64, Windows x64.`,
    )
  }

  return {
    suffix,
    packageName: PLATFORM_PACKAGES[suffix],
    driverPackageName: `@encos/encos-driver-native-${suffix}`,
  }
}

function readGlibcVersion(): string | undefined {
  try {
    const report = process.report.getReport() as {
      header?: { glibcVersionRuntime?: string }
    }
    return report.header?.glibcVersionRuntime
  } catch {
    return undefined
  }
}
