// SPDX-License-Identifier: MIT
//
// 原生路径解析：驱动平台包、驱动库、加载器、引擎。
//
// 关键点：
// - 驱动平台包必须从“驱动选择器包”的安装位置解析，而不是从本包位置，
//   否则 pnpm 严格布局下可能解析到另一份副本（会破坏单例共享）。
// - SEA 模式完全绕过 node_modules，使用显式 <nativeRoot>。
// - 解析结果只包含绝对路径；运行期不再依赖 cwd 或 import.meta.url。

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { EmcliNativeError } from './errors.js'
import { selectPlatform } from './select-platform.js'
import type {
  DriverPaths,
  LoadOptions,
  NativePaths,
  PlatformManifest,
  ResolveOptions,
} from './types.js'

const DRIVER_SELECTOR = '@encos/encos-driver-native'

/** @internal 当前模块目录；CJS bundle 下回退到 __dirname。 */
function moduleDirectory(): string {
  try {
    return dirname(fileURLToPath(import.meta.url))
  } catch {
    return __dirname
  }
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T
}

function assertFile(file: string, code: 'EMCLI_DRIVER_LIB_MISSING' | 'EMCLI_ENGINE_LIB_MISSING' | 'EMCLI_PLATFORM_PACKAGE_MISSING'): string {
  if (!existsSync(file) || !statSync(file).isFile()) {
    throw new EmcliNativeError(code, `Required native file is missing: ${file}`)
  }
  return realpathSync(file)
}

/** 从 start 开始向上查找 node_modules/<name>，返回真实路径。 */
function findPackageDir(name: string, start: string): string | undefined {
  let dir = resolve(start)
  try {
    if (!statSync(dir).isDirectory()) {
      dir = dirname(dir)
    }
  } catch {
    dir = dirname(dir)
  }
  for (;;) {
    const candidate = join(dir, 'node_modules', ...name.split('/'))
    if (existsSync(join(candidate, 'package.json'))) {
      return realpathSync(candidate)
    }
    const parent = dirname(dir)
    if (parent === dir) {
      return undefined
    }
    dir = parent
  }
}

/** 依次在候选根目录中查找包。 */
function findPackageDirIn(name: string, starts: string[]): string | undefined {
  const seen = new Set<string>()
  for (const start of starts) {
    const found = findPackageDir(name, start)
    if (found !== undefined && !seen.has(found)) {
      seen.add(found)
      return found
    }
  }
  return undefined
}

function appSearchRoots(packageRoot: string): string[] {
  const roots = [packageRoot, process.cwd(), dirname(process.execPath)]
  return [...new Set(roots.map(root => resolve(root)))]
}

function platformLayout(platform: NodeJS.Platform): {
  libDirs: string[]
  addonDirs: string[]
  pluginDirs: string[]
  soname: (major: string) => string[]
  engineName: string
} {
  if (platform === 'win32') {
    return {
      libDirs: ['native', 'runtime/bin', 'runtime/lib'],
      addonDirs: ['native', 'runtime/bin'],
      pluginDirs: ['runtime/lib/encosPlugins', 'runtime/bin/encosPlugins', 'native/encosPlugins'],
      soname: () => ['encosdriver.dll', 'libencosdriver.dll'],
      engineName: 'emcli_perf.dll',
    }
  }
  return {
    libDirs: ['runtime/lib', 'lib', 'native'],
    addonDirs: ['native', 'runtime/bin'],
    pluginDirs: ['runtime/lib/encosPlugins', 'lib/encosPlugins'],
    soname: major => [`libencosdriver.so.${major}`, 'libencosdriver.so'],
    engineName: 'libemcli_perf.so',
  }
}

function locateDriverLib(root: string, version: string, platform: NodeJS.Platform): string {
  const layout = platformLayout(platform)
  const major = version.split('.')[0] ?? '0'
  for (const dir of layout.libDirs) {
    for (const name of layout.soname(major)) {
      const candidate = join(root, dir, name)
      if (existsSync(candidate)) {
        return realpathSync(candidate)
      }
    }
  }
  throw new EmcliNativeError(
    'EMCLI_DRIVER_LIB_MISSING',
    `Cannot find the Encos driver shared library under ${root}. ` +
      `Expected one of: ${layout.libDirs.map(dir => layout.soname(major).map(name => join(dir, name)).join(', ')).join('; ')}.`,
  )
}

function locateFirstFile(root: string, dirs: string[], names: string[]): string | undefined {
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(root, dir, name)
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        return realpathSync(candidate)
      }
    }
  }
  return undefined
}

