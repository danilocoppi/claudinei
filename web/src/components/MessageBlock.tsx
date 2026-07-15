import { useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import 'highlight.js/styles/github-dark.css'
import type { ChatItem } from '../types'
import { ToolCallCard } from './ToolCallCard'
import { useStore } from '../store'
import { WsContext } from '../wsContext'
import { extractCandidatePaths, kindOfPath, resolveFiles } from '../files'
import { isInterruptMarker, isToolUseInterrupt } from '../chat/history'
import rehypeFilePaths from '../rehypeFilePaths'
import { MarkdownPre } from './MarkdownPre'

export function MessageBlock({ item, currentLocalId, onEdit }: { item: ChatItem; currentLocalId?: string; onEdit?: () => void }) {
  const content = <MessageContent item={item} currentLocalId={currentLocalId} onEdit={onEdit} />
  if (item.fromSubagent) {
    return <SubagentWrapper>{content}</SubagentWrapper>
  }
  return content
}

/** Mensagens acima disso colapsam: mostra as primeiras linhas + botão de expandir. */
const COLLAPSE_LINES = 13

/**
 * Bolha do lado do usuário. Duas variações sobre a bolha padrão:
 *  - texto MUITO longo (> COLLAPSE_LINES linhas) começa recolhido, com "…" e
 *    botão para expandir/recolher;
 *  - `fromEngine` (conteúdo injetado pela engine, não digitado): cor distinta
 *    e cabeçalho "by <engine>", para não parecer pedido do operador.
 */
function UserTextBubble({ item, currentLocalId, onEdit }: {
  item: Extract<ChatItem, { kind: 'user_text' }>
  currentLocalId?: string
  onEdit?: () => void
}) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const engines = useStore((s) => s.engines)
  const sessions = useStore((s) => s.sessions)

  const lines = item.text.split('\n')
  const overflow = lines.length - COLLAPSE_LINES
  const collapsed = overflow > 0 && !expanded
  const shown = collapsed ? lines.slice(0, COLLAPSE_LINES).join('\n') + '\n…' : item.text

  const session = currentLocalId ? sessions[currentLocalId] : undefined
  const engineLabel = item.fromEngine
    ? (engines.find((e) => e.id === session?.engine)?.label ?? 'engine')
    : null

  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'flex-end', gap: 6, margin: '8px 0' }}>
      <ForwardButton text={item.text} currentLocalId={currentLocalId} />
      <div style={{ maxWidth: '70%' }}>
        <div className={item.fromEngine ? 'msg-from-engine' : undefined}
             style={item.fromEngine ? undefined : { background: 'var(--accent)', color: 'white', borderRadius: '12px 12px 2px 12px', padding: '10px 14px' }}>
          {engineLabel && <div className="msg-from-engine__by">by {engineLabel}</div>}
          <div style={{ whiteSpace: 'pre-wrap' }}>{shown}</div>
          {overflow > 0 && (
            <button type="button" className="msg-expand" onClick={() => setExpanded(!expanded)}>
              {collapsed ? `▾ ${t('chat.showAll', { n: overflow })}` : `▴ ${t('chat.collapse')}`}
            </button>
          )}
        </div>
      </div>
      {onEdit && (
        <button type="button" className="ghost msg-edit" aria-label={t('chat.edit')} title={t('chat.edit')} onClick={onEdit}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
          </svg>
        </button>
      )}
    </div>
  )
}

function SubagentWrapper({ children }: { children: ReactNode }) {
  const { t } = useTranslation()
  return (
    <div style={{ borderLeft: '2px solid var(--accent)', paddingLeft: 12, opacity: 0.85 }}>
      <div style={{ color: 'var(--text-dim)', fontSize: 11, marginBottom: 2 }}>↳ {t('chat.subagent')}</div>
      {children}
    </div>
  )
}

