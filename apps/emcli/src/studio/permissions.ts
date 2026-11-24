import {basename} from 'node:path'
import {checkPermissions} from '@encos/encos-driver-native'

/** SSH has no TUI-safe password prompt. Authorize helpers before native code
 * enters a blocking pkexec handshake; desktop sessions retain their GUI agent. */
export async function ensureSshAdapterPermissions(adapterType:string,options:{
 platform?:string;uid?:number;env?:NodeJS.ProcessEnv;inspect?:typeof checkPermissions
}={}){
 const {platform=process.platform,uid=process.getuid?.(),env=process.env,inspect=checkPermissions}=options
 if(platform!=='linux'||uid===0||!(env.SSH_CONNECTION||env.SSH_TTY)||env.DISPLAY||env.WAYLAND_DISPLAY)return
 const helpers:Record<string,string[]>={
  ethercat:['EthercatFdBrokerExecutable','ThreadPriorityHelper'],
  can:['CanFdBrokerExecutable','ThreadPriorityHelper'],
  ethernet:['EthernetXdpBrokerExecutable','ThreadPriorityHelper'],
 }
 const required=helpers[adapterType.toLowerCase()]
 if(!required)return
 const status=await inspect()
 const missing=status.missing.filter(item=>required.includes(basename(item.target)))
 if(!missing.length)return
 throw new Error('Driver helper permissions are missing for this SSH session. Close the TUI and run "emcli doctor --request-permissions" in the same SSH terminal (without --json), then start emcli again.\n'+missing.map(item=>`${item.target}: ${item.capabilities.join(', ')}`).join('\n'))
}
