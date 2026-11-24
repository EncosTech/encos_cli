import assert from 'node:assert/strict'
import test from 'node:test'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'

test('mouse reporting is disabled before restoring terminal input echo', async () => {
 const script = `
  import React from 'react';
  import {PassThrough} from 'node:stream';
  import {render, useInput, Text} from 'ink';
  import {createMouseInput, MouseProvider} from './src/tui/mouse.tsx';
  const source = new PassThrough();
  let reporting = false, unsafeRestore = false;
  const stdout = new PassThrough();
  stdout.isTTY = true; stdout.columns = 80; stdout.rows = 24;
  stdout.on('data', chunk => {
   for (const match of String(chunk).matchAll(/\\x1b\\[\\?1003([hl])/g)) reporting = match[1] === 'h';
  });
  source.setRawMode = enabled => { if (!enabled && reporting) unsafeRestore = true; };
  const mouse = createMouseInput(source);
  function App() { useInput(()=>{}); return React.createElement(Text,null,'Ready'); }
  const app = render(React.createElement(MouseProvider,{input:mouse},React.createElement(App)), {stdin:mouse.stdin,stdout,stderr:stdout,interactive:true,alternateScreen:true,patchConsole:false});
  await new Promise(resolve=>setTimeout(resolve,80));
  const enabled = reporting;
  app.unmount(); await app.waitUntilExit(); await mouse.dispose();
  process.stdout.write(JSON.stringify({enabled,unsafeRestore,reporting}));
 `
 const {stdout}=await promisify(execFile)(process.execPath,['--import','tsx','--input-type=module','-e',script],{cwd:new URL('..',import.meta.url),timeout:5000})
 const result=JSON.parse(stdout)
 assert.equal(result.enabled,true)
 assert.equal(result.reporting,false)
 assert.equal(result.unsafeRestore,false,'Terminal echo was restored while mouse reports were still enabled')
})
