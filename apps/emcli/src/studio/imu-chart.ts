// SPDX-License-Identifier: MIT
import {colors} from '../tui/theme.js'
import type {ChartStore} from '../tui/chart-store.js'
import type {DeviceSample} from './protocol.js'
export const IMU_GROUPS = [
 {value:'acceleration',label:'Acceleration',unit:'m/s²',components:['x','y','z']},
 {value:'angularVelocity',label:'Angular velocity',unit:'deg/s',components:['x','y','z']},
 {value:'eulerAngle',label:'Euler angles',unit:'deg',components:['pitch','roll','heading']},
] as const
export const IMU_SERIES=IMU_GROUPS.flatMap(group=>group.components.map((component,i)=>({
 id:`${group.value}:${component}`,label:`${component.length===1?component.toUpperCase():component[0].toUpperCase()+component.slice(1)} (${group.unit})`,color:[colors.primary,colors.accent,colors.cyan][i],
})))
export function appendImuSample(store:ChartStore,sample:DeviceSample,deviceKey:string){
 if(sample.kind!=='imu'||sample.deviceKey!==deviceKey)return
 store.appendMany(IMU_GROUPS.flatMap(group=>group.components.map(component=>({
  seriesId:`${group.value}:${component}`,timestamp:sample.timestamp,
  value:(sample.status[group.value] as Record<string,number>|undefined)?.[component]??NaN,
 }))))
}
