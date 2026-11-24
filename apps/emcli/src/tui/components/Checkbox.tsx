// SPDX-License-Identifier: MIT
import React,{useId} from 'react'
import {Text,useInput} from 'ink'
import {MouseRegion} from '../mouse.js'
import {useSpatialFocus} from '../navigation.js'
import {useInteractionBlocked} from '../interaction.js'
import {colors} from '../theme.js'
export function Checkbox({label,checked,onChange,disabled=false}:{label:string;checked:boolean;onChange:(checked:boolean)=>void;disabled?:boolean}){
 const id=useId(),blocked=useInteractionBlocked(),{isFocused,focus}=useSpatialFocus({id,isActive:!blocked&&!disabled})
 const toggle=()=>{if(!disabled&&!blocked)onChange(!checked)}
 useInput((input,key)=>{if(!key.ctrl&&!key.meta&&key.eventType!=='release'&&(input===' '||key.return))toggle()},{isActive:isFocused&&!blocked&&!disabled})
 return <MouseRegion focusId={id} disabled={disabled} onPress={event=>{if(event.button==='left'){focus(id);toggle()}}}><Text color={disabled?colors.muted:colors.label} inverse={isFocused}>[{checked?'✓':' '}] {label}</Text></MouseRegion>
}