function MessageContent({ item, currentLocalId, onEdit }: { item: ChatItem; currentLocalId?: string; onEdit?: () => void }) {
  const { t } = useTranslation()
  switch (item.kind) {
    case 'user_text':
      // Marcador que o CLI injeta como "mensagem do usuário" ao interromper o
      // turno — não foi digitado por ninguém: vira um divisor de interrupção,
      // não uma bolha (sem encaminhar/editar).
      if (isInterruptMarker(item.text)) {
        return (
          <div className="msg-interrupt" role="note">
            <span className="msg-interrupt__chip">
              <span className="msg-interrupt__icon" aria-hidden="true">■</span>
              {isToolUseInterrupt(item.text) ? t('chat.interruptedToolUse') : t('chat.interrupted')}
            </span>
          </div>
        )
      }
      return <UserTextBubble item={item} currentLocalId={currentLocalId} onEdit={onEdit} />

    case 'assistant_text':
      return (
        <div style={{ margin: '8px 0' }}>
          <div className="markdown" style={{ lineHeight: 1.6 }}>
            <AssistantMarkdown text={item.text} currentLocalId={currentLocalId} />
          </div>
          <ForwardButton text={item.text} currentLocalId={currentLocalId} />
        </div>
      )
    case 'thinking':
      return <Thinking text={item.text} />
    case 'local_command':
      return (
        <div style={{ display: 'flex', justifyContent: 'flex-end', margin: '6px 0' }}>
          <span style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--text-dim)',
                         background: 'rgba(255,255,255,.06)', border: '1px solid var(--glass-border)',
                         borderRadius: 999, padding: '3px 12px' }}>
            ⌨ {item.command}{item.args ? ` ${item.args}` : ''}
          </span>
        </div>
      )
    case 'command_output':
      return (
        <div style={{ display: 'flex', justifyContent: 'flex-end', margin: '2px 0 6px' }}>
          <div style={{ fontFamily: 'monospace', fontSize: 12, whiteSpace: 'pre-wrap', maxWidth: '70%',
                        color: item.isError ? 'var(--err)' : 'var(--text-dim)', fontStyle: 'italic' }}>
            {item.text}
          </div>
        </div>
      )
    case 'system_note':
      return (
        <div style={{ textAlign: 'center', color: 'var(--text-dim)', fontSize: 12, margin: '8px 0' }}>
          🔔 {item.text}
        </div>
      )
    case 'tool_call':
      return <ToolCallCard item={item} />
  }
}

/**
 * Markdown do assistant + detecção de paths de arquivo: extrai candidatos do texto,
 * resolve em lote contra o escopo do projeto da sessão (cache no store, por path) e,
 * via `rehypeFilePaths` + `components.a`, só os confirmados (`exists && inScope`) viram
 * links clicáveis que abrem o FileViewerModal — o resto (não confirmado, ainda
 * carregando, ou link http normal) renderiza como antes.
 */
// href de link markdown que NÃO é web (http/mailto/âncora) é candidato a arquivo
// local. `file://` também é local (agente costuma linkar assim).
const isWebHref = (h: string) => /^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(h) && !/^file:/i.test(h)
// Limpa o href pro resolve/modal: tira file://, ./ e sufixo de linha(:coluna) —
// agentes linkam "arquivo.md:12", e o arquivo real não tem o :12.
const normalizeHref = (h: string) => {
  let p = h.replace(/^file:\/\//i, '')
  try { p = decodeURIComponent(p) } catch { /* href malformado: usa cru */ }
  return p.replace(/^\.\//, '').replace(/:\d+(?::\d+)?$/, '')
}

// hrefs dos links markdown do texto cru ([rótulo](href)) — o rehypeFilePaths pula
// texto dentro de <a>, então esses paths precisam entrar no lote do resolve por aqui.
function linkHrefCandidates(text: string): string[] {
  return [...text.matchAll(/\]\(([^)\s]+)\)/g)]
    .map((m) => m[1])
    .filter((h) => !isWebHref(h))
    .map(normalizeHref)
}

