import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '../store'
import { fetchHistory, stopSubagentTask } from '../api'
import { EngineTabs } from './EngineTabs'
import { ContextMeter } from './ContextMeter'
import { MessageBlock } from './MessageBlock'
import { ChatInput } from './ChatInput'
import { ConfirmDialog } from './ConfirmDialog'
import type { ChatItem, SessionStatus } from '../types'
import { WsContext } from '../wsContext'
import { isEditableUserText } from '../chat/history'
import { applyEvent, mergeEngineFlags } from '../chat/applyEvent'
import { RunningSubagents } from './RunningSubagents'
import { ReauthBanner } from './ReauthBanner'
import { groupActions } from '../chat/grouping'
import { ActionGroup } from './ActionGroup'
import { InlineFileView } from './InlineFileView'
import { Icon } from './Icon'
import { isAtBottom } from '../scrollFollow'
import { MoreIcon } from './MenuIcons'
import { TerminalMenu } from './TerminalMenu'

export function ChatView() {
  const { t } = useTranslation()
  const ws = useContext(WsContext)
  const { activeLocalId, sessions, chat, streaming, projects, setHistory, historyLoadedFor, markHistoryLoaded } = useStore()
  const openTerminal = useStore((s) => s.openTerminal)
  const bottomRef = useRef<HTMLDivElement>(null)
  const [handoffDialog, setHandoffDialog] = useState(false)
  const [handoffPendingFor, setHandoffPendingFor] = useState<string | null>(null)
  const [editConfirm, setEditConfirm] = useState<string | null>(null)
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [following, setFollowing] = useState(true)

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
        if (reduced.length >= current.length) {
          setHistory(activeLocalId, events)
        } else {
          // Sessão LONGA: o histórico vem limitado (últimos N eventos) e reduz a
          // menos itens do que a tela acumulou — substituir encolheria a conversa.
          // Ainda assim aproveita a rebusca para RETAGUEAR o que o stream ao vivo
          // não sabia (fromEngine/isApiError), casando por texto.
          const retagged = mergeEngineFlags(current, reduced)
          if (retagged) useStore.getState().setChatItems(activeLocalId, retagged)
        }
      }
      markHistoryLoaded(activeLocalId, key)
    }).catch((err) => {
      // NÃO marca como carregado: o próximo disparo do efeito (troca de sessão,
      // mudança de status, invalidação por reconexão) tenta de novo. Sem este
      // catch, a falha virava unhandled rejection e o histórico nunca carregava.
      console.error('[chat] falha ao carregar histórico', err)
    })
  }, [activeLocalId, session?.engineSessionId, session?.status, loadedEngineSessionId])

  /**
   * O auto-scroll só puxa a tela se ela estiver PRESA no fim.
   *
   * Antes puxava sempre, a cada pedaço que chegava — e ler algo que passou
   * enquanto o agente escrevia era impossível: a barra voltava sozinha antes de
   * dar tempo. Quem solta e prende é a própria rolagem (ver scrollFollow.ts).
   */
  useEffect(() => {
    if (following) bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [activeLocalId, items.length, streamingText, following])

  // Terminal novo é conversa nova: chega-se no fim dela, não preso onde se estava.
  useEffect(() => { setFollowing(true) }, [activeLocalId])

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
  // Editar durante o turno é DESTRUTIVO (interrompe o que está rodando e
  // recomeça da mensagem editada) — o operador pode achar que só vai corrigir
  // uma mensagem enfileirada. Por isso pede confirmação antes.
  // Estável entre renders (só muda com a sessão): é o que permite ao MessageBlock
  // ser memoizado — uma closure nova por render furaria o memo em todos os
  // blocos editáveis. O status é lido na hora, não capturado.
  const localId = session.localId
  const handleEdit = useCallback((text: string) => {
    const st = useStore.getState()
    if (st.sessions[localId]?.status === 'working') { setEditConfirm(text); return }
    st.requestEdit(localId, text)
  }, [localId])

  return (
    <>
      <div className="chat-header" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 20px', borderBottom: '1px solid var(--glass-border)' }}>
        {/* O mesmo menu do cartão da lista, aqui no título: quem está lendo a
            conversa não devia ter que voltar à barra lateral para renomear o
            terminal ou abrir a pasta dele. */}
        <button className="ghost chat-header__more" title={t('sidebar.options')}
                onClick={(e) => {
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                  setMenuAt({ x: r.left, y: r.bottom + 6 })
                }}>
          <MoreIcon size={14} />
        </button>
        <Icon value={project.icon} size={20} />
        <strong>{project.name}</strong>
        <EngineTabs projectId={session.projectId} activeLocalId={session.localId} />
        <ContextMeter session={session} />
        {session.status === 'dead' && session.detail && (
          <span style={{ color: 'var(--err)' }}>{session.detail.slice(0, 140)}</span>
        )}
        <button className="ghost" style={{ marginLeft: 'auto' }}
                title={t('schedules.openTitle')}
                onClick={() => useStore.getState().openSchedules()}>
          ⏱ {t('schedules.open')}
        </button>
        <button className="ghost"
                disabled={!canOpenTerminal}
                title={!canOpenTerminal ? t('chat.handoffUnavailable') : undefined}
                onClick={handleOpenTerminal}>
          🖥 {t('chat.openInTerminal')}
        </button>
      </div>
      {menuAt && <TerminalMenu project={project} x={menuAt.x} y={menuAt.y} onDone={() => setMenuAt(null)} />}
      <div className="chat-scroll-wrap">
      <div
        ref={scrollRef}
        data-testid="chat-scroll"
        className="chat-scroll"
        onScroll={() => { if (scrollRef.current) setFollowing(isAtBottom(scrollRef.current)) }}
      >
        <div className="chat-scroll__inner">
        {/* Sequências de ações (tool_call/thinking) viram um grupo colapsável;
            key pelo índice INICIAL do grupo, estável enquanto a cauda cresce
            no streaming (não perde o estado aberto/fechado do operador). */}
        {groupActions(items, session.status === 'working').map((node) => {
          if (node.kind === 'group') {
            return <ActionGroup key={`g-${node.start}`} items={node.items} currentLocalId={session.localId} />
          }
          const item = node.item
          return (
            <MessageBlock key={node.index} item={item} currentLocalId={session.localId}
                          editable={editableIdx.has(node.index)} onEdit={handleEdit} />
          )
        })}
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
        {/* Só com a sessão em `working`: num turno interrompido o tool_call do
            Agent fica sem resultado para sempre, e a faixa afirmaria que há
            subagente trabalhando quando não há mais nada rodando. */}
        {session.status === 'working' && <RunningSubagents
            items={items}
            backgroundTasks={session.backgroundTasks}
            onStopTask={(taskId) => { void stopSubagentTask(session.localId, taskId).catch(() => {}) }}
          />}
        {session.status === 'working' && !streamingText && (
          <div className="typing" data-testid="typing-indicator" aria-label={t('chat.processing')}>
            <span /><span /><span />
          </div>
        )}
        <div ref={bottomRef} />
        </div>
      </div>
      {/* A tela está solta: o rodapé da conversa continua andando lá embaixo.
          Some sozinho quando a rolagem volta ao fim — o botão é o atalho, não a
          única saída. */}
      {!following && (
        <button className="chat-tofoot" data-testid="chat-tofoot"
                onClick={() => { setFollowing(true); bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 5v14" /><path d="m19 12-7 7-7-7" />
          </svg>
          {t('chat.toFoot')}
        </button>
      )}
      </div>
      {/* Arquivo aberto INLINE: dockado aqui (fora da rolagem do chat) para
          continuar visível enquanto o operador digita e a conversa anda. */}
      {/* Credencial expirada: sem isto a sessão só empilha erros de API e o
          operador precisa lembrar sozinho de rodar /login no terminal. */}
      <ReauthBanner localId={session.localId} expired={session.authExpired} />
      <InlineFileView localId={session.localId} />
      {session.status === 'in_terminal' ? (
        <div className="notice-info">
          <span aria-hidden="true">🖥️</span>
          <span style={{ flex: 1 }}>{t('chat.inTerminalNotice')}</span>
          <button className="ghost" onClick={() => openTerminal(session.localId)}>{t('chat.backToTerminal')}</button>
        </div>
      ) : (
        // key: remonta o input ao trocar de sessão — rascunho e anexos são estado
        // local do ChatInput e vazariam (e seriam enviados) para a sessão errada.
        <ChatInput key={session.localId} localId={session.localId} disabled={session.status === 'dead' || session.status === 'stopped'} />
      )}
      {editConfirm !== null && session && (
        <ConfirmDialog
          title={t('chat.editWorkingTitle')}
          message={t('chat.editWorkingMsg')}
          confirmLabel={t('chat.editWorkingConfirm')}
          onConfirm={() => {
            setEditConfirm(null)
            ws?.send({ type: 'interrupt', localId: session.localId })
            useStore.getState().requestEdit(session.localId, editConfirm)
          }}
          onClose={() => setEditConfirm(null)}
        />
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
