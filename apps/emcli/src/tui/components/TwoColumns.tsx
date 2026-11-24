// SPDX-License-Identifier: MIT
import React,{createContext,useContext,useRef,type ReactNode} from 'react'
import {Box,useBoxMetrics,type DOMElement} from 'ink'
const ColumnWidth=createContext(52)
export const useColumnWidth=()=>useContext(ColumnWidth)
export interface TwoColumnsProps {children:ReactNode;minColumnWidth?:number;gap?:number;rowGap?:number;fallbackWidth?:number}
/** Measure the available parent width; keep children mounted as the layout wraps. */
export function TwoColumns({children,minColumnWidth=44,gap=2,rowGap=1,fallbackWidth=80}:TwoColumnsProps){
 const ref=useRef<DOMElement|null>(null),metrics=useBoxMetrics(ref)
 const width=Math.max(1,Math.floor(metrics.hasMeasured?metrics.width:fallbackWidth))
 const columns=width>=minColumnWidth*2+gap?2:1
 const column=columns===2?Math.floor((width-gap)/2):width
 return <Box ref={ref} width="100%" minWidth={0} flexDirection="row" flexWrap="wrap" columnGap={gap} rowGap={rowGap} flexShrink={0}>
  {React.Children.toArray(children).map((child,index)=><Box key={React.isValidElement(child)?child.key??index:index} width={column} minWidth={0} flexShrink={0} flexDirection="column"><ColumnWidth.Provider value={column}>{child}</ColumnWidth.Provider></Box>)}
 </Box>
}
