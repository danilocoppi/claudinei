import { useTranslation } from 'react-i18next'
import type { SessionInfo } from '../types'
import { isWaitingForYou } from '../engineSession'

/**
 * O rosto do agente, na anatomia do design "Rostos de Agente".
 *
 * Uma anatomia só — corpo, olhos, sombra. O que muda é o COMPORTAMENTO: ritmo da
 * respiração, direção do olhar e os adereços que entram em cena. Cada estado tem
 * o seu gesto, e nunca dois competindo.
 *
 * Tudo — corpo, olhos, sombra e adereços — é proporcional a `--face`, então o mesmo
 * componente serve à lista de 30px e ao cartão de 104px sem duas versões para
 * manter em sincronia.
 */
export type FaceState = 'idle' | 'working' | 'attention' | 'waiting' | 'uploading' | 'sleeping' | 'terminal'

/** A partir daqui o rosto cabe adereço com texto; abaixo, a tarja vira borrão. */
const POSTER = 56

/** Traduz a sessão em estado de rosto. Sem sessão, o agente dorme. */
export function faceStateOf(session: SessionInfo | undefined): FaceState {
  if (!session) return 'sleeping'
  // A vez é sua nos dois casos, mas o amarelo é RESERVADO a quem perguntou: o motor
  // parou e espera resposta. O terminal parado no prompt é o roxo — ele não perguntou
  // nada, só chegou ao fim da linha.
  if (isWaitingForYou(session)) return session.status === 'needs_attention' ? 'attention' : 'waiting'
  if (session.status === 'working') return 'working'
  if (session.status === 'in_terminal') {
    return session.terminalActivity === 'working' ? 'working' : 'terminal'
  }
  if (session.status === 'starting') return 'uploading'
  if (session.status === 'stopped' || session.status === 'dead') return 'sleeping'
  return 'idle'
}

/**
 * Os adereços que entram em cena por estado. Ficam FORA do corpo (o corpo é o
 * mesmo em todos), e é por eles que se distingue "subindo" de "ocioso" num relance.
 */
function Props({ state, size }: { state: FaceState; size: number }) {
  const { t } = useTranslation()
  switch (state) {
    case 'working':
      return (
        <>
          <span className="agent-face__ring" aria-hidden="true" />
          <span className="agent-face__sparks" aria-hidden="true"><i /><i /><i /></span>
        </>
      )
    case 'attention':
      return (
        <>
          <span className="agent-face__glow" aria-hidden="true" />
          <span className="agent-face__halo" aria-hidden="true" />
          <span className="agent-face__halo" aria-hidden="true" />
          {size >= POSTER && <span className="agent-face__pill">{t('status.yourTurn')}</span>}
        </>
      )
    case 'waiting':
      return <span className="agent-face__dots" aria-hidden="true"><i /><i /><i /></span>
    case 'sleeping':
      return <span className="agent-face__zzz" aria-hidden="true"><i>z</i><i>z</i><i>z</i></span>
    default:
      return null
  }
}

export function AgentFace({ state, size = 20, title }: { state: FaceState; size?: number; title?: string }) {
  return (
    <span className="agent-face" data-face={state} title={title} style={{ ['--face' as string]: `${size}px` }}>
      <span className="agent-face__shadow" aria-hidden="true" />
      <Props state={state} size={size} />
      <span className="agent-face__body">
        {/* As setas ficam DENTRO do corpo, atravessando-o: é o único adereço que
            o design põe por dentro, e é o que dá o sentido de "subindo". */}
        {state === 'uploading' && (
          <span className="agent-face__arrows" aria-hidden="true"><i /><i /><i /></span>
        )}
        <span className="agent-face__eyes">
          <i className="agent-face__eye" />
          <i className="agent-face__eye" />
        </span>
      </span>
    </span>
  )
}
