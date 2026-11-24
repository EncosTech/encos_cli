// SPDX-License-Identifier: MIT
import {FieldLabel} from './FieldLabel.js'
import React,{useEffect,useId,useMemo,useRef,useState} from 'react'
import {Box,Text,useInput,type DOMElement} from 'ink'
import {useSpatialFocus} from '../navigation.js'
import {useInteractionBlocked} from '../interaction.js'
import {MouseRegion,useMouseEvents} from '../mouse.js'
import {screenBox} from '../geometry.js'
import {clampOverlay,useOverlay} from '../overlay.js'
import {usePopupScroll} from '../popup-scroll.js'
import {Scrollbar} from './Scrollbar.js'
import {colors} from '../theme.js'
export interface TreeSelectNode {value:string;label:string;children?:TreeSelectNode[];selectable?:boolean;disabled?:boolean}
interface Base {label:string;nodes:TreeSelectNode[];width?:number;maxHeight?:number;autoFocus?:boolean;placeholder?:string}
export type TreeSelectProps=Base&({multiple?:false;value:string;onChange(value:string):void}|{multiple:true;cascade?:boolean;values:string[];onChange(values:string[]):void})
interface Row {node:TreeSelectNode;depth:number;parent?:string;path:string[];disabled:boolean}
function flatten(nodes:TreeSelectNode[],expanded?:Set<string>,depth=0,parent?:string,path:string[]=[],disabled=false):Row[]{
 return nodes.flatMap(node=>{const row={node,depth,parent,path:[...path,node.label],disabled:disabled||Boolean(node.disabled)};return [row,...(!expanded||expanded.has(node.value)?flatten(node.children??[],expanded,depth+1,node.value,row.path,row.disabled):[])]})
}
export function TreeSelect(props:TreeSelectProps){
 const {label,nodes,width=48,maxHeight=12,autoFocus=false,placeholder='Select…'}=props
 const all=useMemo(()=>flatten(nodes),[nodes]),treeKey=JSON.stringify(nodes)
 const [expanded,setExpanded]=useState(()=>new Set(all.filter(r=>r.node.children?.length).map(r=>r.node.value)))
 const rows=flatten(nodes,expanded),selected=props.multiple?props.values:[props.value]
 const [active,setActive]=useState(selected[0]||all[0]?.node.value),[open,setOpen]=useState(false),[hover,setHover]=useState<string>()
 const blocked=useInteractionBlocked(),id=useId(),ref=useRef<DOMElement|null>(null)
 const {isFocused,focus}=useSpatialFocus({id,autoFocus,isActive:!blocked},open?['up','down','left','right']:[])
 const {show,hide}=useOverlay(),[position,setPosition]=useState<{top:number;left:number}>()
 const index=Math.max(0,rows.findIndex(r=>r.node.value===active)),popup=usePopupScroll(rows.length,index,open?id:undefined,maxHeight)
 const selectedKey=JSON.stringify(selected)
 useEffect(()=>{if(!isFocused||blocked)setOpen(false)},[isFocused,blocked])
 const openMenu=()=>{
  const target=all.find(r=>r.node.value===selected[0])??all.find(r=>!r.disabled)
  if(target){const parents=new Set<string>();let row:Row|undefined=target;while(row?.parent){parents.add(row.parent);row=all.find(r=>r.node.value===row!.parent)}setExpanded(old=>new Set([...old,...parents]));setActive(target.node.value)}
  setOpen(true)
 }
 const selectable=(row:Row)=>!row.disabled&&(row.node.selectable??!row.node.children?.length)
 const cascade=props.multiple&&props.cascade
 const targets=(row:Row):string[]=>cascade&&row.node.children
  ?flatten(row.node.children,undefined,0,undefined,[],row.disabled).filter(child=>!child.node.children&&selectable(child)).map(child=>child.node.value)
  :[row.node.value]
 const toggle=(value:string)=>setExpanded(old=>{const next=new Set(old);if(next.has(value))next.delete(value);else next.add(value);return next})
 const commit=(row:Row)=>{
  if(row.disabled)return
  if(!selectable(row)){if(row.node.children?.length)toggle(row.node.value);return}
  if(props.multiple){const values=new Set(props.values),keys=targets(row),remove=keys.every(key=>values.has(key));for(const key of keys){if(remove)values.delete(key);else values.add(key)}props.onChange([...values])}
  else{props.onChange(row.node.value);setOpen(false)}
 }
 useInput((input,key)=>{
  if(key.eventType==='release')return
  if(key.escape){setOpen(false);return}
  if(!open){if(key.return)openMenu();return}
  const row=rows[index]
  if(!row)return
  if(key.return||input===' '){commit(row);return}
  if(key.rightArrow){if(row.node.children?.length){if(!expanded.has(row.node.value))toggle(row.node.value);else setActive(row.node.children[0].value)}return}
  if(key.leftArrow){if(row.node.children?.length&&expanded.has(row.node.value))toggle(row.node.value);else if(row.parent)setActive(row.parent);return}
  let next=index
  if(key.upArrow)next--;else if(key.downArrow)next++;else if(key.pageUp)next-=popup.capacity;else if(key.pageDown)next+=popup.capacity;else if(key.home)next=0;else if(key.end)next=rows.length-1;else return
  setActive(rows[Math.max(0,Math.min(rows.length-1,next))].node.value)
 },{isActive:isFocused&&!blocked})
 useEffect(()=>{
  if(!open||!ref.current){hide();setPosition(undefined);return}
  const box=screenBox(ref.current),pos=clampOverlay({x:box.x,y:box.y,height:box.height},{width,height:popup.height},popup.screen)
  setPosition(pos)
  show(<Box width={width} flexDirection="column" borderStyle={{topLeft:'├',top:'─',topRight:'┤',left:'│',right:'│',bottomLeft:'└',bottom:'─',bottomRight:'┘'}} borderColor={colors.borderFocus} borderBackgroundColor={colors.surface} backgroundColor={colors.surface}>
   <Box height={popup.capacity}><Box flexGrow={1} minWidth={0} flexDirection="column">{rows.length?rows.slice(popup.offset,popup.offset+popup.capacity).map(row=>{
    const current=row.node.value===rows[index]?.node.value,branch=Boolean(row.node.children?.length),keys=targets(row),checked=keys.length>0&&keys.every(key=>selected.includes(key)),partial=!checked&&keys.some(key=>selected.includes(key))
    return <Box key={row.node.value} height={1} paddingX={1} overflow="hidden" backgroundColor={current?colors.active:hover===row.node.value?colors.hover:colors.surface}><Text wrap="truncate" color={row.disabled?colors.muted:current?colors.onPrimary:colors.text}>{'  '.repeat(row.depth)}{branch?(expanded.has(row.node.value)?'▼ ':'▶ '):'  '}{selectable(row)?props.multiple?`[${checked?'✓':partial?'−':' '}] `:checked?'● ':'○ ':''}{row.node.label}</Text></Box>
   }):<Text color={colors.muted}>No options</Text>}</Box><Scrollbar contentSize={rows.length} viewportSize={popup.capacity} offset={popup.offset} onChange={popup.scroll}/></Box>
  </Box>,pos)
 },[open,active,cascade,treeKey,JSON.stringify([...expanded]),selectedKey,hover,width,popup.offset,popup.capacity,popup.screen.columns,popup.screen.rows])
 useEffect(()=>()=>hide(),[hide])
 useMouseEvents(event=>{
  if(blocked||!open||!position)return
  if(popup.handleScroll(event,position,width))return
  const inside=popup.inside(event,position,width),i=inside?popup.indexAt(event,position,width):undefined,row=i===undefined?undefined:rows[i]
  if(event.action==='move'){setHover(row?.node.value);return}
  if(event.action!=='press'||event.button!=='left')return
  if(!inside){setOpen(false);return}
  if(row){focus(id);setActive(row.node.value);const arrowX=position.left+2+row.depth*2;if(row.node.children?.length&&event.x<=arrowX+1)toggle(row.node.value);else commit(row)}
 })
 const caption=props.multiple?selected.length?`${selected.length} selected`:'none':all.find(r=>r.node.value===props.value)?.path.join(' / ')||placeholder
 return <Box width={width} flexDirection="column"><FieldLabel>{label}</FieldLabel><MouseRegion focusId={id} onPress={()=>{focus(id);if(open)setOpen(false);else openMenu()}}><Box ref={ref} width={width} borderStyle="single" borderColor={open||isFocused?colors.borderFocus:colors.border} borderBackgroundColor={colors.surface} backgroundColor={open?colors.active:colors.surface} paddingX={1} justifyContent="space-between"><Box flexGrow={1} minWidth={0}><Text wrap="truncate-start" color={colors.text}>{caption}</Text></Box><Text color={colors.text}>{open?'▲':'▼'}</Text></Box></MouseRegion></Box>
}
