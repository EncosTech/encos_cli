// SPDX-License-Identifier: MIT

// tsup embeds this JSON import, including in standalone executable assets.
import metadata from '../../../package.json' with { type: 'json' }

export const VERSION = metadata.version
