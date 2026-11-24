import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {execFileSync} from 'node:child_process'
const root=fileURLToPath(new URL('../',import.meta.url)),dir=mkdtempSync(join(tmpdir(),'emcli-firmware-'))
try{
 const out=join(dir,process.platform==='win32'?'test.exe':'test')
 execFileSync(process.env.CXX??'g++',['-std=c++17','-I'+resolve(root,'native/legacy'),resolve(root,'test/firmware-compat.cc'),resolve(root,'native/legacy/src/cli/firmware_download.cc'),'-o',out],{stdio:'inherit'})
 execFileSync(out,[dir],{stdio:'inherit'})
}finally{rmSync(dir,{recursive:true,force:true})}
