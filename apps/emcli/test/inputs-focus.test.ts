import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

test('Inputs tab traversal keeps every gallery button visibly focused across terminal sizes', async () => {
  const script = `
    import React from 'react';
    import {render,cleanup} from 'ink-testing-library';
    import {Gallery} from './src/tui/gallery-app.tsx';
    import {OverlayProvider} from './src/tui/overlay.tsx';
    process.env.EMCLI_GALLERY_TAB='inputs';
    const pause=()=>new Promise(r=>setTimeout(r,80));
    const results=[];
    for(const [columns,rows] of [[160,54],[120,40],[100,30]]) {
      const app=render(React.createElement(OverlayProvider,null,React.createElement(Gallery)));
      Object.defineProperties(app.stdout,{columns:{value:columns,configurable:true},rows:{value:rows,configurable:true}});
      app.stdout.emit('resize'); await pause();
      app.stdin.write('\\t'); await pause();
      const frames=[];
      for(let i=0;i<8;i++) {
        app.stdin.write('\\t'); await pause();
        frames.push(app.lastFrame());
      }
      app.stdin.write('\\u001b[Z'); await pause();
      const previous=app.lastFrame();
      results.push({columns,frames,previous});
      app.unmount();
    }
    cleanup();
    process.stdout.write(JSON.stringify(results));
  `
  const env = { ...process.env, FORCE_COLOR: '3' }; delete env.NO_COLOR
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: new URL('..', import.meta.url), env })
  const labels = ['Default', 'Primary', 'Warning', 'Error', 'Default', 'Primary', 'Warning', 'Error']
  for (const { columns, frames, previous } of JSON.parse(stdout)) {
    for (const [index, frame] of (frames as string[]).entries()) {
      const inverse = [...frame.matchAll(/\x1b\[7m(.*?)\x1b\[27m/g)].map(match => match[1].replace(/\x1b\[[\d;]*m/g, ''))
      assert.deepEqual(inverse, [labels[index]], `${columns} columns: Tab ${index + 1} after tab bar must visibly focus ${labels[index]}`)
    }
    assert.match(previous, /\x1b\[7m[^\n]*Warning[^\n]*\x1b\[27m/, 'Shift+Tab returns to previous visible button')
  }
})