function locateFirstDir(root: string, dirs: string[]): string | undefined {
  for (const dir of dirs) {
    const candidate = join(root, dir)
    if (existsSync(candidate) && statSync(candidate).isDirectory()) {
      return realpathSync(candidate)
    }
  }
  return undefined
}

function readDriver(root: string, version: string | undefined, platform: NodeJS.Platform): DriverPaths {
  const driverVersion = version ?? readJson<{ version: string }>(join(root, 'package.json')).version
  const libPath = locateDriverLib(root, driverVersion, platform)
  const layout = platformLayout(platform)
  const pluginPath = locateFirstDir(root, layout.pluginDirs) ?? ''
  const addonPath = locateFirstFile(root, layout.addonDirs, ['encosdriver.node']) ?? ''
  return { packageRoot: realpathSync(root), version: driverVersion, libPath, pluginPath, addonPath }
}

function readManifest(platformRoot: string): PlatformManifest {
  const file = join(platformRoot, 'native', 'manifest.json')
  if (!existsSync(file)) {
    throw new EmcliNativeError(
      'EMCLI_PLATFORM_PACKAGE_MISSING',
      `Platform package is missing native/manifest.json: ${platformRoot}`,
    )
  }
  return readJson<PlatformManifest>(file)
}

function verifyDigest(file: string, expected: string): void {
  const actual = createHash('sha256').update(readFileSync(file)).digest('hex')
  if (actual !== expected) {
    throw new EmcliNativeError(
      'EMCLI_ENGINE_LOAD_FAILED',
      `Native file integrity check failed: ${file}`,
      { detail: `expected sha256 ${expected}, got ${actual}` },
    )
  }
}

function verifyManifestFiles(platformRoot: string, manifest: PlatformManifest): void {
  for (const [relative, entry] of Object.entries(manifest.files ?? {})) {
    const file = join(platformRoot, relative)
    if (!existsSync(file)) {
      throw new EmcliNativeError(
        'EMCLI_PLATFORM_PACKAGE_MISSING',
        `Platform package is missing declared native file: ${file}`,
      )
    }
    verifyDigest(file, entry.sha256)
  }
}

function resolveFromNativeRoot(
  nativeRoot: string,
  options: ResolveOptions,
  platform: NodeJS.Platform,
): NativePaths {
  const root = resolve(nativeRoot)
  const perfRoot = join(root, 'perf')
  const driverRoot = join(root, 'driver')
  const manifest = readManifest(perfRoot)
  const loaderPath = assertFile(
    join(perfRoot, 'native', 'emcli_loader.node'),
    'EMCLI_PLATFORM_PACKAGE_MISSING',
  )
  const enginePath = assertFile(
    join(perfRoot, 'native', platformLayout(platform).engineName),
    'EMCLI_ENGINE_LIB_MISSING',
  )
  const driverPkgFile = join(driverRoot, 'package.json')
  const driverVersion = existsSync(driverPkgFile)
    ? readJson<{ version: string }>(driverPkgFile).version
    : manifest.driverVersion
  const driver = readDriver(driverRoot, driverVersion, platform)
  checkVersions(driver, manifest, options)
  if (options.verifyIntegrity === true) {
    verifyManifestFiles(perfRoot, manifest)
  }
  return {
    packageRoot: root,
    loaderPath,
    enginePath,
    manifest,
    driver,
  }
}

