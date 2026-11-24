// SPDX-License-Identifier: MIT
import { useStdout } from 'ink'
import { useOptionalNotifications } from './components/Toast.js'

/** OSC 52 has no success acknowledgement; only a custom writer can confirm completion. */
export function useClipboardCopy() {
  const { stdout } = useStdout()
  const notices = useOptionalNotifications()
  return async (text: string, write?: () => void | Promise<void>) => {
    if (!text) return
    try {
      if (write) {
        await write()
        notices?.notify('Copied to clipboard', { title: 'Clipboard', severity: 'success', timeout: 2000 })
        return 'copied' as const
      } else {
        stdout.write(`\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`)
        notices?.notify('Copy request sent to terminal', { title: 'Clipboard', severity: 'information', timeout: 2000 })
        return 'requested' as const
      }
    } catch {
      notices?.notify('Could not copy to clipboard', { title: 'Clipboard', severity: 'error', timeout: 4000 })
      return 'failed' as const
    }
  }
}
