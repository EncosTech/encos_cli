#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// 构建可选的 C++ 性能模块（scan/stress/bench）。
// 这是一个开发/打包脚本，不参与 pnpm -r build，缺少本地 SDK 时不会阻塞 CLI。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import process from 'node:process'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(scriptDir, '..')
const repoRoot = resolve(packageRoot, '../..')
const out = resolve(process.env.EMCLI_PERF_OUT ?? join(packageRoot, 'build/emcli_perf.node'))
const nodeInclude =
  process.env.NODE_INCLUDE_DIR ?? resolve(dirname(process.execPath), '../include/node')
const prefix = resolve(process.env.EMCLI_DRIVER_PREFIX ?? '/usr/local')
const compiler = process.env.CXX ?? 'g++'

if (!existsSync(join(nodeInclude, 'node_api.h'))) {
  throw new Error(`node_api.h not found under ${nodeInclude}; set NODE_INCLUDE_DIR`)
}
const windows=process.platform==='win32'
const driverLibrary=windows?'libencosdriver.dll.a':'libencosdriver.so'
if (!existsSync(join(prefix, 'lib', driverLibrary))) {
  throw new Error(`${driverLibrary} not found under ${prefix}/lib; set EMCLI_DRIVER_PREFIX`)
}

mkdirSync(dirname(out), { recursive: true })
let nodeImport=process.env.EMCLI_NODE_IMPORT_LIBRARY
if(windows&&!nodeImport){
 const directory=join(dirname(out),'node-import');mkdirSync(directory,{recursive:true})
 execFileSync('gendef',[process.execPath],{cwd:directory,stdio:'inherit'})
 const exports=readFileSync(join(directory,'node.def'),'utf8').split(/\r?\n/).filter(line=>/^\s*(napi_|node_api_)/.test(line))
 if(!exports.length)throw new Error('Node executable exposes no Node-API symbols')
 const definition=join(directory,'node-api.def');writeFileSync(definition,['LIBRARY node.exe','EXPORTS',...exports].join('\n'))
 nodeImport=join(directory,'libnode.dll.a')
 execFileSync('dlltool',['-d',definition,'-D','node.exe','-l',nodeImport],{stdio:'inherit'})
}
const args = [
  '-shared',
  ...(windows?[]:['-fPIC']),
  '-O2',
  '-std=c++17',
  '-pthread',
  '-DNAPI_VERSION=8',
  `-I${nodeInclude}`,
  `-I${join(prefix, 'include', 'encos')}`,
  join(packageRoot, 'native/engine/perf.cc'),
  `-I${join(packageRoot, 'native/legacy')}`,
  `-I${join(packageRoot, 'native/legacy/serialib')}`,
  ...['slave_config.cc','firmware_download.cc','firmware_download_platform.cc'].map(name=>join(packageRoot,'native/legacy/src/cli',name)),
  join(packageRoot,'native/legacy/serialib/serialib.cpp'),
  `-L${join(prefix, 'lib')}`,
  '-lencosdriver',
  '-lencosdriver_base',
  ...(windows?[nodeImport,'-lws2_32','-liphlpapi','-lsetupapi','-lcfgmgr32']:['-ldl']),
  '-o',
  out,
]
execFileSync(compiler, args, { stdio: 'inherit', cwd: repoRoot })
console.log(`built ${out}`)
