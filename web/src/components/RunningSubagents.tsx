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
export function RunningSubagents({
  items, backgroundTasks = [],
}: {
  items: ChatItem[]
  /** Subagentes de background, vindos do status da sessão (ver nota abaixo). */
  backgroundTasks?: { id: string; description: string; type: string; prompt: string }[]
}) {
  const { t } = useTranslation()
  const [openId, setOpenId] = useState<string | null>(null)
  const fromChat = runningSubagents(items)
  // Um subagente de background não é detectável pelo chat: seu tool_call recebeu
  // resultado no instante do despacho e ele segue rodando depois do turno. Quem
  // sabe dele é o servidor, que acompanha os eventos de task do CLI.
  const seen = new Set(fromChat.map((s) => s.id))
  const running = [
    ...fromChat,
    ...backgroundTasks
      .filter((b) => !seen.has(b.id))
      .map((b) => ({ id: b.id, description: b.description, type: b.type, prompt: b.prompt, activity: [] as ChatItem[] })),
  ]
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
                  {/* Sem tipo, prompt nem atividade o painel saía como um retângulo
                      em branco — nada indicava se era erro ou ausência de dado. */}
                  {!s.type && !s.prompt && s.activity.length === 0 && (
                    <div className="subagent__prompt">{t('chat.subagentNoDetail')}</div>
                  )}
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
