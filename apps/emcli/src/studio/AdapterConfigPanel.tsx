// SPDX-License-Identifier: MIT

import React, { useEffect, useRef, useState } from 'react'
import { Box, Text } from 'ink'
import { Button, Card, Dropdown, FilePicker, TextInput } from '../tui/index.js'
import { FieldLabel } from '../tui/components/FieldLabel.js'
import { colors } from '../tui/theme.js'
import type { Request, SessionState, FileListing } from './protocol.js'
import type { StudioClient } from './protocol.js'
import {
  adapterModes,
  networkFromIp,
  networkFromSlave,
  type AdapterMode,
  type AdapterConfigItem,
  type CdcPort,
  type AdapterConfigState,
} from './adapter-config.js'

export function AdapterConfigPanel({
  session,
  client,
  run,
  enabled,
  width,
  onDialog,
}: {
  session: SessionState
  client: StudioClient
  run: (r: Request, message?: string) => Promise<unknown>
  enabled: boolean
  width: number
  onDialog: (node: React.ReactNode) => void
}) {
  const [ports, setPorts] = useState<CdcPort[]>([]),
    [port, setPort] = useState(''),
    [mode, setMode] = useState<AdapterMode>('ecat'),
    [slave, setSlave] = useState(''),
    [ip, setIp] = useState(''),
    [firmware, setFirmware] = useState(''),
    [browse, setBrowse] = useState(false)

  const [discovering, setDiscovering] = useState(true)
  const [discoveryError, setDiscoveryError] = useState('')
  const discoveryGeneration = useRef(0)

  const state = session.adapterConfig,
    w = Math.min(64, Math.max(20, width - 6))

  const refresh = async () => {
    const generation = ++discoveryGeneration.current

    setDiscovering(true)
    setDiscoveryError('')

    try {
      const value = await client.request<CdcPort[]>({ type: 'serial-ports' })

      if (generation !== discoveryGeneration.current) return

      setPorts(value)
      setPort((old) =>
        value.length ? (value.some((p) => p.port === old) ? old : value[0].port) : old,
      )
    } catch (error) {
      if (generation === discoveryGeneration.current) {
        setDiscoveryError(error instanceof Error ? error.message : String(error))
      }
    } finally {
      if (generation === discoveryGeneration.current) setDiscovering(false)
    }
  }

  useEffect(() => {
    void refresh()

    return () => {
      discoveryGeneration.current++
    }
  }, [client])

  useEffect(() => {
    if (state) setMode(state.mode)
  }, [state?.port, state?.mode])

  useEffect(() => {
    setSlave(state?.network ? String(state.network.slaveId) : '')
    setIp(state?.network?.ip ?? '')
  }, [state?.port, state?.network?.ip])

  useEffect(() => {
    onDialog(
      browse ? (
        <FilePicker
          title="Open firmware"
          extensions={['.upd', '.bin', '.elf']}
          initialPath={firmware}
          list={(path) =>
            client.request<FileListing>({
              type: 'files',
              path,
              extensions: ['.upd', '.bin', '.elf'],
            })
          }
          onClose={() => setBrowse(false)}
          onSelect={(path) => {
            setFirmware(path)
            setBrowse(false)
          }}
        />
      ) : undefined,
    )

    return () => onDialog(undefined)
  }, [browse, firmware, client, onDialog])

  const send = async (item: AdapterConfigItem, value?: string) => {
    const result = (await run({
      type: 'adapter-config-command',
      item,
      value,
      expectedView: 'adapter-config',
    })) as AdapterConfigState | undefined

    if (!result) return

    if (item === 'mode' && value === undefined) setMode(result.mode)

    if ((item === 'ip' || item === 'mode') && value === undefined) {
      setSlave(result.network ? String(result.network.slaveId) : '')
      setIp(result.network?.ip ?? '')
    }
  }

  const network = networkFromIp(ip),
    networkValid = Boolean(network && networkFromSlave(slave)?.ip === network.ip)

  const editSlave = (value: string) => {
    setSlave(value)

    const next = networkFromSlave(value)

    if (next) setIp(next.ip)
  }

  const editIp = (value: string) => {
    setIp(value)

    const next = networkFromIp(value)

    if (next) setSlave(String(next.slaveId))
  }

  return (
    <Card title="Adapter Config">
      <Box flexDirection="column" gap={1} paddingTop={1}>
        {!state ? (
          <Box flexDirection="column" gap={1}>
            {!ports.length ? (
              <Box gap={1} alignItems="center" flexWrap="wrap">
                <Text color={colors.text}>
                  {discovering ? 'Finding USB CDC devices...' : 'No USB CDC devices'}
                </Text>
                <Button
                  size="medium"
                  label="Refresh"
                  disabled={!enabled || discovering}
                  onPress={() => void refresh()}
                />
              </Box>
            ) : null}

            {discoveryError ? <Text color={colors.danger}>{discoveryError}</Text> : null}

            {ports.length || !discovering ? (
              <Box gap={1} alignItems="flex-end" flexWrap="wrap">
                {ports.length ? (
                  <Dropdown
                    label="USB CDC device"
                    autoFocus
                    width={w}
                    value={port}
                    options={ports.map((p) => ({ value: p.port, label: `${p.port} — ${p.name}` }))}
                    onChange={setPort}
                  />
                ) : (
                  <Box flexDirection="column">
                    <FieldLabel>Serial port</FieldLabel>
                    <TextInput
                      autoFocus
                      size="large"
                      width={w}
                      value={port}
                      onChange={setPort}
                      disabled={!enabled || discovering}
                    />
                  </Box>
                )}

                {ports.length ? (
                  <Button
                    size="medium"
                    label="Refresh"
                    disabled={!enabled || discovering}
                    onPress={() => void refresh()}
                  />
                ) : null}

                <Button
                  size="medium"
                  variant="success"
                  label="Open"
                  disabled={!enabled || discovering || !port.trim()}
                  onPress={() =>
                    void run({
                      type: 'adapter-config-open',
                      port: port.trim(),
                      expectedView: 'adapter-config',
                    })
                  }
                />
              </Box>
            ) : null}
          </Box>
        ) : (
          <>
            <Box gap={1} flexWrap="wrap">
              <Text color={colors.text}>{state.port}</Text>
              <Button
                size="small"
                label="Close"
                disabled={!enabled}
                onPress={() => void run({ type: 'adapter-config-close' })}
              />
              <Button
                size="small"
                label="Read version"
                disabled={!enabled}
                onPress={() => send('version')}
              />
              <Button
                size="small"
                variant="warning"
                label="Reboot"
                disabled={!enabled}
                onPress={() => send('reboot')}
              />
            </Box>
            <Box gap={1} alignItems="flex-end" flexWrap="wrap">
              <Dropdown
                autoFocus
                label="Device mode"
                width={Math.min(w, 32)}
                value={mode}
                options={adapterModes.map((value) => ({ value, label: value }))}
                onChange={(value) => {
                  setMode(value as AdapterMode)

                  if (value === 'enet') void send('ip')
                }}
              />
              <Button size="medium" label="Read" disabled={!enabled} onPress={() => send('mode')} />
              <Button
                size="medium"
                variant="primary"
                label="Apply"
                disabled={!enabled}
                onPress={() => send('mode', mode)}
              />
            </Box>
            {mode === 'enet' ? (
              <Box gap={1} alignItems="flex-end" flexWrap="wrap">
                <Box flexDirection="column">
                  <FieldLabel>Slave ID</FieldLabel>
                  <TextInput
                    size="large"
                    width={16}
                    value={slave}
                    onChange={editSlave}
                    disabled={!enabled}
                  />
                </Box>
                <Box flexDirection="column">
                  <FieldLabel>IPv4 address</FieldLabel>
                  <TextInput
                    size="large"
                    width={24}
                    value={ip}
                    onChange={editIp}
                    disabled={!enabled}
                  />
                </Box>
                <Button size="medium" label="Read" disabled={!enabled} onPress={() => send('ip')} />
                <Button
                  size="medium"
                  variant="primary"
                  label="Apply"
                  disabled={!enabled || !networkValid}
                  onPress={() => send('ip', ip)}
                />
              </Box>
            ) : null}
            <Box gap={1} alignItems="flex-end" flexWrap="wrap">
              <Box flexDirection="column">
                <FieldLabel>Firmware file</FieldLabel>
                <TextInput
                  size="large"
                  width={w}
                  value={firmware}
                  onChange={setFirmware}
                  disabled={!enabled}
                />
              </Box>
              <Button
                size="medium"
                label="Browse"
                disabled={!enabled}
                onPress={() => setBrowse(true)}
              />
              <Button
                size="medium"
                variant="warning"
                label="Download"
                disabled={!enabled || !/\.(upd|bin|elf)$/i.test(firmware)}
                onPress={() => send('download', firmware)}
              />
            </Box>
          </>
        )}
      </Box>
    </Card>
  )
}
