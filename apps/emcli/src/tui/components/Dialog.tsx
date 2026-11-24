// SPDX-License-Identifier: MIT

import React, { type ReactNode } from 'react'
import { Box, Text, useInput, useWindowSize } from 'ink'
import { InteractionBlocked, useInteractionBlocked } from '../interaction.js'
import { InitialFocusScope,useRestoreFocus } from '../navigation.js'
import {useOverlayVisible} from '../overlay.js'
import { colors } from '../theme.js'
import { Button } from './Button.js'

export interface DialogProps { title: string; children?: ReactNode; onClose(): void; onConfirm?(): void; confirmLabel?: string; cancelLabel?: string; width?: number }
/** Mount only while open. Wrap background siblings in InteractionBlocked.Provider. */
export function Dialog({ title, children, onClose, onConfirm, confirmLabel = 'Confirm', cancelLabel = 'Cancel', width = 54 }: DialogProps) {
  const { columns, rows } = useWindowSize()
  const blocked = useInteractionBlocked()
  useRestoreFocus()
  const popupOpen=useOverlayVisible()
  useInput((_input, key) => { if (key.escape && !popupOpen) onClose() }, {isActive: !blocked})
  return <InteractionBlocked.Provider value={false}><InitialFocusScope><Box position="absolute" top={0} left={0} width={columns} height={rows} backgroundColor={colors.background} alignItems="center" justifyContent="center">
    <Box width={Math.min(width, columns)} flexDirection="column" borderBackgroundColor={colors.panel} borderStyle="bold" borderColor={colors.primary} backgroundColor={colors.panel} paddingX={2} paddingY={1}>
      <Text bold color={colors.text}>{title}</Text><Box marginY={1} flexDirection="column">{children}</Box>
      <Box gap={2} justifyContent="flex-end"><Button label={cancelLabel} onPress={onClose} />{onConfirm && <Button label={confirmLabel} variant="primary" onPress={onConfirm} />}</Box>
    </Box>
  </Box></InitialFocusScope></InteractionBlocked.Provider>
}
export function DialogHost({ dialog, children }: { dialog?: ReactNode; children: ReactNode }) {
  return <><InteractionBlocked.Provider value={Boolean(dialog)}>{children}</InteractionBlocked.Provider>{dialog}</>
}
