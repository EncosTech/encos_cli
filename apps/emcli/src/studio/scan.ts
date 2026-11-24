// SPDX-License-Identifier: MIT
import type {EmcliNativeApi} from '@encos/emcli-native'
import type {AdapterInfo} from './protocol.js'
export function scanAdapter(native:Pick<EmcliNativeApi,'scan'>,adapter:AdapterInfo,{busId,slaveId}:{busId?:number;slaveId?:number}={}){
 if(busId!==undefined&&adapter.devices.some(d=>d.kind==='glove'&&(d.slaveId??0)===(slaveId??0)))return []
 // GetGlove marks its five native buses as external devices. The native scanner
 // skips those buses and scans all remaining buses in parallel in ONE invocation.
 // Do not loop over buses here or change null/unencoded slave addresses to zero.
 const rows=native.scan({type:adapter.type,interfaceName:adapter.interfaceName,...(busId===undefined?{}:{busId}),...(busId!==undefined&&slaveId!==undefined?{slaveId}:{})})
 return rows.filter(row=>(slaveId===undefined||(row.slaveId??0)===slaveId)&&!adapter.devices.some(d=>d.kind==='glove'&&(d.slaveId??0)===(row.slaveId??0)))
}
