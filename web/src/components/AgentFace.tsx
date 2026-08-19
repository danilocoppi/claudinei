import type { SessionInfo } from '../types'
import { isWaitingForYou } from '../engineSession'

/**
 * O rosto do agente, na anatomia definida no design "Rostos de Agente": um corpo
 * redondo, dois olhos sempre no mesmo lugar e UM gesto por estado.
 *
 * Três regras vieram do design e explicam quase tudo aqui:
 *   · os olhos não mudam de lugar — muda a FORMA deles;
 *   · um gesto por estado, nunca dois competindo;
 *   · dormindo perde saturação, trabalhando ganha velocidade.
 *
 * A cor é do ESTADO, não do terminal. A identidade do terminal já está no trilho
 * colorido, no ícone e no nome; usar a cor para o estado é o que faz a lista ser
 * lida de relance.
 *
 * Em tamanho de lista o rosto larga os adereços (faíscas, anel, setas, zzz) e
 * guarda só cor, olhos e gesto — o texto ao lado do nome completa a leitura, para
 * ninguém precisar decifrar a animação.
 */
export type FaceState = 'idle' | 'working' | 'waiting' | 'uploading' | 'sleeping' | 'terminal'

/** Traduz a sessão em estado de rosto. Sem sessão, o agente dorme. */
export function faceStateOf(session: SessionInfo | undefined): FaceState {
  if (!session) return 'sleeping'
  if (isWaitingForYou(session)) return 'waiting'
  if (session.status === 'working') return 'working'
  if (session.status === 'in_terminal') {
    return session.terminalActivity === 'working' ? 'working' : 'terminal'
  }
  if (session.status === 'starting') return 'uploading'
  if (session.status === 'stopped' || session.status === 'dead') return 'sleeping'
  return 'idle'
}

export function AgentFace({ state, size = 20, title }: { state: FaceState; size?: number; title?: string }) {
  return (
    <span className="agent-face" data-face={state} title={title} style={{ ['--face' as string]: `${size}px` }}>
      <span className="agent-face__body">
        {/* Só o "subindo" tem adereço nesta escala: as setas atravessam o corpo,
            e sem elas o estado ficaria idêntico ao ocioso. */}
        {state === 'uploading' && (
          <span className="agent-face__arrows" aria-hidden="true">
            <i /><i />
          </span>
        )}
        <span className="agent-face__eyes">
          <i className="agent-face__eye" />
          <i className="agent-face__eye" />
        </span>
      </span>
    </span>
  )
}
