// SPDX-License-Identifier: MIT

import {jsonMode,setJsonResult} from '../json-output.js'

import type { Runtime } from '@encos/encos-driver-native'
import { loadEmcliNative, type NativeScanRow } from '@encos/emcli-native'

import { flagBoolean, rejectUnknownFlags, type ParsedArgs } from '../args.js'
import { adapterTiming, openRuntime, runtimeOptionsFromArgs } from '../runtime.js'
import { parseScanTarget } from '../target.js'
import { printTable } from '../format.js'

export async function runScan(args: ParsedArgs): Promise<number> {
  rejectUnknownFlags(args, ['slave'])
  const runtime = await openRuntime(runtimeOptionsFromArgs(args))
  try {
    if (args.positionals.length === 0) {
      if(flagBoolean(args,'slave'))throw new Error('Slave scan requires Plugin:Interface')
      return listAvailable(runtime)
    }
    const target = parseScanTarget(args.positionals[0])
    if(flagBoolean(args,'slave')){
      if(!target.adapterId||target.busId!==undefined||target.slaveId!==undefined)throw new Error('Slave scan requires Plugin:Interface without slave/bus selectors')
      const rows=loadEmcliNative().scanSlaves({type:target.adapterType,interfaceName:target.adapterId,timing:adapterTiming(args)})
      setJsonResult({kind:'slaves',adapterType:target.adapterType,interfaceName:target.adapterId,slaves:rows});if(!jsonMode){console.log('SlaveIdx  UUID');for(const row of rows)console.log(String(row.index).padEnd(10)+row.uuid)}
      return 0
    }
    if (target.adapterId === undefined) {
      return listInterfaces(runtime, target.adapterType)
    }

    // bench/stress/scan 的扫描必须走 @encos/emcli-native；不再提供 JS 回退。
    const native = loadEmcliNative()
    const rows: NativeScanRow[] = []
    const records:Array<NativeScanRow&{adapterType:string;interfaceName:string}>=[]
    if (target.adapterId === 'ALL') {
      for (const name of runtime.getAvailableInterface(target.adapterType).sort()) {
        const found=native.scan({timing:adapterTiming(args),
            type: target.adapterType,
            interfaceName: name,
            ...(target.slaveId === undefined ? {} : { slaveId: target.slaveId }),
            ...(target.busId === undefined ? {} : { busId: target.busId }),
          })
        rows.push(...found);records.push(...found.map(row=>({...row,adapterType:target.adapterType,interfaceName:name})))
      }
    } else {
      const found=native.scan({timing:adapterTiming(args),
          type: target.adapterType,
          interfaceName: target.adapterId,
          ...(target.slaveId === undefined ? {} : { slaveId: target.slaveId }),
          ...(target.busId === undefined ? {} : { busId: target.busId }),
        })
      rows.push(...found);records.push(...found.map(row=>({...row,adapterType:target.adapterType,interfaceName:target.adapterId!})))
    }
    setJsonResult({kind:'motors',motors:records});if(!jsonMode)printRows(rows)
    return 0
  } finally {
    runtime.dispose()
  }
}

function listAvailable(runtime: Runtime): number {
  const types = runtime.getAvailableAdapterTypes()
  if (types.length === 0) {
    setJsonResult({kind:'adapters',adapters:[]});if(!jsonMode)console.log('没有可用的适配器类型。请检查驱动插件路径。')
    return 0
  }
  const rows: string[][] = []
  for (const type of types.sort()) {
    const interfaces = runtime.getAvailableInterface(type)
    for (const name of interfaces.sort()) rows.push([type, name])
  }
  setJsonResult({kind:'adapters',adapters:rows.map(([adapterType,interfaceName])=>({adapterType,interfaceName}))});if(jsonMode)return 0
  printTable(['Adapter', 'Interface'], rows)
  console.log('\n使用 emcli scan <Type:Interface> 扫描电机。')
  return 0
}

function listInterfaces(runtime: Runtime, adapterType: string): number {
  const types = runtime.getAvailableAdapterTypes()
  if (!types.includes(adapterType)) {
    throw new Error(`未知适配器类型 '${adapterType}'`)
  }
  const interfaces=runtime.getAvailableInterface(adapterType).sort();setJsonResult({kind:'interfaces',adapterType,interfaces});if(jsonMode)return 0
  for (const name of interfaces) {
    console.log(name)
  }
  return 0
}

function printRows(rows: NativeScanRow[]): void {
  console.log('slave\tbus\tid\teff\tcanfd')
  for (const row of rows) {
    console.log(
      `${row.slaveId === null ? '' : row.slaveId}\t${row.busId}\t${row.motorId}\t${
        row.eff ? 1 : 0
      }\t${row.canfd ? 1 : 0}`,
    )
  }
}
