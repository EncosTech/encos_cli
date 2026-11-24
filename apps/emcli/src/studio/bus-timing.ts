// SPDX-License-Identifier: MIT
import type {AdapterTiming} from './protocol.js'
export const TIMING_FIELDS = [
 {key:'bitrate',label:'Arbitration bitrate',values:[125000,250000,500000,1000000],rate:true},
 {key:'sample_point',label:'Arbitration sample point',values:[0.5,0.625,0.75,0.8,0.875,0.882,0.9],rate:false},
 {key:'dbitrate',label:'Data bitrate',values:[1000000,2000000,4000000,5000000,8000000],rate:true},
 {key:'dsample_point',label:'Data sample point',values:[0.5,0.625,0.75,0.8,0.875,0.882,0.9],rate:false},
] as const
export function validateTiming(timing:AdapterTiming,required=false):AdapterTiming {
 if(!timing||typeof timing!=='object'||Array.isArray(timing))throw new Error('Invalid bus timing')
 const result:AdapterTiming={}
 for(const [key,value] of Object.entries(timing)){
  const field=TIMING_FIELDS.find(field=>field.key===key)
  if(!field)throw new Error(`Unknown timing field: ${key}`)
  if(value===undefined)continue
  if(typeof value!=='number'||!Number.isFinite(value)||(field.rate? !Number.isInteger(value)||value<1||value>10000000 : value<=0||value>1))throw new Error(`Invalid ${field.label.toLowerCase()}`)
  result[field.key]=value
 }
 if(required&&!Object.keys(result).length)throw new Error('Choose at least one timing value')
 return result
}
// Native object conversion treats JS numbers as doubles. A JSON string preserves
// integer bitrate tokens required by the adapter timing parsers.
export const timingEnvelope=(slaveId:number|null,busId:number,timing:AdapterTiming)=>JSON.stringify({buses:{[`${slaveId??0}:${busId}`]:validateTiming(timing,true)}})
