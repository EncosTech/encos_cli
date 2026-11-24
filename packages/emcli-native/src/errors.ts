// SPDX-License-Identifier: MIT

/** 稳定错误码；与设计文档 §6.8 / 附录 B 对应。 */
export type EmcliErrorCode =
  | 'EMCLI_PLATFORM_UNSUPPORTED'
  | 'EMCLI_GLIBC_TOO_OLD'
  | 'EMCLI_PLATFORM_PACKAGE_MISSING'
  | 'EMCLI_DRIVER_PACKAGE_MISSING'
  | 'EMCLI_DRIVER_LIB_MISSING'
  | 'EMCLI_DRIVER_VERSION_MISMATCH'
  | 'EMCLI_DRIVER_INSTANCE_CONFLICT'
  | 'EMCLI_DRIVER_LOAD_FAILED'
  | 'EMCLI_ENGINE_LIB_MISSING'
  | 'EMCLI_ENGINE_LOAD_FAILED'
  | 'EMCLI_ENGINE_ABI_MISMATCH'
  | 'EMCLI_ALREADY_OPEN'
  | 'EMCLI_WRONG_ENV'
  | 'EMCLI_INVALID_ARGUMENT'
  | 'EMCLI_INVALID_STATE'
  | 'EMCLI_BUSY'
  | 'EMCLI_NOT_FOUND'
  | 'EMCLI_DRIVER_CALL_FAILED'
  | 'EMCLI_INTERNAL'

export interface EmcliNativeErrorOptions {
  status?: number
  detail?: string
  osErrno?: number
  cause?: unknown
}

export class EmcliNativeError extends Error {
  readonly code: EmcliErrorCode
  readonly status?: number
  readonly detail?: string
  readonly osErrno?: number

  constructor(code: EmcliErrorCode, message: string, options: EmcliNativeErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'EmcliNativeError'
    this.code = code
    this.status = options.status
    this.detail = options.detail
    this.osErrno = options.osErrno
  }
}

/** @internal 把 C 状态码映射为稳定 JS 错误码。 */
export function jsCodeForStatus(status: number | undefined): EmcliErrorCode {
  switch (status) {
    case 1:
      return 'EMCLI_INVALID_ARGUMENT'
    case 2:
      return 'EMCLI_NOT_FOUND'
    case 3:
      return 'EMCLI_BUSY'
    case 4:
      return 'EMCLI_DRIVER_CALL_FAILED'
    case 5:
      return 'EMCLI_ENGINE_ABI_MISMATCH'
    case 6:
      return 'EMCLI_INVALID_STATE'
    case 7:
      return 'EMCLI_DRIVER_INSTANCE_CONFLICT'
    default:
      return 'EMCLI_INTERNAL'
  }
}
