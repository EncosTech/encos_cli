import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

test('focused input caret blinks and editing restores it immediately', async () => {
  const script = `
    import React from 'react';
    import {render, cleanup} from 'ink-testing-library';
    import {TextInput} from './src/tui/components/TextInput.tsx';
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    const app = render(React.createElement(TextInput, {size:'small', width:12, value:'abc', autoFocus:true, onChange() {}}));
    await pause(100);
    const on = app.lastFrame();
    await pause(500);
    const off = app.lastFrame();
    app.stdin.write('\u001b[D');
    await pause(80);
    const edited = app.lastFrame();
    cleanup();
    process.stdout.write(JSON.stringify({on, off, edited}));
  `
  const env = { ...process.env, FORCE_COLOR: '3' }
  delete env.NO_COLOR
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url), env,
  })
  const { on, off, edited } = JSON.parse(stdout)
  assert.notEqual(on, off)
  assert.match(on, /48;2;224;224;224/)
  assert.doesNotMatch(off, /48;2;224;224;224/)
  assert.match(edited, /48;2;224;224;224/)
})

test('tree hover covers the row while selection covers only the label', async () => {
  const script = `
    import React from 'react';
    import {Box} from 'ink';
    import {PassThrough} from 'node:stream';
    import {render, cleanup} from 'ink-testing-library';
    import {TreeList} from './src/tui/components/TreeList.tsx';
    import {MouseProvider} from './src/tui/mouse.tsx';
    let emit;
    const input = {stdin:new PassThrough(), onMouse(fn) {emit=fn;return ()=>{}}, dispose() {}};
    const tree = React.createElement(TreeList, {autoFocus:true, nodes:[{id:'root',label:'Root',children:[{id:'leaf',label:'Leaf'}]}]});
    const app = render(React.createElement(MouseProvider, {input}, React.createElement(Box, {width:30}, tree)));
    await new Promise(r=>setTimeout(r,100));
    emit({action:'move',button:'none',x:10,y:2});
    await new Promise(r=>setTimeout(r,80));
    emit({action:'press',button:'left',x:10,y:2});
    await new Promise(r=>setTimeout(r,80));
    const frame = app.lastFrame();
    cleanup();
    process.stdout.write(JSON.stringify(frame));
  `
  const env = { ...process.env, FORCE_COLOR: '3' }; delete env.NO_COLOR
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: new URL('..', import.meta.url), env })
  const frame: string = JSON.parse(stdout)
  const line = frame.split('\n').find(line => line.includes('Leaf'))!
  let background = '', selected = '', hovered = ''
  for (const token of line.split(/(\x1b\[[\d;]*m)/)) {
    if (token.startsWith('\x1b[')) {
      const codes = token.slice(2, -1)
      if (codes.startsWith('48;2;')) background = codes
      else if (codes === '49' || codes === '0') background = ''
    } else if (background === '48;2;1;120;212') selected += token
    else if (background === '48;2;56;76;96') hovered += token
  }
  assert.equal(selected, 'Leaf')
  assert.match(hovered, /└─/)
  assert.ok(hovered.endsWith('     '))
})

test('external value refreshes do not hold the caret permanently on', async () => {
  const script = `
    import React, {useState, useEffect} from 'react';
    import {render, cleanup} from 'ink-testing-library';
    import {TextInput} from './src/tui/components/TextInput.tsx';
    import {Card} from './src/tui/components/Card.tsx';
    function LiveInput() {
      const [value, setValue] = useState(0);
      useEffect(() => {const timer=setInterval(()=>setValue(v=>v+1),80); return ()=>clearInterval(timer)},[]);
      return React.createElement(Card,{title:'Live',width:30,height:6},React.createElement(TextInput,{autoFocus:true,size:'small',width:20,value:String(value),onChange(){}}));
    }
    const app = render(React.createElement(LiveInput));
    await new Promise(r=>setTimeout(r,100)); const on=app.lastFrame();
    await new Promise(r=>setTimeout(r,500)); const off=app.lastFrame();
    cleanup();
    process.stdout.write(JSON.stringify({on,off}));
  `
  const env = { ...process.env, FORCE_COLOR: '3' }; delete env.NO_COLOR
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: new URL('..', import.meta.url), env })
  const { on, off } = JSON.parse(stdout)
  assert.match(on, /48;2;224;224;224/)
  assert.doesNotMatch(off, /48;2;224;224;224/)
})

test('clicking either gallery input produces a blinking end caret', async () => {
  const script = `
    import React from 'react';
    import {render,cleanup} from 'ink-testing-library';
    import {PassThrough} from 'node:stream';
    import {Gallery} from './src/tui/gallery-app.tsx';
    import {MouseProvider} from './src/tui/mouse.tsx';
    import {OverlayProvider} from './src/tui/overlay.tsx';
    let emit;
    const input={stdin:new PassThrough(),onMouse(fn){emit=fn;return()=>{}},dispose(){}};
    process.env.EMCLI_GALLERY_TAB='inputs';
    const app=render(React.createElement(MouseProvider,{input},React.createElement(OverlayProvider,null,React.createElement(Gallery))));
    Object.defineProperties(app.stdout,{columns:{value:160,configurable:true},rows:{value:54,configurable:true}});
    app.stdout.emit('resize');
    const pause=ms=>new Promise(r=>setTimeout(r,ms));
    await pause(300);
    const lines=app.lastFrame().replace(/\\x1b\\[[\\d;]*m/g,'').split('\\n');
    const inputs=lines.flatMap((line,y)=>line.includes('Motor 1')?[{x:line.indexOf('Motor 1')+7,y}]:[]);
    const frames=[];
    for(const {x,y} of inputs) {
      emit({action:'press',button:'left',x,y});
      emit({action:'release',button:'left',x,y});
      await pause(100); const on=app.lastFrame().split('\\n')[y];
      await pause(500); const off=app.lastFrame().split('\\n')[y];
      frames.push({on,off});
    }
    cleanup();
    process.stdout.write(JSON.stringify(frames));
  `
  const env = { ...process.env, FORCE_COLOR: '3' }; delete env.NO_COLOR
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: new URL('..', import.meta.url), env })
  const frames = JSON.parse(stdout)
  assert.equal(frames.length, 2)
  for (const { on, off } of frames) {
    assert.match(on, /▏/)
    assert.doesNotMatch(off, /▏/)
  }
})
