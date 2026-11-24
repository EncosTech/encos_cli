// SPDX-License-Identifier: MIT
import React, {useEffect, useState} from 'react'
import {Box, Text, useWindowSize} from 'ink'
import {useRestoreFocus} from '../navigation.js'
import {colors} from '../theme.js'

const frames=['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏']
export function Spinner() {
 const [frame,setFrame]=useState(0)
 useEffect(()=>{const timer=setInterval(()=>setFrame(value=>(value+1)%frames.length),80);return()=>clearInterval(timer)},[])
 return <Text color={colors.primary}>{frames[frame]}</Text>
}
/** Render as DialogHost's dialog to block background interaction while work is pending. */
export function LoadingOverlay({label}:{label:string}) {
 useRestoreFocus()
 const {columns,rows}=useWindowSize()
 return <Box position="absolute" left={0} top={0} width={columns} height={rows} alignItems="center" justifyContent="center">
  <Box width={Math.min(36,columns)} flexDirection="column" alignItems="center" borderStyle="single" borderColor={colors.primary} borderBackgroundColor={colors.surface} backgroundColor={colors.surface} paddingX={1} paddingY={1}>
   <Spinner/><Text color={colors.text}>{label}</Text>
  </Box>
 </Box>
}
