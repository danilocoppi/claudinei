import { useContext, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { WsContext } from '../wsContext'
import type { PendingQuestion } from '../types'

/** Marcador interno da linha "Outra resposta…". Nunca vai para a engine — só o texto digitado vai. */
const OTHER = '__other__'

interface Draft { picked: Set<string>; other: string }

/**
 * Resposta final de UMA pergunta no formato que a CLI espera: rótulos separados
 * por ", " (múltipla) ou um só (simples); o texto livre substitui na simples e
 * soma na múltipla. Vazio = ainda não respondida.
 */
export function answerOf(d: Draft | undefined, multi: boolean): string {
  if (!d) return ''
  const labels = [...d.picked].filter((l) => l !== OTHER)
  const free = d.picked.has(OTHER) ? d.other.trim() : ''
  if (!multi) return d.picked.has(OTHER) ? free : (labels[0] ?? '')
  return [...labels, ...(free ? [free] : [])].join(', ')
}

/**
 * A pergunta do agente (AskUserQuestion), acima da caixa de mensagem — o mesmo
 * lugar do diálogo no terminal. Três faixas: cabeçalho (título + progresso),
 * corpo (um passo numerado por pergunta, a pergunta em destaque, opções com
 * descrição e a linha de resposta livre) e rodapé (Anterior/Próxima à esquerda,
 * Responder pelo chat/Enviar à direita). Enviar só quando todas foram respondidas.
 *
 * Não há "erro inline": o servidor confirma pelo session_status (a pendência
 * some e o painel com ela). Se nada voltar em 5 s — pergunta já respondida em
 * outra aba, WS caiu —, os botões destravam para tentar de novo.
 */
export function QuestionPanel({ localId, pending }: { localId: string; pending: PendingQuestion }) {
  const { t } = useTranslation()
  const ws = useContext(WsContext)
  const [tab, setTab] = useState(0)
  const [drafts, setDrafts] = useState<Record<number, Draft>>({})
  const [busy, setBusy] = useState(false)

  // Pergunta nova (outro toolUseId): rascunhos e passo voltam ao zero.
  useEffect(() => { setTab(0); setDrafts({}); setBusy(false) }, [pending.toolUseId])
  useEffect(() => {
    if (!busy) return
    const timer = setTimeout(() => setBusy(false), 5000)
    return () => clearTimeout(timer)
  }, [busy])

  const qs = pending.questions
  const idx = Math.min(tab, qs.length - 1)
  const q = qs[idx]
  // Defesa: `questions` vem inteiro da engine (wire data) — um array vazio não
  // pode derrubar o componente com `q` undefined.
  if (!q) return null
  const answers = qs.map((qq, i) => answerOf(drafts[i], qq.multiSelect))
  const done = answers.filter(Boolean).length
  const complete = done === qs.length
  const last = idx === qs.length - 1
  const d = drafts[idx]
  const title = qs.length === 1 ? t('question.titleOne') : t('question.titleMany', { count: qs.length })

  const go = (i: number) => setTab(Math.max(0, Math.min(qs.length - 1, i)))
  const toggle = (label: string) => setDrafts((all) => {
    const cur = all[idx] ?? { picked: new Set<string>(), other: '' }
    const picked = new Set(q.multiSelect ? cur.picked : [])
    if (q.multiSelect && cur.picked.has(label)) picked.delete(label)
    else picked.add(label)
    return { ...all, [idx]: { ...cur, picked } }
  })
  const setOther = (text: string) => setDrafts((all) => {
    const cur = all[idx] ?? { picked: new Set<string>(), other: '' }
    return { ...all, [idx]: { other: text, picked: new Set([...cur.picked, OTHER]) } }
  })

  const submit = () => {
    if (!complete || busy) return
    const map: Record<string, string> = {}
    qs.forEach((qq, i) => { map[qq.question] = answers[i] })
    setBusy(true)
    ws?.send({ type: 'answer_question', localId, answers: map })
  }
  const dismiss = () => {
    if (busy) return
    setBusy(true)
    ws?.send({ type: 'dismiss_question', localId })
  }
  // Enter no campo livre: segue para a próxima pergunta; na última, envia.
  const onFreeEnter = () => { if (last) submit(); else go(idx + 1) }

  const kind = q.multiSelect ? 'checkbox' : 'radio'
  return (
    <div className="qpanel" role="group" data-testid="question-panel" aria-label={title}>
      <div className="qpanel__head">
        <span className="qpanel__badge" aria-hidden="true">?</span>
        <span className="qpanel__title">{title}</span>
        {qs.length > 1 && <span className="qpanel__progress">{t('question.progress', { done, total: qs.length })}</span>}
      </div>
      <div className="qpanel__body">
        {qs.length > 1 && (
          <div className="qpanel__tabs" role="tablist">
            {qs.map((qq, i) => (
              // data-n vira o número do passo via CSS (::before) — e ✓ na respondida —
              // sem sujar o texto da aba, que é o `header` da pergunta.
              <button key={i} type="button" role="tab" aria-selected={i === idx} data-n={i + 1}
                      className={`qpanel__tab ${i === idx ? 'active' : ''} ${answers[i] ? 'done' : ''}`}
                      onClick={() => go(i)}>{qq.header}</button>
            ))}
          </div>
        )}
        <div className="qpanel__q">
          <div className="qpanel__question">{q.question}</div>
          <div className="qpanel__hint">{q.multiSelect ? t('question.pickMany') : t('question.pickOne')}</div>
        </div>
        <ul className="qpanel__opts">
          {q.options.map((o, i) => (
            // key pelo índice: o rótulo vem da engine e duas opções podem repeti-lo
            // (o.label não é garantidamente único).
            <li key={i}>
              <label className="qpanel__opt">
                <input type={kind} name={`q-${idx}`} checked={!!d?.picked.has(o.label)} onChange={() => toggle(o.label)} />
                <span>
                  <span className="qpanel__opt-label">{o.label}</span>
                  {o.description && <div className="qpanel__opt-desc">{o.description}</div>}
                </span>
              </label>
            </li>
          ))}
          <li>
            <label className="qpanel__opt">
              <input type={kind} name={`q-${idx}`} checked={!!d?.picked.has(OTHER)} onChange={() => toggle(OTHER)} />
              <span style={{ flex: 1 }}>
                <span className="qpanel__opt-label">{t('question.other')}</span>
                {d?.picked.has(OTHER) && (
                  <input className="qpanel__free" autoFocus value={d.other} placeholder={t('question.otherPlaceholder')}
                         onChange={(e) => setOther(e.target.value)}
                         onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onFreeEnter() } }} />
                )}
              </span>
            </label>
          </li>
        </ul>
      </div>
      <div className="qpanel__foot">
        {qs.length > 1 && (
          <div className="qpanel__nav">
            <button type="button" className="ghost qpanel__navbtn" disabled={idx === 0} onClick={() => go(idx - 1)}>
              <span aria-hidden="true">‹</span> {t('question.prev')}
            </button>
            <button type="button" className="ghost qpanel__navbtn" disabled={last} onClick={() => go(idx + 1)}>
              {t('question.next')} <span aria-hidden="true">›</span>
            </button>
          </div>
        )}
        <div className="qpanel__actions">
          <button type="button" className="ghost" disabled={busy} onClick={dismiss}>{t('question.answerInChat')}</button>
          <button type="button" disabled={!complete || busy} onClick={submit}>{t('question.submit')}</button>
        </div>
      </div>
    </div>
  )
}
