// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict'
import test from 'node:test'
import { PassThrough } from 'node:stream'

import { createMouseInput, parseMouseSequence } from '../src/tui/mouse.js'

test('parses SGR mouse press, release and wheel events', () => {
  assert.deepEqual(parseMouseSequence('\x1b[<0;10;5M'), {
    x: 9,
    y: 4,
    button: 'left',
    action: 'press',
  })
  assert.deepEqual(parseMouseSequence('\x1b[<0;10;5m'), {
    x: 9,
    y: 4,
    button: 'left',
    action: 'release',
  })
  assert.deepEqual(parseMouseSequence('\x1b[<65;1;2M'), {
    x: 0,
    y: 1,
    button: 'wheel-down',
    action: 'wheel',
  })
})

test('filters mouse sequences out of Ink stdin and emits click events', () => {
  const source = new PassThrough()
  const input = createMouseInput(source)
  const forwarded: string[] = []
  const events: unknown[] = []
  input.stdin.on('data', chunk => forwarded.push(String(chunk)))
  input.onMouse(event => events.push(event))

  source.write('\t')
  source.write('\x1b[<0;12;6M')
  source.write('x')

  assert.deepEqual(forwarded, ['\t', 'x'])
  assert.deepEqual(events, [{ x: 11, y: 5, button: 'left', action: 'press' }])
  input.dispose()
})
