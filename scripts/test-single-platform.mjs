#!/usr/bin/env node
import {spawnSync} from 'node:child_process'
const steps=process.platform==='win32'
 ? [[process.env.PYTHON||'python',['scripts/test-single-windows.py',...process.argv.slice(2)]]]
 : [[process.execPath,['scripts/test-single.mjs',...process.argv.slice(2)]],['python3',['scripts/test-single-tui.py',...process.argv.slice(2)]]]
for(const [command,args] of steps){
 const result=spawnSync(command,args,{stdio:'inherit',env:{...process.env,PYTHONIOENCODING:'utf-8'}})
 if(result.error){console.error(result.error.message);process.exit(1)}
 if(result.status!==0)process.exit(result.status||1)
}
