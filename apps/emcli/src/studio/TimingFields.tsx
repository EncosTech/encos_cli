// SPDX-License-Identifier: MIT
import React from 'react'
import {Box} from 'ink'
import {Dropdown} from '../tui/components/Dropdown.js'
import {TwoColumns,useColumnWidth} from '../tui/components/TwoColumns.js'
import {TIMING_FIELDS} from './bus-timing.js'
import type {AdapterTiming} from './protocol.js'
interface Props {value:AdapterTiming;onChange(value:AdapterTiming):void;width?:number;defaultLabel?:string}
function TimingField({field,value,onChange,defaultLabel='Driver default'}:Props&{field:typeof TIMING_FIELDS[number]}){
 const width=useColumnWidth(),selected=value[field.key]
 const values=[...field.values] as number[];if(selected!==undefined&&!values.includes(selected))values.push(selected)
 return <Dropdown width={width} label={field.label.replace(' sample point',' sample (%)')} value={selected===undefined?'':String(selected)} options={[{value:'',label:defaultLabel},...values.map(n=>({value:String(n),label:field.rate?n>=1000000?`${n/1000000} Mbit/s`:`${n/1000} kbit/s`:`${Number((n*100).toFixed(3))}%`}))]} onChange={next=>{const changed={...value};if(next==='')delete changed[field.key];else changed[field.key]=Number(next);onChange(changed)}}/>
}
export function TimingFields({width=48,...props}:Props){
 return <Box width={width} flexShrink={1} minWidth={0}><TwoColumns minColumnWidth={23} fallbackWidth={width} gap={2} rowGap={0}>{TIMING_FIELDS.map(field=><TimingField key={field.key} field={field} {...props}/>)}</TwoColumns></Box>
}
