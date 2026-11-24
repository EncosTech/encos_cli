// SPDX-FileCopyrightText: 2026 Encos
// SPDX-License-Identifier: MIT

import React, { useState } from 'react'
import { Box } from 'ink'
import { Card } from '../tui/index.js'
import { DEX_HAND_SETTINGS, parseDexHandSetting } from './dex-hand.js'
import { SettingEditor } from './MotorPanels.js'
import type { DeviceAddress, Request } from './protocol.js'

export function DexHandSettings({
  device, run, enabled, width,
}: {
  device: DeviceAddress
  run: (request: Request, message?: string) => Promise<unknown>
  enabled: boolean
  width: number
}) {
  const [settings, setSettings] = useState<Record<string, string[]>>({})
  return (
    <Card title="DexHand settings">
      <Box flexDirection="column" gap={1}>
        {DEX_HAND_SETTINGS.map((setting) => (
          <SettingEditor
            key={setting.id}
            setting={setting}
            values={settings[setting.id] ?? (setting.id === 'base-id' ? [String(device.deviceId)] : ['', ''])}
            onChange={(values) => setSettings((current) => ({ ...current, [setting.id]: values }))}
            run={(request) => {
              if (request.type !== 'read' && request.type !== 'write') return Promise.resolve()
              return run({
                type: 'dex-hand-setting',
                deviceKey: device.key,
                item: request.item,
                ...(request.type === 'write' ? { values: request.values } : {}),
              }, request.type === 'write' ? 'Settings applied' : undefined)
            }}
            validate={parseDexHandSetting}
            readAfterWrite={false}
            enabled={enabled}
            width={width}
          />
        ))}
      </Box>
    </Card>
  )
}
