// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict'
import test from 'node:test'
import { PassThrough } from 'node:stream'
import React, { useState } from 'react'
import { Text } from 'ink'
import { render } from 'ink-testing-library'

import { MouseProvider, MouseRegion, createMouseInput } from '../src/tui/mouse.js'

function Probe(): React.ReactElement {
  const [hovered, setHovered] = useState(false)
  return (
    <MouseRegion onHover={() => setHovered(true)} onLeave={() => setHovered(false)}>
      <Text>{hovered ? 'HOVER' : 'IDLE'}</Text>
    </MouseRegion>
  )
}

test('mouse move enters and leaves a hover region', async () => {
  const source = new PassThrough()
  const input = createMouseInput(source)
  const { frames } = render(
    <MouseProvider input={input}>
      <Probe />
    </MouseProvider>,
    { stdin: input.stdin },
  )
  await new Promise(resolve => setTimeout(resolve, 30))
  const frame = (): string => [...frames].reverse().find(item => item.includes('IDLE') || item.includes('HOVER')) ?? ''
  assert.match(frame(), /IDLE/)

  source.write('\x1b[<35;1;1M')
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.match(frame(), /HOVER/)

  source.write('\x1b[<35;80;20M')
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.match(frame(), /IDLE/)

  input.dispose()
})