function resolveFromNodeModules(
  options: ResolveOptions,
  platform: NodeJS.Platform,
  suffixPlatform: ReturnType<typeof selectPlatform>,
): NativePaths {
  const selfRoot = resolve(moduleDirectory(), '..')
  const platformRoot =
    findPackageDirIn(suffixPlatform.packageName, appSearchRoots(selfRoot)) ??
    (() => {
      throw new EmcliNativeError(
        'EMCLI_PLATFORM_PACKAGE_MISSING',
        `Missing optional native package ${suffixPlatform.packageName}. ` +
          `Reinstall @encos/emcli-native with npm install --include=optional and access to the Encos registry.`,
      )
    })()

  const manifest = readManifest(platformRoot)
  const loaderPath = assertFile(
    join(platformRoot, 'native', 'emcli_loader.node'),
    'EMCLI_PLATFORM_PACKAGE_MISSING',
  )
  const enginePath = assertFile(
    join(platformRoot, 'native', platformLayout(platform).engineName),
    'EMCLI_ENGINE_LIB_MISSING',
  )

  let driver: DriverPaths
  if (options.driverLibPath !== undefined) {
    const libPath = assertFile(resolve(options.driverLibPath), 'EMCLI_DRIVER_LIB_MISSING')
    const packageRoot = options.driverPackageRoot !== undefined
      ? realpathSync(options.driverPackageRoot)
      : dirname(dirname(dirname(libPath)))
    const version = existsSync(join(packageRoot, 'package.json'))
      ? readJson<{ version: string }>(join(packageRoot, 'package.json')).version
      : manifest.driverVersion
    driver = {
      packageRoot,
      version,
      libPath,
      pluginPath: options.pluginPath ?? locateFirstDir(packageRoot, platformLayout(platform).pluginDirs) ?? '',
      addonPath: locateFirstFile(packageRoot, platformLayout(platform).addonDirs, ['encosdriver.node']) ?? '',
    }
  } else if (options.driverPackageRoot !== undefined) {
    driver = readDriver(resolve(options.driverPackageRoot), undefined, platform)
  } else {
    // 从驱动选择器包的安装位置解析平台包。关键：锚点是驱动根目录，
    // 这样 pnpm 的嵌套 optional dependency 也能被找到，且与驱动 JS 运行时一致。
    const driverRoot = findPackageDirIn(DRIVER_SELECTOR, appSearchRoots(selfRoot))
    if (driverRoot === undefined) {
      throw new EmcliNativeError(
        'EMCLI_DRIVER_PACKAGE_MISSING',
        'Missing peer dependency @encos/encos-driver-native. Install it next to the application.',
      )
    }
    const driverRequire = createRequire(join(driverRoot, 'package.json'))
    let platformDriverRoot: string | undefined
    try {
      const entry = driverRequire.resolve(suffixPlatform.driverPackageName)
      platformDriverRoot = packageRootOfEntry(entry)
    } catch {
      platformDriverRoot = findPackageDirIn(suffixPlatform.driverPackageName, [
        driverRoot,
        ...appSearchRoots(selfRoot),
      ])
    }
    if (platformDriverRoot === undefined) {
      throw new EmcliNativeError(
        'EMCLI_DRIVER_PACKAGE_MISSING',
        `Missing optional native package ${suffixPlatform.driverPackageName}. ` +
          'Reinstall @encos/encos-driver-native with npm install --include=optional.',
      )
    }
    driver = readDriver(platformDriverRoot, undefined, platform)
  }

  checkVersions(driver, manifest, options)
  if (options.verifyIntegrity === true) {
    verifyManifestFiles(platformRoot, manifest)
  }
  return {
    packageRoot: platformRoot,
    loaderPath,
    enginePath,
    manifest,
    driver,
  }
}

function packageRootOfEntry(entry: string): string {
  let dir = dirname(realpathSync(entry))
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) {
      return dir
    }
    const parent = dirname(dir)
    if (parent === dir) {
      throw new EmcliNativeError('EMCLI_PLATFORM_PACKAGE_MISSING', `Cannot find package.json for ${entry}`)
    }
    dir = parent
  }
}

function checkVersions(driver: DriverPaths, manifest: PlatformManifest, options: ResolveOptions): void {
  if (driver.version === manifest.driverVersion) {
    return
  }
  if (options.allowDriverVersionMismatch === true) {
    return
  }
  throw new EmcliNativeError(
    'EMCLI_DRIVER_VERSION_MISMATCH',
    `Encos driver version mismatch: @encos/emcli-native was built against ${manifest.driverVersion}, ` +
      `but the resolved driver package is ${driver.version}.`,
    {
      detail:
        `driver package: ${driver.packageRoot}\n` +
        `driver library: ${driver.libPath}\n` +
        'Install the matching driver package, or set allowDriverVersionMismatch for development only.',
    },
  )
}

/**
 * 解析全部原生路径。纯函数，不加载任何原生模块。
 */
export function resolveNativePaths(options: ResolveOptions = {}): NativePaths {
  const platform = options.platform ?? process.platform
  const suffixPlatform = selectPlatform(platform, options.arch ?? process.arch)
  const nativeRoot = options.nativeRoot ?? process.env.EMCLI_NATIVE_ROOT
  if (nativeRoot !== undefined && nativeRoot !== '') {
    return resolveFromNativeRoot(nativeRoot, options, platform)
  }
  return resolveFromNodeModules(options, platform, suffixPlatform)
}

export type { LoadOptions }
