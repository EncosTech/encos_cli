// SPDX-License-Identifier: MIT

import {jsonMode,setJsonResult} from '../json-output.js'

import {
  EmcliNativeError,
  loadEmcliNative,
  selectPlatform,
} from '@encos/emcli-native'
import {
  checkPermissions,
  createEncosRuntime,
  requestPermissions,
} from '@encos/encos-driver-native'

import { flagBoolean, rejectUnknownFlags, type ParsedArgs } from '../args.js'
import { VERSION } from '../version.js'

export async function runDoctor(args: ParsedArgs): Promise<number> {
  rejectUnknownFlags(args, ['request-permissions'])
  const report:Record<string,unknown>={version:VERSION,node:process.version,platform:process.platform,architecture:process.arch};setJsonResult(report)
  if(!jsonMode)console.log(`emcli      ${VERSION}`)
  if(!jsonMode)console.log(`node       ${process.version}`)
  if(!jsonMode)console.log(`platform   ${process.platform}/${process.arch}`)

  try {
    const selection = selectPlatform()
    report.driverPackage=`@encos/encos-driver-native-${selection.suffix}`;if(!jsonMode)console.log(`driver pkg @encos/encos-driver-native-${selection.suffix}`)
  } catch (error) {
    report.error={message:error instanceof Error?error.message:String(error)};printNativeError(error)
    return 1
  }

  let permissions = await checkPermissions()
  if (!permissions.authorized && flagBoolean(args, 'request-permissions')) {
    await requestPermissions()
    permissions = await checkPermissions()
  }
  report.permissions=permissions;if(!jsonMode)console.log(`helpers    ${permissions.authorized ? 'authorized' : 'NOT authorized'}`)
  if (!jsonMode&&!permissions.authorized) {
    for (const item of permissions.missing) {
      console.log(`  ${item.target}  [${item.capabilities.join(', ')}]`)
    }
    console.log('  运行 emcli doctor --request-permissions 授权驱动 helper。')
  }

  const runtime = await createEncosRuntime()
  try {
    report.driverVersion=runtime.getVersion();if(!jsonMode)console.log(`driver ver ${report.driverVersion}`)
    const native = loadEmcliNative()
    report.native=native.info;if(!jsonMode)console.log(`perf addon ${native.info.addonPath}`)
    if(!jsonMode)console.log(`perf abi   ${native.info.abi}`)
  } catch (error) {
    report.error={message:error instanceof Error?error.message:String(error)};printNativeError(error)
    return 1
  } finally {
    runtime.dispose()
  }
  return permissions.authorized ? 0 : 1
}

function printNativeError(error: unknown): void {
  if (error instanceof EmcliNativeError) {
    console.error(`Error: ${error.message}`)
    if (process.env.EMCLI_DEBUG === '1' && error.detail !== undefined) {
      console.error(error.detail)
    }
    return
  }
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`)
}
