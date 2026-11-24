// SPDX-License-Identifier: MIT
import React from 'react'
import {Text} from 'ink'
import {colors} from '../theme.js'

/** Form captions always use the theme rather than the terminal's default color. */
export function FieldLabel({children,bold=false}:{children:React.ReactNode;bold?:boolean}){
 return <Text color={colors.label} bold={bold}>{children}</Text>
}
