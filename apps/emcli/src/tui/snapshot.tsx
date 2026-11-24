// SPDX-License-Identifier: MIT

import { writeFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import React from 'react'
import { render } from 'ink'

import { Gallery } from './gallery-app.js'
import { OverlayProvider } from './overlay.js'

const tab = process.env.EMCLI_GALLERY_TAB ?? 'overview'
process.env.EMCLI_GALLERY_TAB = tab

const chunks: string[] = []

const capture = {
  columns: 120,
  rows: 40,
  isTTY: true,
  write(chunk: string) {
    chunks.push(String(chunk))
    return true
  },
  on() {
    return this
  },
  off() {
    return this
  },
  removeListener() {
    return this
  },
}

const stdin = new Readable({ read() {} }) as Readable & {
  isTTY: boolean
  setRawMode: () => void
}
stdin.isTTY = true
stdin.setRawMode = () => undefined

const stderr = { write() { return true }, isTTY: true }

const instance = render(<OverlayProvider><Gallery /></OverlayProvider>, {
  stdout: capture as never,
  stdin,
  stderr: stderr as never,
  debug: true,
  exitOnCtrlC: false,
  patchConsole: false,
})
await new Promise(resolve => setTimeout(resolve, 500))
instance.unmount()
await new Promise(resolve => setTimeout(resolve, 100))
const raw = chunks.filter(chunk => chunk.length > 1000).at(-1) ?? ''
writeFileSync(`/tmp/gallery-${tab}.ansi`, raw)
const plain = raw
  .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  .replace(/\x1b\][^\x07]*\x07/g, '')
writeFileSync(`/tmp/gallery-${tab}.txt`, plain)
process.exit(0)
