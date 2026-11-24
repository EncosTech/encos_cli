#!/usr/bin/env node
// SPDX-License-Identifier: MIT

import {
  jsonMode,
  initJson,
  setJsonResult,
  jsonFinish,
  jsonFailure,
  flushJson,
  runJsonProcess,
} from './json-output.js'
import { fileURLToPath } from 'node:url'
import { parseArgs } from './args.js'
import { commandHelpText, helpText } from './help.js'
import { VERSION } from './version.js'

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv)
  const apiCommand = args.version ? 'version' : args.help ? 'help' : (args.command ?? 'help')

  if (args.flags.has('json') && !jsonMode)
    return runJsonProcess(fileURLToPath(import.meta.url), argv, apiCommand)

  initJson(apiCommand)

  if (jsonMode && args.command === 'tui' && !args.help)
    throw Object.assign(new Error('tui is interactive; use CLI commands with --json'), {
      code: 'EMCLI_INTERACTIVE_COMMAND',
    })

  if (args.version) {
    setJsonResult({ version: VERSION, apiVersion: 1 })

    if (!jsonMode) console.log(VERSION)

    return 0
  }

  if (args.command === undefined && !args.help && process.stdin.isTTY && process.stdout.isTTY) {
    return (await import('./studio/launch.js')).runStudio(args)
  }

  if (args.help || args.command === undefined) {
    const text = args.command ? commandHelpText(args.command, args.positionals) : helpText()

    setJsonResult({ text })

    if (!jsonMode) console.log(text)

    return 0
  }

  switch (args.command) {
    case 'scan':
      return (await import('./commands/scan.js')).runScan(args)

    case 'config':
      return (await import('./commands/config.js')).runConfig(args)

    case 'control':
      return (await import('./commands/control.js')).runControl(args)

    case 'imu':
      return (await import('./commands/imu.js')).runImu(args)

    case 'battery':
      return (await import('./commands/battery.js')).runBattery(args)

    case 'pms':
      return (await import('./commands/pms.js')).runPms(args)

    case 'glove':
      return (await import('./commands/glove.js')).runGlove(args)

    case 'play':
      return (await import('./commands/play.js')).runPlay(args)

    case 'bench':
      return (await import('./commands/bench.js')).runBench(args)

    case 'stress':
      return (await import('./commands/stress.js')).runStress(args)

    case 'doctor':
      return (await import('./commands/doctor.js')).runDoctor(args)

    case 'tui':
      return (await import('./studio/launch.js')).runStudio(args)

    default:
      if (jsonMode)
        throw Object.assign(new Error(`Unknown command: ${args.command}`), {
          code: 'EMCLI_UNKNOWN_COMMAND',
        })
      console.error(`未知命令: ${args.command}`)
      console.error('')
      console.error(helpText())
      return 2
  }
}

async function flushStdout(): Promise<void> {
  await new Promise<void>((resolve) => {
    process.stdout.write('', () => resolve())
  })
}

main(process.argv.slice(2))
  .then(async (code) => {
    if (jsonMode) {
      jsonFinish(code)
      await flushJson()
    }

    await flushStdout()
    // 驱动在部分平台上会 mlockall；Node 正常退出时 V8 释放页可能触发
    // BoundedPageAllocator CHECK。直接 exit 跳过 V8 析构，避免 CLI 崩溃。
    process.exit(code)
  })
  .catch(async (error) => {
    if (jsonMode) {
      jsonFailure(error)
      await flushJson()
      process.exit(1)
    }

    const record = (error ?? {}) as { code?: unknown; detail?: unknown }

    if (typeof record.code === 'string' && record.code.startsWith('EMCLI_')) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`)

      if (process.env.EMCLI_DEBUG === '1' && typeof record.detail === 'string') {
        console.error(record.detail)
      }
    } else if (
      (error as { code?: unknown }).code === 'ERR_MODULE_NOT_FOUND' &&
      error instanceof Error &&
      error.message.includes('@encos/encos-driver-native')
    ) {
      console.error('Error: 缺少运行期驱动包 @encos/encos-driver-native。')
      console.error('请安装 @encos/encos-driver-native 4.3.1。')
    } else {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`)
    }

    if (process.env.EMCLI_DEBUG === '1' && error instanceof Error && error.stack !== undefined) {
      console.error(error.stack)
    }

    await flushStdout()
    process.exit(1)
  })
