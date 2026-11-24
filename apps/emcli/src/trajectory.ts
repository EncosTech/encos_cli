// SPDX-License-Identifier: MIT

import { readFileSync } from 'node:fs'

import { parseMotorConnection } from './target.js'

export interface TrajectorySample {
  timeSec: number
  positionsDeg: number[]
}

export interface TrajectoryMotor {
  name: string
  adapterType: string
  adapterId: string
  slaveId?: number
  busId: number
  motorId: number
}

export interface Trajectory {
  motors: TrajectoryMotor[]
  samples: TrajectorySample[]
}


export function parseTrajectoryCsv(filePath: string): Trajectory {
  const content = readFileSync(filePath, 'utf8')
  const motors: TrajectoryMotor[] = []
  const samples: TrajectorySample[] = []
  let previousTime = 0
  let headerParsed = false

  for (const [lineIndex, rawLine] of content.split(/\r?\n/).entries()) {
    let line = rawLine.trim()
    const comment = line.indexOf('#')
    if (comment >= 0) line = line.slice(0, comment).trim()
    if (line === '') continue
    const columns = line.split(',').map(value => value.trim())
    if (!headerParsed) {
      if (columns.length < 2) {
        throw new Error('轨迹表头必须包含 time 和至少一个电机列')
      }
      if (columns[0] !== 'time') {
        throw new Error("轨迹第一列必须是 'time'")
      }
      for (let index = 1; index < columns.length; index += 1) {
        const connection = parseMotorConnection(columns[index])
        motors.push({ name: columns[index], ...connection })
      }
      headerParsed = true
      continue
    }
    if (columns.length !== motors.length + 1) {
      throw new Error(
        `第 ${lineIndex + 1} 行: 期望 ${motors.length + 1} 列，实际 ${columns.length} 列`,
      )
    }
    const timeSec = Number(columns[0])
    if (!Number.isFinite(timeSec)) {
      throw new Error(`第 ${lineIndex + 1} 行: time 不是有效数字`)
    }
    if (samples.length > 0 && timeSec <= previousTime) {
      throw new Error(`第 ${lineIndex + 1} 行: time 必须严格递增`)
    }
    previousTime = timeSec
    const positionsDeg = columns.slice(1).map((value, index) => {
      const parsed = Number(value)
      if (!Number.isFinite(parsed)) {
        throw new Error(`第 ${lineIndex + 1} 行: 第 ${index + 2} 列不是有效数字`)
      }
      return parsed
    })
    samples.push({ timeSec, positionsDeg })
  }

  if (!headerParsed) throw new Error('轨迹文件为空')
  if (samples.length === 0) throw new Error('轨迹文件没有采样点')
  return { motors, samples }
}
