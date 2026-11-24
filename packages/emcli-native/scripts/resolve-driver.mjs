#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// 构建期解析本地 encos_driver SDK。
//
// 约束：
// - 只查找本地安装 / 本地构建树，不联网下载。
// - 版本必须与 manifest.builtAgainstDriver（或 --expected）完全一致。
// - 输出 JSON 供 CMake / 打包脚本使用。
//
// 用法：
//   node scripts/resolve-driver.mjs --expected 4.1.2 --out build/driver.json
//   EMCLI_DRIVER_CMAKE_DIR=/usr/local/lib/cmake/encos_driver node scripts/resolve-driver.mjs

import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(scriptDir, '..')
const repositoryRoot = resolve(packageRoot, '../../..')

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function parseArgs(argv) {
  const values = {
    expected: undefined,
    out: undefined,
    driverDir: undefined,
    prefix: undefined,
    allowMismatch: false,
    json: false,
    quiet: false,
    platform: process.platform,
    arch: process.arch,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--expected') values.expected = argv[++index]
    else if (arg === '--out') values.out = argv[++index]
    else if (arg === '--driver-dir') values.driverDir = argv[++index]
    else if (arg === '--prefix') values.prefix = argv[++index]
    else if (arg === '--allow-mismatch') values.allowMismatch = true
    else if (arg === '--platform') values.platform = argv[++index]
    else if (arg === '--arch') values.arch = argv[++index]
    else if (arg === '--json') values.json = true
    else if (arg === '--quiet') values.quiet = true
    else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: node scripts/resolve-driver.mjs [options]

  --expected <version>   Expected encos_driver version (default: manifest.builtAgainstDriver)
  --driver-dir <dir>     Directory containing encos_driverConfig.cmake
  --prefix <dir>         Install prefix (expects <prefix>/lib/cmake/encos_driver)
  --allow-mismatch       Allow a different local version (development only)
  --platform <name>      Target platform (default: host; used for library layout)
  --arch <name>          Target arch (default: host)
  --out <file>           Write JSON result to this file
  --json                 Print JSON to stdout
  --quiet                Only print errors`)
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return values
}

function manifestExpectedVersion() {
  try {
    return readJson(join(packageRoot, 'manifest.json')).builtAgainstDriver
  } catch {
    return undefined
  }
}

function cmakeCandidates(options) {
  const candidates = []
  const add = value => {
    if (typeof value === 'string' && value.trim() !== '') {
      candidates.push(resolve(value))
    }
  }

  add(options.driverDir)
  add(process.env.EMCLI_DRIVER_CMAKE_DIR)
  if (options.prefix) add(join(options.prefix, 'lib', 'cmake', 'encos_driver'))
  if (process.env.EMCLI_DRIVER_PREFIX) add(join(process.env.EMCLI_DRIVER_PREFIX, 'lib', 'cmake', 'encos_driver'))
  if (process.env.ENCOS_DRIVER_ROOT) {
    add(join(process.env.ENCOS_DRIVER_ROOT, 'lib', 'cmake', 'encos_driver'))
    add(join(process.env.ENCOS_DRIVER_ROOT, 'lib64', 'cmake', 'encos_driver'))
  }
  const pathSeparator = options.platform === 'win32' ? ';' : ':'
  for (const prefix of (process.env.CMAKE_PREFIX_PATH ?? '').split(pathSeparator)) {
    add(join(prefix, 'lib', 'cmake', 'encos_driver'))
  }
  for (const prefix of ['/usr/local', '/usr', '/opt/encos', '/opt/encos-driver']) {
    add(join(prefix, 'lib', 'cmake', 'encos_driver'))
    add(join(prefix, 'lib64', 'cmake', 'encos_driver'))
  }

  // 开发用：仓库同级的 motor_driver 构建树。
  const sibling = join(repositoryRoot, '..', 'motor_driver')
  add(join(sibling, 'build', 'lib', 'cmake', 'encos_driver'))
  add(join(sibling, 'build'))
  for (const name of safeReaddir(sibling)) {
    if (name === 'build' || name.startsWith('build-')) {
      add(join(sibling, name, 'lib', 'cmake', 'encos_driver'))
      add(join(sibling, name))
    }
  }

  return [...new Set(candidates)]
}

function safeReaddir(directory) {
  try {
    return readdirSync(directory)
  } catch {
    return []
  }
}

function readCmakeVersion(cmakeDir) {
  const versionFile = join(cmakeDir, 'encos_driverConfigVersion.cmake')
  if (!existsSync(versionFile)) return undefined
  const match = readFileSync(versionFile, 'utf8').match(/set\(PACKAGE_VERSION\s+"([^"]+)"\)/)
  return match?.[1]
}

function prefixOf(cmakeDir) {
  // 安装布局：<prefix>/lib/cmake/encos_driver；构建树：<build>/encos_driverConfig.cmake
  if (basename(cmakeDir) === 'encos_driver' && basename(dirname(cmakeDir)) === 'cmake') {
    return resolve(cmakeDir, '../../..')
  }
  return cmakeDir
}

function findHeader(prefix, cmakeDir) {
  const candidates = [
    join(prefix, 'include', 'encos', 'encos_driver.h'),
    join(prefix, 'include', 'encos', 'encos', 'encos_driver.h'),
    join(prefix, '..', 'include', 'encos', 'encos_driver.h'),
    join(cmakeDir, '..', '..', 'include', 'encos', 'encos_driver.h'),
    join(cmakeDir, '..', 'include', 'encos', 'encos_driver.h'),
  ]
  for (const file of candidates) {
    if (existsSync(file)) return realpathSync(file)
  }
  return undefined
}

function versionedLibrary(dir, base, version) {
  const major = version.split('.')[0] ?? '0'
  const candidates = [
    join(dir, `${base}.so.${major}`),
    join(dir, `${base}.so.${version}`),
    join(dir, `${base}.so`),
    join(dir, `${base}.dylib`),
  ]
  for (const file of candidates) {
    if (existsSync(file) && statSync(file).isFile()) return realpathSync(file)
  }
  return undefined
}

function findLibrary(prefix, cmakeDir, version, platform) {
  const dirs = [
    join(prefix, 'lib'),
    join(prefix, 'lib64'),
    join(prefix, 'bin'),
    cmakeDir,
    join(cmakeDir, 'lib'),
  ]
  if (platform === 'win32') {
    for (const dir of dirs) {
      for (const name of ['encosdriver.lib', 'libencosdriver.dll.a', 'libencosdriver.a']) {
        const file = join(dir, name)
        if (existsSync(file)) return { libPath: realpathSync(file), libDir: dir, soname: 'encosdriver.dll' }
      }
    }
    for (const dir of dirs) {
      const file = join(dir, 'encosdriver.dll')
      if (existsSync(file)) return { libPath: realpathSync(file), libDir: dir, soname: 'encosdriver.dll' }
    }
    return {}
  }
  for (const dir of dirs) {
    const libPath = versionedLibrary(dir, 'libencosdriver', version)
    if (libPath !== undefined) {
      return { libPath, libDir: dir, soname: `libencosdriver.so.${version.split('.')[0]}` }
    }
  }
  return {}
}

function findPluginDir(prefix, cmakeDir) {
  for (const dir of [
    join(prefix, 'lib', 'encosPlugins'),
    join(prefix, 'lib64', 'encosPlugins'),
    join(cmakeDir, 'encosPlugins'),
    join(prefix, 'encosPlugins'),
  ]) {
    if (existsSync(dir) && statSync(dir).isDirectory()) return realpathSync(dir)
  }
  return ''
}

function includeDirsFor(header, prefix) {
  const includeDir = dirname(dirname(header))
  return [...new Set([includeDir, dirname(includeDir), join(prefix, 'include')])].filter(existsSync)
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const expected = options.expected ?? process.env.EMCLI_EXPECTED_DRIVER_VERSION ?? manifestExpectedVersion()
  if (!expected) {
    throw new Error('Missing expected driver version; pass --expected or set EMCLI_EXPECTED_DRIVER_VERSION.')
  }
  if (!/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(expected)) {
    throw new Error(`Invalid expected version: ${expected}`)
  }

  const rejected = []
  for (const cmakeDir of cmakeCandidates(options)) {
    const configFile = join(cmakeDir, 'encos_driverConfig.cmake')
    if (!existsSync(configFile)) continue
    const version = readCmakeVersion(cmakeDir)
    if (!version) {
      rejected.push(`${cmakeDir}: missing PACKAGE_VERSION`)
      continue
    }
    if (version !== expected && !options.allowMismatch) {
      rejected.push(`${cmakeDir}: version ${version} != ${expected}`)
      continue
    }
    const prefix = prefixOf(cmakeDir)
    const header = findHeader(prefix, cmakeDir)
    if (!header) {
      rejected.push(`${cmakeDir}: encos_driver headers not found (prefix ${prefix})`)
      continue
    }
    const library = findLibrary(prefix, cmakeDir, version, options.platform)
    if (!library.libPath) {
      rejected.push(`${cmakeDir}: libencosdriver not found (prefix ${prefix})`)
      continue
    }
    const result = {
      schema: 1,
      expectedVersion: expected,
      version,
      cmakeDir: realpathSync(cmakeDir),
      prefix,
      includeDirs: includeDirsFor(header, prefix),
      header,
      libDir: library.libDir,
      libPath: library.libPath,
      soname: library.soname,
      pluginDir: findPluginDir(prefix, cmakeDir),
      platform: options.platform,
      arch: options.arch,
      allowMismatch: version !== expected,
    }
    const text = JSON.stringify(result, null, 2)
    if (options.out) {
      mkdirSync(dirname(resolve(options.out)), { recursive: true })
      writeFileSync(resolve(options.out), `${text}\n`)
    }
    if (options.json || !options.out) {
      console.log(text)
    } else if (!options.quiet) {
      console.log(`encos_driver ${version} -> ${result.libPath}`)
    }
    return
  }

  const detail = rejected.length > 0 ? `\nCandidates rejected:\n  ${rejected.join('\n  ')}` : ''
  throw new Error(
    `Cannot find a local encos_driver ${expected} SDK. ` +
      `Set EMCLI_DRIVER_CMAKE_DIR=<dir containing encos_driverConfig.cmake> or install the matching libencosdriver package.${detail}`,
  )
}

try {
  main()
} catch (error) {
  console.error(`resolve-driver: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