function AssistantMarkdown({ text, currentLocalId }: { text: string; currentLocalId?: string }) {
  const sessions = useStore((s) => s.sessions)
  const fileResolved = useStore((s) => s.fileResolved)
  const setFilesResolved = useStore((s) => s.setFilesResolved)
  const openFile = useStore((s) => s.openFile)
  const openExternalLink = useStore((s) => s.openExternalLink)
  const projectId = currentLocalId ? sessions[currentLocalId]?.projectId : undefined

  useEffect(() => {
    const candidates = [...new Set([...extractCandidatePaths(text), ...linkHrefCandidates(text)])]
    const pending = candidates.filter((p) => !(p in useStore.getState().fileResolved))
    if (pending.length === 0) return
    let cancelled = false
    resolveFiles(pending, projectId)
      .then((results) => { if (!cancelled) setFilesResolved(results) })
      .catch(() => { /* falha de resolve: paths ficam como texto puro (degrade silencioso) */ })
    return () => { cancelled = true }
  }, [text, projectId, setFilesResolved])

  const components: Components = {
    // Blocos de código (sugestões de comandos etc.) ganham o botão de copiar.
    pre: MarkdownPre,
    a: ({ href, children, ...props }) => {
      const dataFile = (props as Record<string, unknown>)['data-file'] as string | undefined
      // Alvo de arquivo: o data-file do rehypeFilePaths OU o href de um link markdown
      // não-web ([plano.md](/x/plano.md)) — sem isto, clicar num link de path NAVEGAVA
      // pra uma página nova em vez de abrir o FileViewerModal.
      const fileTarget = dataFile ?? (href && !isWebHref(href) ? normalizeHref(href) : undefined)
      if (fileTarget) {
        const resolved = fileResolved[fileTarget]
        const confirmed = resolved?.exists && resolved.inScope && resolved.kind
        // Path detectado em TEXTO puro (data-file): só vira link quando confirmado
        // (sem links quebrados no meio da prosa).
        if (dataFile && !confirmed) return <>{children}</>
        // LINK com caminho local: abre o popup SEMPRE — navegar levaria a
        // localhost:9105/<path>, que é sempre uma página quebrada. Sem confirmação
        // ainda, o tipo é palpite por extensão e o modal mostra o erro amigável
        // (não encontrado / sem permissão) se for o caso.
        const kind = confirmed ? resolved.kind! : kindOfPath(fileTarget)
        return (
          <a
            className="file-link"
            href="#"
            onClick={(e) => { e.preventDefault(); openFile(fileTarget, kind, projectId) }}
          >
            {children}
          </a>
        )
      }
      // Link WEB: confirmação de segurança antes de sair pro externo (popup).
      // Âncora interna (#) segue o comportamento padrão.
      if (href && !href.startsWith('#')) {
        return (
          <a href={href} rel="noreferrer" onClick={(e) => { e.preventDefault(); openExternalLink(href) }}>
            {children}
          </a>
        )
      }
      return (
        <a href={href} target="_blank" rel="noreferrer">
          {children}
        </a>
      )
    },
  }

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight, rehypeFilePaths]}
      components={components}
      // O sanitizador padrão ZERA hrefs file:// (protocolo não-permitido) e o link
      // chegava vazio no components.a. Preservamos file: — ele nunca navega: o
      // components.a o intercepta pro FileViewerModal. O resto (http/javascript:/…)
      // segue a sanitização padrão.
      urlTransform={(url) => (/^file:/i.test(url) ? url : defaultUrlTransform(url))}
    >
      {text}
    </ReactMarkdown>
  )
}

function ForwardButton({ text, currentLocalId }: { text: string; currentLocalId?: string }) {
  const { t } = useTranslation()
  const ws = useContext(WsContext)
  const sessions = useStore((s) => s.sessions)
  const projects = useStore((s) => s.projects)
  const addLocalUserText = useStore((s) => s.addLocalUserText)
  const [open, setOpen] = useState(false)
  const [sentTo, setSentTo] = useState<string | null>(null)

  if (!currentLocalId) return null

  const currentProjectId = sessions[currentLocalId]?.projectId
  const targets = Object.values(sessions)
    .filter((s) => (s.status === 'idle' || s.status === 'needs_attention') && s.projectId !== currentProjectId)
    .map((s) => ({ localId: s.localId, name: projects.find((p) => p.id === s.projectId)?.name ?? t('chat.unknownProject') }))

  const forward = (targetLocalId: string, name: string) => {
    ws?.send({ type: 'send_message', localId: targetLocalId, text })
    addLocalUserText(targetLocalId, text)
    setOpen(false)
    setSentTo(name)
    setTimeout(() => setSentTo(null), 2000)
  }

  return (
    <div style={{ position: 'relative', fontSize: 11 }}>
      <button className="ghost" style={{ fontSize: 11, padding: '3px 8px' }} onClick={() => setOpen((o) => !o)}>
        {t('chat.forward')}
      </button>
      {sentTo && <div style={{ color: 'var(--ok)', marginTop: 4, whiteSpace: 'nowrap' }}>{t('chat.forwardedTo', { name: sentTo })}</div>}
      {open && (
        <div className="glass" style={{ position: 'absolute', zIndex: 10, right: 0, marginTop: 4, borderRadius: 10,
                                          padding: 6, minWidth: 200 }}>
          {targets.length === 0 && (
            <div style={{ padding: '6px 8px', color: 'var(--text-dim)', fontSize: 12 }}>{t('chat.noAgents')}</div>
          )}
          {targets.map((target) => (
            <div key={target.localId} className="option-row" style={{ padding: '6px 8px', marginBottom: 2 }}
                 onClick={() => forward(target.localId, target.name)}>
              <span className="opt-text opt-title">{target.name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function Thinking({ text }: { text: string }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return (
    <div style={{ margin: '8px 0' }}>
      <span onClick={() => setOpen(!open)}
            style={{ cursor: 'pointer', color: 'var(--text-dim)', fontStyle: 'italic', fontSize: 13 }}>
        {open ? '▾' : '▸'} 💭 {t('chat.thinking')}
      </span>
      {open && (
        <div style={{ borderLeft: '2px solid var(--glass-border)', paddingLeft: 12, marginTop: 6,
                      color: 'var(--text-dim)', fontStyle: 'italic', whiteSpace: 'pre-wrap' }}>
          {text}
        </div>
      )}
    </div>
  )
}
