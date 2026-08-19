import type { SessionInfo } from '../types'
import { isWaitingForYou } from '../engineSession'

/**
 * O rosto do agente.
 *
 * Substitui a bolinha de status no cartão: um ponto colorido diz que ALGO está
 * acontecendo, um rosto diz que tem alguém ali — e é isso que um terminal com um
 * agente dentro é. O desenho é nosso de propósito; a forma é simples justamente
 * para o ESTADO ser o que salta aos olhos, não o desenho.
 *
 * O estado vai num atributo (`data-face`) e quem desenha é o CSS, como já fazemos
 * com `data-theme`: acrescentar uma expressão nova não mexe neste arquivo.
 */
export type FaceState = 'idle' | 'working' | 'waiting' | 'starting' | 'asleep'

/** Traduz a sessão em expressão. Sem sessão, o rosto dorme. */
export function faceStateOf(session: SessionInfo | undefined): FaceState {
  if (!session) return 'asleep'
  if (isWaitingForYou(session)) return 'waiting'
  if (session.status === 'working') return 'working'
  if (session.status === 'in_terminal' && session.terminalActivity === 'working') return 'working'
  if (session.status === 'starting') return 'starting'
  if (session.status === 'stopped' || session.status === 'dead') return 'asleep'
  return 'idle'
}

export function AgentFace({ state, size = 18, title }: { state: FaceState; size?: number; title?: string }) {
  return (
    <span className="agent-face" data-face={state} title={title} style={{ width: size, height: size }}>
      <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
        {/* A cabeça herda `currentColor` para pegar a cor do próprio terminal. */}
        <rect className="agent-face__head" x="2" y="3" width="20" height="18" rx="7" fill="currentColor" />
        {/* Os olhos são vazados na cor do fundo — o mesmo truque de recorte que faz
            um rosto se ler em 18px sem virar um borrão. */}
        {/* Elipse, e não círculo: é `ry` que permite ACHATAR o olho até virar uma
            pálpebra fechada — o sinal universal de "dormindo". */}
        <g className="agent-face__eyes">
          <ellipse className="agent-face__eye" cx="8.6" cy="12" rx="2.1" ry="2.1" />
          <ellipse className="agent-face__eye" cx="15.4" cy="12" rx="2.1" ry="2.1" />
        </g>
      </svg>
    </span>
  )
}
