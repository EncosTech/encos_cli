// SPDX-License-Identifier: MIT
import { measureElement, type DOMElement } from 'ink'
/** Convert Yoga coordinates to painted coordinates, including ancestor scroll offsets. */
export function screenBox(node: DOMElement) {
  const box = { ...measureElement(node) }
  for (let parent = node.parentNode; parent; parent = parent.parentNode) {
    box.x -= parent.style.contentOffsetX ?? 0
    box.y -= parent.style.contentOffsetY ?? 0
  }
  return box
}
export function visibleBox(node: DOMElement) {
  const box = screenBox(node)
  let right = box.x + box.width, bottom = box.y + box.height
  for (let parent = node.parentNode; parent; parent = parent.parentNode) {
    const clip = screenBox(parent)
    if (parent.style.overflow === 'hidden' || parent.style.overflowX === 'hidden') {
      box.x = Math.max(box.x, clip.x); right = Math.min(right, clip.x + clip.width)
    }
    if (parent.style.overflow === 'hidden' || parent.style.overflowY === 'hidden') {
      box.y = Math.max(box.y, clip.y); bottom = Math.min(bottom, clip.y + clip.height)
    }
  }
  return { ...box, width: Math.max(0, right - box.x), height: Math.max(0, bottom - box.y) }
}
