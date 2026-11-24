// SPDX-License-Identifier: MIT

import { createContext, useContext } from 'react'
export const InteractionBlocked = createContext(false)
export const NotificationInteractionBlocked = createContext(false)
export const useInteractionBlocked = () => {
  const local = useContext(InteractionBlocked)
  const notification = useContext(NotificationInteractionBlocked)
  return local || notification
}
