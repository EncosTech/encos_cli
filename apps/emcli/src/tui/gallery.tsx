#!/usr/bin/env node
// SPDX-License-Identifier: MIT

import React from 'react'
import { render } from 'ink'

import { Gallery } from './gallery-app.js'
import { MouseProvider, createMouseInput } from './mouse.js'
import { OverlayProvider } from './overlay.js'

const mouseInput = createMouseInput(process.stdin)
const instance = render(
  <MouseProvider input={mouseInput}>
      <OverlayProvider>
        <Gallery />
      </OverlayProvider>
  </MouseProvider>,
  { alternateScreen: true, exitOnCtrlC: false, stdin: mouseInput.stdin },
)
if (process.env.EMCLI_GALLERY_SNAPSHOT === '1' || process.argv.includes('--snapshot')) {
  setTimeout(() => instance.unmount(), 700)
}
try { await instance.waitUntilExit() }
finally { await mouseInput.dispose() }
