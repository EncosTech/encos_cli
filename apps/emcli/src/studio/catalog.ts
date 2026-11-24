// SPDX-FileCopyrightText: 2026 Encos
// SPDX-License-Identifier: MIT
import type { ControlMode } from './protocol.js'
export interface Setting {id:string;label:string;fields:string[];readable?:boolean;writable?:boolean;integer?:boolean;unit?:string}
export const SETTINGS: Setting[] = [
 {id:'id',label:'CAN ID',fields:['ID'],readable:false,integer:true},
 {id:'position',label:'Position',fields:['Degrees'],unit:'deg'},
 {id:'kt',label:'Torque constant',fields:['Kt'],writable:false},
 ...['kp','kd','pos','spd','tor','cur'].map(name=>({id:`pvt-${name}-range`,label:`PVT ${name.toUpperCase()} range`,fields:['Min','Max'],integer:name==='kp'||name==='kd',unit:name==='pos'?'rad':undefined})),
 {id:'cur-pi',label:'Current PI',fields:['Kp','Ki']},
 {id:'spd-pi',label:'Speed PI',fields:['Kp','Ki']},
 {id:'pos-pd',label:'Position PD',fields:['Kp','Kd']},
 {id:'can-timeout',label:'CAN timeout',fields:['Milliseconds'],integer:true},
 {id:'comm',label:'Communication mode',fields:['can / canfd / canopen'],readable:false},
]
export function supportsDexHandJointSetting(item: string) {
 return !['id', 'can-timeout', 'comm'].includes(item)
}
export const CONTROLS: Array<{id:ControlMode;label:string;fields:Array<{label:string;min:number;max:number;value:number;range?:string}>}> = [
 {id:'pvt',label:'PVT',fields:[{label:'Kp',min:0,max:500,value:1,range:'pvt-kp-range'},{label:'Kd',min:0,max:10,value:1,range:'pvt-kd-range'},{label:'Position (deg)',min:-180,max:180,value:0,range:'pvt-pos-range'},{label:'Speed (rad/s)',min:-100,max:100,value:0,range:'pvt-spd-range'},{label:'Torque (Nm)',min:-10,max:10,value:0,range:'pvt-tor-range'}]},
 {id:'position',label:'Position',fields:[{label:'Position (deg)',min:-180,max:180,value:0,range:'pvt-pos-range'},{label:'Speed (rad/s)',min:0,max:100,value:0},{label:'Current (A)',min:0,max:10,value:0}]},
 {id:'speed',label:'Speed',fields:[{label:'Speed (rad/s)',min:-100,max:100,value:0,range:'pvt-spd-range'},{label:'Current (A)',min:0,max:10,value:0}]},
 {id:'current',label:'Current',fields:[{label:'Current (A)',min:-10,max:10,value:0,range:'pvt-cur-range'}]},
 {id:'torque',label:'Torque',fields:[{label:'Torque (Nm)',min:-10,max:10,value:0,range:'pvt-tor-range'}]},
 {id:'stop',label:'Stop',fields:[{label:'Current (A)',min:0,max:10,value:0}]},
]
export function validateSetting(item:string, values:string[]): void {
 const setting=SETTINGS.find(setting=>setting.id===item)
 if(!setting||setting.writable===false) throw new Error('This setting is read-only or unknown')
 if(item==='position' && values.length===0) return
 if(values.length!==setting.fields.length) throw new Error(`${setting.label} requires ${setting.fields.length} value(s)`)
 if(item==='comm') {if(!['can','canfd','canopen'].includes(values[0])) throw new Error('Choose can, canfd, or canopen');return}
 const numbers=values.map(value=>value.trim()===''?NaN:Number(value))
 if(numbers.some(value=>!Number.isFinite(value))) throw new Error('Enter finite numeric values')
 if(setting.integer && numbers.some(value=>!Number.isInteger(value)||value<0||value>65535)) throw new Error('Enter integers between 0 and 65535')
 if(item==='id' && (numbers[0]<1||numbers[0]>2047)) throw new Error('CAN ID must be between 1 and 2047')
 if(item.endsWith('-range')&&numbers[0]>=numbers[1]) throw new Error('Minimum must be less than maximum')
 if(item.endsWith('-pi')||item.endsWith('-pd')) if(numbers.some(value=>value<0)) throw new Error('Gains must not be negative')
}
export function validateControl(mode:ControlMode,values:number[],stopMode?:string): void {
 const definition=CONTROLS.find(item=>item.id===mode)
 if(!definition||values.length!==definition.fields.length||values.some(value=>!Number.isFinite(value))) throw new Error('Invalid control parameters')
 if(mode==='stop'&&!['full','dynamic','regenerative'].includes(stopMode??'full')) throw new Error('Invalid stop mode')
 if(mode==='pvt'&&(values[0]<0||values[1]<0)) throw new Error('Kp and Kd must not be negative')
 if(mode==='position'&&(values[1]<0||values[2]<0)||mode==='speed'&&values[1]<0||mode==='stop'&&values[0]<0) throw new Error('Limits must not be negative')
}
