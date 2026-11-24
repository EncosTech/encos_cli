// SPDX-License-Identifier: MIT
import React from 'react'
import {render} from 'ink'
import {createMouseInput,MouseProvider} from '../tui/mouse.js'
import {OverlayProvider} from '../tui/overlay.js'
import {createLogStore} from '../tui/log-store.js'
import {adapterTiming,runtimeOptionsFromArgs} from '../runtime-options.js'
import {flagBoolean,rejectUnknownFlags,type ParsedArgs} from '../args.js'
import {parseAdapterSpec} from '../target.js'
import {createStudioClient} from './client.js'
import {StudioApp} from './app.js'
export async function runStudio(args:ParsedArgs):Promise<number>{
 rejectUnknownFlags(args,['demo'])
 if(!process.stdin.isTTY||!process.stdout.isTTY)throw new Error('The TUI requires an interactive terminal. Use --help for CLI commands.')
 const demo=flagBoolean(args,'demo')
 const preload=args.positionals.map(parseAdapterSpec)
 if(demo&&preload.length===0)preload.push({type:'Fake',id:'demo'})
 const logs=createLogStore()
 const client=createStudioClient(logs,{...runtimeOptionsFromArgs(args),timing:adapterTiming(args),demo})
 const mouse=createMouseInput(process.stdin)
 let closing=false
 const quit=()=>{if(closing)return;closing=true;void client.close().finally(()=>instance.unmount())}
 const instance=render(<MouseProvider input={mouse}><OverlayProvider><StudioApp client={client} logs={logs} preload={preload} demo={demo} onQuit={quit}/></OverlayProvider></MouseProvider>,{stdin:mouse.stdin,exitOnCtrlC:false,interactive:true,alternateScreen:true})
 process.on('SIGTERM',quit);process.on('SIGINT',quit)
 try{await instance.waitUntilExit();return 0}
 finally{
  process.off('SIGTERM',quit);process.off('SIGINT',quit)
  try{await client.close()}finally{
   try{await mouse.dispose()}finally{logs.dispose()}
  }
 }
}
