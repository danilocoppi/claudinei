import { memo, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { TurnDto } from '../../../../shared/undo'
import type { ChatItem } from '../../types'
import { declaredChanges, type DeclaredChange } from '../../undo/declared'
import type { PanelFocus } from './ChangesPanel'
import './undo.css'

const NONE: DeclaredChange[] = []

interface Props {
  turn: TurnDto
  /** Os itens do bloco do turno: só a linha sem git os lê (as declarações das ferramentas). */
  items: ChatItem[]
  onOpen(focus: PanelFocus): void
  onUndo(turn: TurnDto): void
  onRedo(turn: TurnDto): void
}

/**
 * A linha discreta no fim do bloco de um turno: "3 arquivos · +40 −12 · Ver
 * mudanças · Desfazer", com os selos do retrato. Sem git, as mudanças que as
 * ferramentas declararam e o aviso fixo. Turno em andamento ou sem mudança:
 * nada.
 *
 * Fica no chat ativo (a parte cara da página): memoizada, sem rede e sem
 * efeito. O diff só é buscado no painel, ao clicar num arquivo.
 */
function TurnLineImpl({ turn, items, onOpen, onUndo, onRedo }: Props) {
  const { t } = useTranslation()
  const noGit = turn.state === 'no_git'
  const declared = useMemo(() => (noGit ? declaredChanges(items) : NONE), [noGit, items])
  if (turn.state === 'running') return null

  if (noGit) {
    if (declared.length === 0) return null
    return (
      <div className="undo-line undo-line--declared" data-testid="undo-line">
        <span>{t('undo.line.declared')}</span>
        <span className="undo-line__sep">·</span>
        <span>{t('undo.line.files', { count: declared.length })}</span>
        <span className="undo-line__sep">·</span>
        <button type="button" className="undo-line__btn" onClick={() => onOpen({ declared })}>
          {t('undo.line.viewDeclared')}
        </button>
        <span className="undo-line__warn">{t('undo.line.noGit')}</span>
      </div>
    )
  }

  const s = turn.summary
  // Só o que fica fora da pasta do projeto não desenha linha: não há o que ver nem desfazer aqui.
  const changed = !!s && s.files + s.uncertain > 0
  const failed = turn.state === 'failed'
  const lost = turn.state === 'lost'
  // O retrato que falhou nunca tem resumo: o selo aparece sozinho, com o motivo.
  // O perdido aparece se mudou algo ou se sumiu antes do resumo.
  if (!changed && !failed && !(lost && !s)) return null
  const usable = changed && (turn.state === 'ok' || turn.state === 'late')
  const redo = !!turn.lastRun && !turn.lastRun.redone
  const late = turn.state === 'late'

  return (
    <div className="undo-line" data-testid="undo-line">
      {changed && s && (
        <>
          <span>{t('undo.line.files', { count: s.files })}</span>
          <span className="undo-line__sep">·</span>
          <span>{t('undo.line.stats', { added: s.added, removed: s.removed })}</span>
          {s.uncertain > 0 && (
            <>
              <span className="undo-line__sep">·</span>
              <span>{t('undo.line.uncertain', { count: s.uncertain })}</span>
            </>
          )}
        </>
      )}
      {usable && (
        <>
          <span className="undo-line__sep">·</span>
          <button type="button" className="undo-line__btn" onClick={() => onOpen({ turnId: turn.id })}>
            {t('undo.line.view')}
          </button>
          <span className="undo-line__sep">·</span>
          {redo ? (
            <button type="button" className="undo-line__btn" onClick={() => onRedo(turn)}>{t('undo.line.redo')}</button>
          ) : (
            <button type="button" className="undo-line__btn" disabled={late}
                    title={late ? t('undo.line.lateTitle') : undefined}
                    onClick={() => onUndo(turn)}>
              {t('undo.line.undo')}
            </button>
          )}
        </>
      )}
      {late && <span className="undo-badge">{t('undo.badge.late')}</span>}
      {failed && (
        <span className="undo-badge undo-badge--err">
          {turn.stateReason ? t('undo.badge.failed', { reason: turn.stateReason }) : t('undo.badge.failedNoReason')}
        </span>
      )}
      {lost && <span className="undo-badge undo-badge--err">{t('undo.badge.lost')}</span>}
      {turn.endKind === 'uncertain' && <span className="undo-badge">{t('undo.badge.uncertainEnd')}</span>}
      {s && s.outside > 0 && <span className="undo-badge undo-badge--dim">{t('undo.badge.outside', { count: s.outside })}</span>}
      {turn.limited && <span className="undo-line__warn">{t('undo.badge.limited')}</span>}
    </div>
  )
}

export const TurnLine = memo(TurnLineImpl)
