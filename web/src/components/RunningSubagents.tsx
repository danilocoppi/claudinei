import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { runningSubagents } from '../subagents'
import type { ChatItem } from '../types'

/**
 * Subagentes em execução, logo acima do indicador de "processando".
 *
 * Enquanto um Agent roda, o chat principal fica em silêncio — o trabalho todo
 * acontece dentro dele. Esta faixa responde "quantos estão trabalhando e no
 * quê", e cada chip expande para a tarefa que foi dada e o que ele já executou.
 *
 * Quem renderiza deve montar isto só com a sessão em `working`: num turno
 * interrompido o tool_call fica sem resultado para sempre, e a lista passaria a
 * afirmar que há alguém trabalhando quando não há.
 */
export function RunningSubagents({ items }: { items: ChatItem[] }) {
  const { t } = useTranslation()
  const [openId, setOpenId] = useState<string | null>(null)
  const running = runningSubagents(items)
  if (running.length === 0) return null

  return (
    <div className="subagents" data-testid="running-subagents">
      <div className="subagents__head">
        <span aria-hidden="true">⚡</span>
        {t('chat.subagentsRunning', { count: running.length })}
      </div>
      <div className="subagents__chips">
        {running.map((s) => {
          const open = openId === s.id
          // Sem description (o campo é opcional na tool) o chip cairia vazio e
          // não daria para clicar: o tipo serve de rótulo de reserva.
          const label = s.description || s.type || t('chat.subagent')
          return (
            <div key={s.id} className={`subagent${open ? ' open' : ''}`}>
              <button
                type="button"
                className="subagent__chip"
                aria-expanded={open}
                onClick={() => setOpenId(open ? null : s.id)}
              >
                <span className="subagent__spinner" aria-hidden="true" />
                <span className="subagent__label">{label}</span>
                <span className="subagent__count">{s.activity.length}</span>
              </button>
              {open && (
                <div className="subagent__detail">
                  {s.type && <div className="subagent__type">{s.type}</div>}
                  {s.prompt && <div className="subagent__prompt">{s.prompt}</div>}
                  {s.activity.length > 0 && (
                    <ul className="subagent__activity">
                      {s.activity.map((a, i) => (
                        <li key={i}>
                          {a.kind === 'tool_call'
                            ? a.name
                            : a.kind === 'assistant_text' || a.kind === 'thinking'
                            ? a.text.slice(0, 90)
                            : a.kind}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
