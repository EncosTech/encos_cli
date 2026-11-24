// SPDX-FileCopyrightText: 2026 Encos
// SPDX-License-Identifier: MIT

import { dirname, join, resolve } from 'node:path'
import { mkdirSync, readFileSync, realpathSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

function findPackage(name, start) {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name, 'package.json')

    if (existsSync(candidate)) return realpathSync(candidate)

    if (dirname(dir) === dir) throw new Error(`Cannot find installed ${name}`)
  }
}

const selector = findPackage('@encos/encos-driver-native', 'packages/emcli-native')

const driver = findPackage('@encos/encos-driver-native-win32-x64', dirname(selector))

const pkg = JSON.parse(readFileSync(driver, 'utf8'))
const { builtAgainstDriver } = JSON.parse(
  readFileSync(new URL('../../packages/emcli-native/manifest.json', import.meta.url), 'utf8'),
)

if (pkg.version !== builtAgainstDriver) {
  throw new Error(`Windows driver ${pkg.version} does not match SDK ${builtAgainstDriver}`)
}

const lib = join(process.env.EMCLI_DRIVER_PREFIX, 'lib')

mkdirSync(lib, { recursive: true })

for (const name of ['libencosdriver', 'libencosdriver_base']) {
  const dll = join(dirname(driver), 'native', `${name}.dll`)

  execFileSync('gendef', [dll], { cwd: lib, stdio: 'inherit' })

  execFileSync(
    'dlltool',
    ['-d', join(lib, `${name}.def`), '-D', `${name}.dll`, '-l', join(lib, `${name}.dll.a`)],
    { stdio: 'inherit' },
  )
}
