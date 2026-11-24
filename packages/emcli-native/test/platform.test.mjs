// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { selectPlatform } from '../scripts/select-platform.mjs'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))

test('selects Linux x64 glibc package', () => {
  assert.deepEqual(selectPlatform('linux', 'x64', '2.35'), {
    suffix: 'linux-x64-gnu',
    packageName: '@encos/emcli-native-linux-x64-gnu',
    driverPackageName: '@encos/encos-driver-native-linux-x64-gnu',
  })
})

test('selects Linux arm64 package at the minimum glibc', () => {
  assert.equal(selectPlatform('linux', 'arm64', '2.28').suffix, 'linux-arm64-gnu')
})

test('selects Windows x64 package without glibc', () => {
  assert.equal(selectPlatform('win32', 'x64', undefined).suffix, 'win32-x64')
})

test('rejects glibc older than 2.28', () => {
  assert.throws(() => selectPlatform('linux', 'x64', '2.27'), /glibc >= 2\.28/)
})

test('rejects musl / unknown libc', () => {
  assert.throws(() => selectPlatform('linux', 'x64', 'musl'), /glibc >= 2\.28/)
})

test('rejects unsupported platform', () => {
  assert.throws(() => selectPlatform('darwin', 'arm64', undefined), /Unsupported platform/)
})

test('local driver resolver finds the manifest baseline when requested', { skip: process.env.EMCLI_TEST_LOCAL_DRIVER !== '1' }, () => {
  const expected = JSON.parse(readFileSync(join(packageRoot, 'manifest.json'), 'utf8')).builtAgainstDriver
  const output = execFileSync(
    process.execPath,
    [join(packageRoot, 'scripts', 'resolve-driver.mjs'), '--expected', expected, '--json', '--quiet'],
    { encoding: 'utf8' },
  )
  const driver = JSON.parse(output)
  assert.equal(driver.version, expected)
  assert.match(driver.soname, /^libencosdriver\.so\./)
})
