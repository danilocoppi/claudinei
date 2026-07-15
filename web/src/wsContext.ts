import { createContext } from 'react'

export const WsContext = createContext<{ send(msg: object): void } | null>(null)
