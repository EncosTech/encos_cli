// SPDX-License-Identifier: MIT

import { readdir, stat } from 'node:fs/promises'
import { resolve, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { FileListing } from './protocol.js'

export async function listFiles(
  input: string,
  extensions: readonly string[] = ['.csv'],
): Promise<FileListing> {
  let path = resolve(
    input.startsWith('~/') ? join(homedir(), input.slice(2)) : input || process.cwd(),
  )

  if (!(await stat(path)).isDirectory()) path = dirname(path)

  const entries = await readdir(path, { withFileTypes: true })

  const result = await Promise.all(
    entries.map(async (entry) => {
      let directory = entry.isDirectory()

      if (entry.isSymbolicLink())
        try {
          directory = (await stat(join(path, entry.name))).isDirectory()
        } catch {
          return undefined
        }

      return directory ||
        extensions.some((extension) => entry.name.toLowerCase().endsWith(extension.toLowerCase()))
        ? { name: entry.name, path: join(path, entry.name), directory }
        : undefined
    }),
  )

  return {
    path,
    parent: dirname(path),
    entries: result
      .filter((item): item is NonNullable<typeof item> => Boolean(item))
      .sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name)),
  }
}
