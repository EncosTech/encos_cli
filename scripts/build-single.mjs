#!/usr/bin/env node
// Build a host-platform SEA with its complete production module/native closure.
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {readFileSync,writeFileSync,readdirSync,statSync,realpathSync,existsSync,mkdirSync,copyFileSync,chmodSync,rmSync,symlinkSync} from 'node:fs'
import {dirname,join,resolve,relative} from 'node:path'
import {fileURLToPath} from 'node:url'
import {gzipSync,gunzipSync} from 'node:zlib'
import {execFileSync} from 'node:child_process'
import {buildWindowsNodeBridge} from './windows-node-bridge.mjs'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..')
const node=process.env.EMCLI_SEA_NODE || process.execPath
const version=execFileSync(node,['-p','process.versions.node'],{encoding:'utf8'}).trim()
if(Number(version.split('.')[0])<22)throw new Error('SEA requires Node >=22. Set EMCLI_SEA_NODE to that Node executable.')
const out=join(root,'dist',`emcli-${process.platform}-${process.arch}${process.platform==='win32'?'.exe':''}`)
const work=join(root,'build','single')
rmSync(work,{recursive:true,force:true});mkdirSync(join(work,'assets'),{recursive:true});mkdirSync(dirname(out),{recursive:true})
const nodeBridge=process.platform==='win32'?buildWindowsNodeBridge(node,work):undefined
const hash=buffer=>createHash('sha256').update(buffer).digest('hex')
const files=[],links=[],assets={},packages=new Map()
function addFile(source,path){
 const content=readFileSync(source),key=hash(content),asset=join(work,'assets',key)
 if(!assets[key]){writeFileSync(asset,gzipSync(content,{level:9}));assets[key]=asset}
 files.push({path,key,mode:statSync(source).mode&0o777})
}
function copyTree(source,target){
 for(const item of readdirSync(source,{withFileTypes:true})){
  if(item.name==='node_modules'||item.name==='.git'||item.name.endsWith('.map'))continue
  const from=join(source,item.name),to=`${target}/${item.name}`
  if(statSync(from).isDirectory())copyTree(from,to)
  else addFile(from,to)
 }
}
function findDependency(source,name){
 for(let dir=source;;dir=dirname(dir)){
  const candidate=join(dir,'node_modules',name)
  if(existsSync(join(candidate,'package.json')))return realpathSync(candidate)
  if(dirname(dir)===dir)return undefined
 }
}
function collect(source){
 source=realpathSync(source)
 if(packages.has(source))return packages.get(source)
 const pkg=JSON.parse(readFileSync(join(source,'package.json'),'utf8'))
 // Distinct installed versions retain their own dependency links and identity.
 const target=`modules/${packages.size}-${pkg.name.replaceAll('/','-')}`
 packages.set(source,target)
 if(pkg.name==='@encos/emcli-native'){
  addFile(join(source,'package.json'),`${target}/package.json`)
  copyTree(join(source,'dist'),`${target}/dist`)
  addFile(join(source,'build','emcli_perf.node'),`${target}/build/emcli_perf.node`)
 }else copyTree(source,target)
 if(nodeBridge&&pkg.name==='@encos/encos-driver-native-win32-x64')addFile(nodeBridge,`${target}/native/node.exe`)
 const dependencies={...pkg.peerDependencies,...pkg.dependencies,...pkg.optionalDependencies}
 for(const name of Object.keys(dependencies)){
  const dependency=findDependency(source,name)
  if(!dependency){
   if(pkg.optionalDependencies?.[name]||pkg.peerDependenciesMeta?.[name]?.optional)continue
   throw new Error(`Missing production dependency ${name} of ${pkg.name}`)
  }
  const destination=collect(dependency)
  links.push({path:`${target}/node_modules/${name}`,target:destination})
 }
 return target
}
const app=join(root,'apps','emcli'),pkg=JSON.parse(readFileSync(join(app,'package.json'),'utf8'))
copyTree(join(app,'dist'),'app/dist');addFile(join(app,'package.json'),'app/package.json')
for(const name of Object.keys({...pkg.dependencies,...pkg.peerDependencies})){
 const dependency=findDependency(app,name)
 if(!dependency)throw new Error(`Missing ${name}`)
 links.push({path:`app/node_modules/${name}`,target:collect(dependency)})
}
const manifest=JSON.stringify({layoutVersion:2,files,links}),id=hash(manifest)
const manifestPath=join(work,'manifest.json');writeFileSync(manifestPath,manifest);assets.manifest=manifestPath
const bootstrap=readFileSync(join(root,'scripts','single-bootstrap.cjs'),'utf8').replace('__EMCLI_ASSET_ID__',id)
const main=join(work,'bootstrap.cjs');writeFileSync(main,bootstrap)
const blob=join(work,'sea.blob'),config=join(work,'sea.json')
writeFileSync(config,JSON.stringify({main,output:blob,disableExperimentalSEAWarning:true,useSnapshot:false,useCodeCache:false,assets}))
execFileSync(node,['--experimental-sea-config',config],{stdio:'inherit'})
copyFileSync(node,out);chmodSync(out,0o755)
const require=createRequire(import.meta.url)
const {inject}=require('postject')
await inject(out,'NODE_SEA_BLOB',readFileSync(blob),{sentinelFuse:'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',...(process.platform==='darwin'?{machoSegmentName:'NODE_SEA'}:{})})
if(process.platform==='win32')execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',join(root,'scripts','windows-utf8-manifest.ps1'),'-Executable',out],{stdio:'inherit'})
// The installed runtime uses exactly the assets tested in the SEA, without a
// per-user extraction cache. Bundle Node so packages need no system Node.
let runtime
if(process.platform==='linux'){
 const stage=join(work,'runtime');mkdirSync(join(stage,'bin'),{recursive:true})
 copyFileSync(node,join(stage,'bin/node'));chmodSync(join(stage,'bin/node'),0o755)
 for(const file of files){
  const destination=join(stage,file.path);mkdirSync(dirname(destination),{recursive:true})
  writeFileSync(destination,gunzipSync(readFileSync(assets[file.key])),{mode:file.mode})
 }
 for(const link of links){
  const destination=join(stage,link.path);mkdirSync(dirname(destination),{recursive:true})
  symlinkSync(relative(dirname(destination),join(stage,link.target)),destination)
 }
 const archive=out+'.runtime.tar.gz'
 execFileSync('tar',['-czf',archive,'-C',stage,'.'])
 runtime={file:archive.slice(archive.lastIndexOf('/')+1),sha256:hash(readFileSync(archive)),assetId:id}
}
const report={runtime,path:out,nodeVersion:version,platform:process.platform,arch:process.arch,bytes:statSync(out).size,sha256:hash(readFileSync(out)),assetId:id,packages:packages.size,files:files.length}
writeFileSync(out+'.json',JSON.stringify(report,null,2)+'\n')
console.log(JSON.stringify(report,null,2))
