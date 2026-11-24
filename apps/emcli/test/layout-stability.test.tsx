import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'
import React from 'react'
import { render, cleanup } from 'ink-testing-library'
import { Gallery } from '../src/tui/gallery-app.js'
import { OverlayProvider } from '../src/tui/overlay.js'
afterEach(cleanup)
test('data gallery settles after resize without alternating widths or phantom scrollbars', async () => {
  process.env.EMCLI_GALLERY_TAB = 'data'
  const app = render(<OverlayProvider><Gallery /></OverlayProvider>)
  delete process.env.EMCLI_GALLERY_TAB
  for (const columns of [220, 221, 224, 200, 180, 120, 100]) {
    Object.defineProperties(app.stdout, { columns: { value: columns, configurable: true }, rows: { value: 54, configurable: true } })
    app.stdout.emit('resize')
    app.stdin.write('\t')
    await new Promise(resolve => setTimeout(resolve, 500))
    const count = app.frames.length
    await new Promise(resolve => setTimeout(resolve, 350))
    if (columns >= 120) assert.doesNotMatch((app.lastFrame() ?? '').split('\n').at(-3) ?? '', /━/, 'fitting content must not show a horizontal scrollbar')
    assert.ok(app.frames.length - count <= 1, `${columns} columns: ${app.frames.length - count} unexpected idle frames`)
  }
})
