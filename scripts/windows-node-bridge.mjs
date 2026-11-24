// MinGW addons import node.exe directly (unlike MSVC's delay-load hook).
// A SEA may have any executable name. Export tail-call trampolines resolving
// Node-API against the actual process image, not a second Node runtime.
import {execFileSync} from 'node:child_process'
import {readFileSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
export function buildWindowsNodeBridge(node,directory){
 if(process.arch!=='x64')throw new Error('The Windows Node-API bridge currently supports x64 only')
 execFileSync('gendef',[node],{cwd:directory,stdio:'inherit'})
 const names=[...new Set(readFileSync(join(directory,'node.def'),'utf8').split(/\r?\n/).map(line=>line.trim()).filter(line=>/^(napi_|node_api_)\w+$/.test(line)))]
 if(!names.length)throw new Error('No Node-API exports found for SEA bridge')
 const c=join(directory,'node-bridge.cpp'),asm=join(directory,'node-bridge.S'),def=join(directory,'node-bridge.def'),out=join(directory,'node.exe')
 writeFileSync(c,`#include <windows.h>\nextern "C" {\nvoid* emcli_napi_targets[${names.length}];\nBOOL WINAPI DllMain(HINSTANCE, DWORD reason, LPVOID) {\nif(reason != DLL_PROCESS_ATTACH) return TRUE;\nHMODULE host=GetModuleHandleW(nullptr);\n${names.map((name,i)=>`emcli_napi_targets[${i}]=reinterpret_cast<void*>(GetProcAddress(host,"${name}")); if(!emcli_napi_targets[${i}]) return FALSE;`).join('\n')}\nreturn TRUE;\n}\n}\n`)
 writeFileSync(asm,'.text\n'+names.map((name,i)=>`.globl ${name}\n.def ${name}; .scl 2; .type 32; .endef\n${name}:\njmp *emcli_napi_targets+${i*8}(%rip)\n`).join('\n'))
 writeFileSync(def,'LIBRARY node.exe\nEXPORTS\n'+names.join('\n')+'\n')
 execFileSync(process.env.CXX||'g++',['-shared','-O2','-s','-static-libgcc','-static-libstdc++',c,asm,def,'-o',out],{stdio:'inherit'})
 return out
}
