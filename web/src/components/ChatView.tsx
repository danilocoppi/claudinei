import { useContext, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '../store'
import { fetchHistory } from '../api'
import { EngineTabs } from './EngineTabs'
import { MessageBlock } from './MessageBlock'
import { ChatInput } from './ChatInput'
import { ConfirmDialog } from './ConfirmDialog'
import type { ChatItem, SessionStatus } from '../types'
import { WsContext } from '../wsContext'
import { isEditableUserText } from '../chat/history'
import { applyEvent } from '../chat/applyEvent'

export function ChatView() {
  const { t } = useTranslation()
  const ws = useContext(WsContext)
  const { activeLocalId, sessions, chat, streaming, projects, setHistory, historyLoadedFor, markHistoryLoaded } = useStore()
  const openTerminal = useStore((s) => s.openTerminal)
  const bottomRef = useRef<HTMLDivElement>(null)
  const [handoffDialog, setHandoffDialog] = useState(false)
  const [handoffPendingFor, setHandoffPendingFor] = useState<string | null>(null)

  const session = activeLocalId ? sessions[activeLocalId] : undefined
  const project = session ? projects.find((p) => p.id === session.projectId) : undefined
  const items = activeLocalId ? (chat[activeLocalId] ?? []) : []
  const streamingText = activeLocalId ? (streaming[activeLocalId] ?? '') : ''

  // D4: (re)carrega o histórico sempre que a sessão ativa tiver um engineSessionId
  // ainda não carregado — cobre reviver e retorno do terminal, não só abertura inicial.
  // Sem engineSessionId (sessão nova em 'starting', o init só chega com a 1ª
  // mensagem), busca mesmo assim: o backend devolve o PREVIEW da conversa que o
  // --continue vai retomar, para o operador se contextualizar. A chave sentinela
  // '(preview)' garante que o histórico real substitua o preview quando o init chegar.
  // Depende só da entrada de historyLoadedFor da sessão ativa (não do objeto inteiro),
  // pra não re-disparar o efeito quando outra sessão termina de carregar o histórico dela.
  const loadedEngineSessionId = activeLocalId ? historyLoadedFor[activeLocalId] : undefined
  useEffect(() => {
    if (!activeLocalId || !session) return
    const key = session.engineSessionId ?? (session.status === 'starting' ? '(preview)' : null)
    if (!key || loadedEngineSessionId === key) return
    fetchHistory(activeLocalId).then((events) => {
      if (events.length > 0 || key !== '(preview)') {
        // Não deixa uma re-busca ENCOLHER a conversa: quando o init chega (a 1ª
        // mensagem gera o engineSessionId), o transcript da engine pode ainda não
        // ter registrado a mensagem recém-enviada — o histórico volta curto/vazio e
        // apagaria a mensagem otimista (addLocalUserText). Só substitui se o
        // histórico carregado não perde itens do que já está na tela.
        const reduced = events.reduce(applyEvent, [] as ChatItem[])
        const current = useStore.getState().chat[activeLocalId] ?? []
        if (reduced.length >= current.length) setHistory(activeLocalId, events)
      }
      markHistoryLoaded(activeLocalId, key)
    })
  }, [activeLocalId, session?.engineSessionId, session?.status, loadedEngineSessionId])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [activeLocalId, items.length, streamingText])

  useEffect(() => {
    if (session?.status === 'needs_attention' && activeLocalId) {
      ws?.send({ type: 'mark_read', localId: activeLocalId })
    }
  }, [activeLocalId, session?.status])

  // Após confirmar durante um turno: espera o interrupt tirar a sessão-ALVO de 'working'
  // e então abre o terminal DELA — não da sessão que porventura estiver ativa agora.
  // Se o operador navegar para outra sessão enquanto o handoff está pendente, o
  // handoff é cancelado (não abre terminal nenhum). Timeout de 5s (o interrupt
  // real leva ~0,1s). Dependências: session?.status re-dispara enquanto a sessão
  // alvo continuar sendo a ativa; session?.localId re-dispara na troca de sessão,
  // caindo no guard de aborto abaixo.
  useEffect(() => {
    if (!handoffPendingFor) return
    if (useStore.getState().activeLocalId !== handoffPendingFor) { setHandoffPendingFor(null); return }
    const alvo = useStore.getState().sessions[handoffPendingFor]
    if (!alvo) { setHandoffPendingFor(null); return }
    if (alvo.status === 'working') {
      const timer = setTimeout(() => setHandoffPendingFor(null), 5000)
      return () => clearTimeout(timer)
    }
    setHandoffPendingFor(null)
    openTerminal(handoffPendingFor)
  }, [handoffPendingFor, session?.status, session?.localId])

  if (!session || !project) return <div style={{ padding: 24 }}>{t('chat.select')}</div>

  // Open in terminal: disponível em qualquer status ativo, INCLUINDO 'starting' (sessão
  // revivida/--continue esperando a 1ª msg — "ready, send a message"). Com conversa da
  // engine (engineSessionId) o terminal RETOMA (claude --resume / codex resume <thread>);
  // sem id, o backend cai no último thread da pasta (fix do openInTerminal) ou abre uma
  // sessão NOVA (fresh). Só stopped/dead ficam de fora (não há processo para levar).
  const canOpenTerminal =
    session.status === 'idle' || session.status === 'needs_attention' ||
    session.status === 'working' || session.status === 'starting'

  const handleOpenTerminal = () => {
    if (!session) return
    if (session.status === 'working') { setHandoffDialog(true); return }
    openTerminal(session.localId)
  }

  // Lápis de editar: só nas últimas 5 mensagens do usuário (não-subagente).
  const editableIdx = new Set<number>()
  {
    let need = 5
    for (let i = items.length - 1; i >= 0 && need > 0; i--) {
      const it = items[i]
      if (isEditableUserText(it)) { editableIdx.add(i); need-- }
    }
  }
  const handleEdit = (text: string) => {
    if (session.status === 'working') ws?.send({ type: 'interrupt', localId: session.localId })
    useStore.getState().requestEdit(session.localId, text)
  }

  return (
    <>
      <div className="chat-header" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 20px', borderBottom: '1px solid var(--glass-border)' }}>
        <span style={{ fontSize: 20 }}>{project.icon}</span>
        <strong>{project.name}</strong>
        <EngineTabs projectId={session.projectId} activeLocalId={session.localId} />
        {session.status === 'dead' && session.detail && (
          <span style={{ color: 'var(--err)' }}>{session.detail.slice(0, 140)}</span>
        )}
        <button className="ghost" style={{ marginLeft: 'auto' }}
                disabled={!canOpenTerminal}
                title={!canOpenTerminal ? t('chat.handoffUnavailable') : undefined}
                onClick={handleOpenTerminal}>
          🖥 {t('chat.openInTerminal')}
        </button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 24px' }}>
        {items.map((item, i) => (
          <MessageBlock key={i} item={item} currentLocalId={session.localId}
                        onEdit={editableIdx.has(i) && item.kind === 'user_text' ? () => handleEdit(item.text) : undefined} />
        ))}
        {streamingText && (
          <div data-testid="streaming-preview" style={{ margin: '8px 0', opacity: 0.75 }}>
            <div className="markdown" style={{ lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
              {streamingText}
              <span className="streaming-cursor" aria-hidden="true" style={{
                display: 'inline-block', width: 8, height: 14, marginLeft: 2, verticalAlign: 'text-bottom',
                background: 'var(--text-dim)', animation: 'blink 1s step-start infinite',
              }} />
            </div>
          </div>
        )}
        {session.status === 'working' && !streamingText && (
          <div className="typing" data-testid="typing-indicator" aria-label={t('chat.processing')}>
            <span /><span /><span />
          </div>
        )}
        <div ref={bottomRef} />
      </div>
      {session.status === 'in_terminal' ? (
        <div className="notice-info">
          <span aria-hidden="true">🖥️</span>
          <span style={{ flex: 1 }}>{t('chat.inTerminalNotice')}</span>
          <button className="ghost" onClick={() => openTerminal(session.localId)}>{t('chat.backToTerminal')}</button>
        </div>
      ) : (
        <ChatInput localId={session.localId} disabled={session.status === 'dead' || session.status === 'stopped'} />
      )}
      {handoffDialog && session && (
        <ConfirmDialog
          title={t('chat.handoffTitle')}
          message={t('chat.handoffWorking')}
          onConfirm={() => {
            setHandoffDialog(false)
            ws?.send({ type: 'interrupt', localId: session.localId })
            setHandoffPendingFor(session.localId)
          }}
          onClose={() => setHandoffDialog(false)}
        />
      )}
    </>
  )
}
