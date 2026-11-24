// SPDX-License-Identifier: MIT

export interface ParsedArgs {
  command?: string
  positionals: string[]
  flags: Map<string, string | true>
  help: boolean
  version: boolean
}

/** 只作为开关、不消费下一个参数的选项。 */
const BOOLEAN_FLAGS = new Set([
  'json',
  'demo',
  'wait-feedback',
  'request-permissions',
  'canfd',
  'endless',
  'dry-run',
  'log',
  'stress',
  'slave',
])

const GLOBAL_FLAGS = new Set([
  'json',
  'bitrate',
  'dbitrate',
  'sample-point',
  'dsample-point',
  'plugin-path',
])

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = []
  const flags = new Map<string, string | true>()
  let help = false
  let version = false

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') {
      positionals.push(...argv.slice(index + 1))
      break
    }
    if (arg === '-h' || arg === '--help') {
      help = true
      continue
    }
    if (arg === '-v' || arg === '--version') {
      version = true
      continue
    }
    if (arg.startsWith('--')) {
      const separator = arg.indexOf('=')
      if (separator >= 0) {
        flags.set(arg.slice(2, separator), arg.slice(separator + 1))
        continue
      }
      const name = arg.slice(2)
      const next = argv[index + 1]
      if (!BOOLEAN_FLAGS.has(name) && next !== undefined && (!next.startsWith('-') || /^-\d|^-\.\d/.test(next))) {
        flags.set(name, next)
        index += 1
      } else {
        flags.set(name, true)
      }
      continue
    }
    if (arg.startsWith('-') && arg.length > 1 && !/^-\d|^-\.\d/.test(arg)) {
      flags.set(arg.slice(1), true)
      continue
    }
    positionals.push(arg)
  }

  const [command, ...rest] = positionals
  return { command, positionals: rest, flags, help, version }
}

export function flagString(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name)
  return typeof value === 'string' ? value : undefined
}

export function flagBoolean(args: ParsedArgs, name: string): boolean {
  return args.flags.get(name) === true
}

export function flagInteger(args: ParsedArgs, name: string): number | undefined {
  const value = flagString(args, name)
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) {
    throw new Error(`--${name} 必须是整数，收到 '${value}'`)
  }
  return parsed
}

export function flagNumberValue(args: ParsedArgs, name: string): number | undefined {
  const value = flagString(args, name)
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    throw new Error(`--${name} 必须是数字，收到 '${value}'`)
  }
  return parsed
}

export function rejectUnknownFlags(args: ParsedArgs, allowed: readonly string[] = []): void {
  const allowedSet = new Set([...GLOBAL_FLAGS, ...allowed])
  for (const name of args.flags.keys()) {
    if (!allowedSet.has(name)) {
      throw new Error(`未知选项 --${name}`)
    }
  }
}

export function requirePositionals(
  args: ParsedArgs,
  minimum: number,
  usage: string,
): string[] {
  if (args.positionals.length < minimum) {
    throw new Error(`参数不足。用法: ${usage}`)
  }
  return args.positionals
}
