// SPDX-License-Identifier: MIT

import React, { useEffect, useRef, useState } from 'react'
import { Box, Text, useWindowSize } from 'ink'
import { Dialog } from './Dialog.js'
import { Button } from './Button.js'
import { TextInput } from './TextInput.js'
import { Table } from './Table.js'

export interface FilePickerListing {
  path: string
  parent: string
  entries: Array<{ name: string; path: string; directory: boolean }>
}

export function FilePicker({
  initialPath = '',
  title = 'Open CSV',
  extensions = ['.csv'],
  list,
  onSelect,
  onClose,
}: {
  initialPath?: string
  title?: string
  extensions?: readonly string[]
  list: (path: string) => Promise<FilePickerListing>
  onSelect: (path: string) => void
  onClose: () => void
}) {
  const { columns, rows } = useWindowSize(),
    [path, setPath] = useState(initialPath),
    [listing, setListing] = useState<FilePickerListing>(),
    [selected, setSelected] = useState<FilePickerListing['entries'][number]>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    generation = useRef(0)

  const load = async (next: string) => {
    const token = ++generation.current

    setBusy(true)
    setError('')

    try {
      const value = await list(next)

      if (token !== generation.current) return

      setListing(value)
      setPath(value.path)
      setSelected(undefined)
    } catch (error) {
      if (token === generation.current) setError((error as Error).message)
    } finally {
      if (token === generation.current) setBusy(false)
    }
  }

  useEffect(() => {
    void load(initialPath)

    return () => {
      generation.current++
    }
  }, [])

  const open = (item = selected) => {
    if (!item || busy) return

    if (item.directory) void load(item.path)
    else onSelect(item.path)
  }

  const dialogWidth = Math.min(88, columns),
    contentWidth = Math.max(12, dialogWidth - 6)

  const entries = (listing?.entries ?? []).filter(
    (entry) =>
      entry.directory ||
      extensions.some((extension) => entry.name.toLowerCase().endsWith(extension.toLowerCase())),
  )

  return (
    <Dialog
      title={title}
      width={dialogWidth}
      onClose={onClose}
      onConfirm={() => open()}
      confirmLabel={selected?.directory ? 'Open' : 'Select'}
    >
      <Box gap={1} alignItems="center" flexWrap="wrap">
        <TextInput
          size="small"
          width={Math.max(12, contentWidth - 22)}
          value={path}
          onChange={setPath}
          onSubmit={() => void load(path)}
        />
        <Button
          size="small"
          label="Go"
          onPress={() => {
            if (!busy) void load(path)
          }}
        />
        <Button
          size="small"
          label="Parent"
          disabled={!listing || listing.path === listing.parent}
          onPress={() => {
            if (listing && !busy) void load(listing.parent)
          }}
        />
      </Box>
      <Box marginTop={1}>
        <Table
          selectionKey={listing?.path}
          height={Math.max(1, Math.min(12, rows - 16))}
          rows={entries}
          rowKey={(r) => r.path}
          onSelect={setSelected}
          onActivate={open}
          onRowClick={(entry) => {
            if (entry.directory) open(entry)
            else setSelected(entry)
          }}
          emptyText={busy ? 'Loading...' : 'No matching files or folders'}
          columns={[
            {
              key: 'name',
              header: `Name (${extensions.join(', ')})`,
              width: Math.max(8, contentWidth - 5),
              value: (r) => `${r.directory ? '▶ ' : '  '}${r.name}${r.directory ? '/' : ''}`,
            },
          ]}
        />
      </Box>
      {error ? <Text color="red">{error}</Text> : null}
    </Dialog>
  )
}
