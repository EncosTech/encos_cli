// SPDX-License-Identifier: MIT

import React, { useEffect, useState } from 'react'
import { Box, Text } from 'ink'
import { Card, Table } from '../tui/index.js'
import { colors } from '../tui/theme.js'
import type { StudioClient } from './protocol.js'
import { statisticsRows, type AdapterStatistics } from './adapter-statistics.js'

export function StatisticsPanel({
  adapterKey,
  client,
  width,
}: {
  adapterKey: string
  client: StudioClient
  width: number
}) {
  const [snapshot, setSnapshot] = useState<AdapterStatistics | null>(),
    [error, setError] = useState('')

  useEffect(() => {
    let disposed = false,
      timer: ReturnType<typeof setTimeout> | undefined

    setSnapshot(undefined)
    setError('')

    const poll = async () => {
      try {
        const next = await client.request<AdapterStatistics | null>({
          type: 'adapter-statistics',
          adapterKey,
        })

        if (!disposed) {
          setSnapshot(next)
          setError('')
        }
      } catch (error) {
        if (!disposed) {
          setSnapshot(null)
          setError((error as Error).message)
        }
      } finally {
        if (!disposed) timer = setTimeout(() => void poll(), 500)
      }
    }

    void poll()

    return () => {
      disposed = true

      if (timer) clearTimeout(timer)
    }
  }, [adapterKey, client])

  const rows = snapshot ? statisticsRows(snapshot) : []

  return (
    <Card title="Statistic">
      <Box flexDirection="column" flexShrink={0}>
        {error ? <Text color={colors.danger}>{error}</Text> : null}
        {snapshot ? (
          <Table
            rows={rows}
            height={rows.length}
            viewportWidth={Math.max(12, width - 6)}
            autoColumns
            rowKey={(r) => r.key}
            columns={[
              { key: 'slave', header: 'Slave', width: 6, value: (r) => r.slave },
              { key: 'bus', header: 'Bus', width: 5, value: (r) => r.bus },
              { key: 'status', header: 'Sample', width: 8, value: (r) => r.status },
              { key: 'age', header: 'Age (ms)', width: 9, value: (r) => r.age },
              { key: 'tx', header: 'TX errors', width: 10, value: (r) => r.tx },
              { key: 'rx', header: 'RX errors', width: 10, value: (r) => r.rx },
            ]}
            emptyText="Waiting for statistics"
          />
        ) : (
          <Text color={colors.text}>
            {snapshot === null ? 'Statistics unavailable' : 'Loading statistics...'}
          </Text>
        )}
      </Box>
    </Card>
  )
}
