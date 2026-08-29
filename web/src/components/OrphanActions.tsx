import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useStore } from '../store'
import { fetchRunningActions, type RunningAction } from '../api'

/** De quanto em quanto tempo se pergunta ao servidor o que continua de pé. */
export const INTERVALO_MS = 30_000

/**
 * O aviso de ação rodando sem janela na tela.
 *
 * A rede de segurança do processo esquecido. Fechar a janela mata, minimizar
 * mostra a pílula, e um F5 restaura o que estava aberto — mas nada disso alcança
 * quem entrou de OUTRO navegador, limpou o armazenamento ou usou uma aba anônima:
 * ali o deploy continua de pé no servidor sem nada na tela que o mostre, e quem
 * não sabe que ele existe não sabe onde procurar.
 *
 * Quem responde é o servidor, que é o único que sabe quais PTYs estão vivos — a
 * pergunta é de leitura pura (`isAlive`), então repeti-la não mexe em nada.
 */
export function OrphanActions() {
  const { t } = useTranslation()
  const runs = useStore((s) => s.actionRuns)
  const abrir = useStore((s) => s.openActionRun)
  const [vivas, setVivas] = useState<RunningAction[]>([])
  const [dispensado, setDispensado] = useState<number[]>([])

  useEffect(() => {
    let vivo = true
    const olha = () => { void fetchRunningActions().then((r) => { if (vivo) setVivas(r) }).catch(() => {}) }
    olha()
    const t = setInterval(olha, INTERVALO_MS)
    return () => { vivo = false; clearInterval(t) }
  }, [])

  // Só o que o operador não está vendo: o que já tem janela (aberta ou encolhida)
  // não é esquecido, é acompanhado. E o que ele mandou sumir fica sumido.
  const orfas = vivas.filter((v) =>
    !runs.some((r) => r.actionId === v.actionId) && !dispensado.includes(v.actionId))

  if (orfas.length === 0) return null

  return createPortal(
    <div className="orphan-actions" data-testid="orphan-actions">
      <span className="orphan-actions__dot" />
      <span className="orphan-actions__text">
        {t('actions.orphanWarning', { count: orfas.length })}
      </span>
      {orfas.map((o) => (
        <button
          key={o.actionId}
          className="orphan-actions__show"
          data-testid={`orphan-show-${o.actionId}`}
          title={o.projectName}
          onClick={() => abrir({ actionId: o.actionId, name: o.name, autoClose: false, attachOnly: true })}
        >
          {o.name}
        </button>
      ))}
      {/* Dispensar esconde o aviso, e não para nada: quem sabe que o processo está
          lá e quer que continue não deve ter de escolher entre matá-lo e conviver
          com um alerta permanente. */}
      <button
        className="orphan-actions__close"
        data-testid="orphan-dismiss"
        title={t('common.close')}
        onClick={() => setDispensado((d) => [...d, ...orfas.map((o) => o.actionId)])}
      >✕</button>
    </div>,
    document.body,
  )
}
