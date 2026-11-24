// SPDX-License-Identifier: MIT
import {colors} from '../tui/theme.js'
import type {GraphMetric} from './protocol.js'
export const MOTOR_METRICS:Array<{value:GraphMetric;label:string;axisLabel:string;color:string}>=[
 {value:'position',label:'Position (deg)',axisLabel:'Position',color:colors.primary},
 {value:'speed',label:'Speed (rad/s)',axisLabel:'Speed',color:colors.accent},
 {value:'current',label:'Current (A)',axisLabel:'Current',color:colors.cyan},
 {value:'power',label:'Mechanical power (W)',axisLabel:'Power',color:colors.success},
]
