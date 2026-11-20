import { forwardRef, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Virtuoso, type Components, type ContextProp, type ListProps } from 'react-virtuoso'
import { useStore } from '../store'
import { fetchHistory, stopSubagentTask } from '../api'
import { loadHistoryTail } from '../chat/loadTail'
import { EngineTabs } from './EngineTabs'
import { MessageBlock } from './MessageBlock'
import { ChatInput } from './ChatInput'
import { ConfirmDialog } from './ConfirmDialog'
import type { ChatItem, SessionInfo, SessionStatus } from '../types'
import { WsContext } from '../wsContext'
import { isEditableUserText } from '../chat/history'
import { RunningSubagents } from './RunningSubagents'
import { BackgroundProcesses } from './BackgroundProcesses'
import { CompactingIndicator } from './CompactingIndicator'
import { ReauthBanner } from './ReauthBanner'
import { InterruptedNotice } from './InterruptedNotice'
import { UsageLimitNotice } from './UsageLimitNotice'
import { QuestionPanel } from './QuestionPanel'
import { groupActions, type ChatNode } from '../chat/grouping'
import { nodeKey, prependedNodes, useFirstItemIndex } from '../chat/nodes'
import { chatListRef } from '../chat/listHandle'
import { ActionGroup } from './ActionGroup'
import { InlineFileView } from './InlineFileView'
import { HeadsUpBand } from './HeadsUpBand'
import { Icon } from './Icon'
import { SLACK } from '../scrollFollow'
import { MoreIcon } from './MenuIcons'
import { TerminalMenu } from './TerminalMenu'
import { ProgressButton, ProgressColumn } from './ProgressColumn'

const EMPTY_ITEMS: ChatItem[] = []

/** Só este trecho acompanha cada delta; o histórico e os controles não mudaram. */
function StreamingPreview({ localId }: { localId: string }) {
  const text = useStore((s) => s.streaming[localId] ?? '')
  if (!text) return null
  return (
    <div data-testid="streaming-preview" style={{ margin: '8px 0', opacity: 0.75 }}>
      <div className="markdown" style={{ lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
        {text}
        <span className="streaming-cursor" aria-hidden="true" style={{
          display: 'inline-block', width: 8, height: 14, marginLeft: 2, verticalAlign: 'text-bottom',
          background: 'var(--text-dim)', animation: 'blink 1s step-start infinite',
        }} />
      </div>
    </div>
  )
}

/** Tamanho da página que sobe ao chegar no topo da conversa. */
export const OLDER_PAGE_LIMIT = 200

/** Sessões com um pedido de página anterior no ar: um por vez, por sessão. */
const olderInFlight = new Set<string>()
/**
 * Sessões que esperam o operador voltar ao topo para pedir a página anterior:
 * o último pedido falhou, ou a sequência automática bateu no teto.
 */
const olderWaitTop = new Set<string>()
/**
 * Teto de páginas seguidas que só engordam o grupo do topo. Um turno longo de
 * ações pode ter milhares delas, e sem GPU cada página custa render na thread
 * principal: passou disso, espera o operador voltar ao topo.
 */
export const OLDER_CHAIN_LIMIT = 5

/** O que o topo e o rodapé da lista recebem do ChatView (via `context` da lista virtual). */
interface ListContext {
  localId: string
  status: SessionStatus
  items: ChatItem[]
  backgroundTasks: SessionInfo['backgroundTasks']
  compactingSince?: number
  hasStreaming: boolean
  /** Topo da lista: começo da conversa, página anterior chegando, ou nada. */
  edge: 'start' | 'loading' | null
  /** O rodapé cresceu `grew` px (texto do streaming, indicadores). */
  onFooterGrow: (grew: number) => void
}

/** Topo da lista: o respiro de cima e o aviso de começo/carregando. */
function ListHeader({ context }: { context: ListContext }) {
  const { t } = useTranslation()
  return (
    <div className="chat-scroll__head">
      <div className="chat-scroll__inner chat-scroll__inner--top">
        {context.edge === 'start' && <div className="chat-edge" data-testid="chat-start">{t('chat.historyStart')}</div>}
        {context.edge === 'loading' && <div className="chat-edge" data-testid="chat-loading-older">{t('chat.historyLoading')}</div>}
      </div>
    </div>
  )
}

/**
 * Rodapé da lista: o que acompanha o turno em andamento.
 *
 * A lista virtual acompanha o fim quando entra item novo ou um item cresce, mas
 * não quando o RODAPÉ cresce — e é nele que o texto do streaming aumenta. O
 * ResizeObserver avisa o crescimento (depois do layout, sem forçar reflow a
 * cada pedaço) e o ChatView decide se puxa a tela.
 */
function ListFooter({ context }: { context: ListContext }) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement>(null)
  const { onFooterGrow } = context
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let altura: number | undefined
    const observer = new ResizeObserver((entries) => {
      const h = entries[entries.length - 1].contentRect.height
      // A primeira medida é a de partida: só o que cresce depois puxa a tela.
      if (altura !== undefined && h > altura) onFooterGrow(h - altura)
      altura = h
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [onFooterGrow])
  const { localId, status, items, backgroundTasks, compactingSince, hasStreaming } = context
  return (
    <div className="chat-scroll__foot">
      <div ref={ref} className="chat-scroll__inner chat-scroll__inner--bottom">
        <StreamingPreview localId={localId} />
        {/* Só com a sessão em `working`: num turno interrompido o tool_call do
            Agent fica sem resultado para sempre, e a faixa afirmaria que há
            subagente trabalhando quando não há mais nada rodando. */}
        {status === 'working' && <RunningSubagents
            items={items}
            backgroundTasks={backgroundTasks}
            onStopTask={(taskId) => { void stopSubagentTask(localId, taskId).catch(() => {}) }}
          />}
        <BackgroundProcesses tasks={backgroundTasks}
          onStopTask={(taskId) => stopSubagentTask(localId, taskId)} />
        {/* Compactando, os pontinhos não dizem nada: é uma espera longa e com
            nome — a linha mostra o que está acontecendo e há quanto tempo. */}
        {status === 'working' && !hasStreaming && (
          compactingSince
            ? <CompactingIndicator since={compactingSince} />
            : (
              <div className="typing" data-testid="typing-indicator" aria-label={t('chat.processing')}>
                <span /><span /><span />
              </div>
            )
        )}
      </div>
    </div>
  )
}

/** As linhas da lista com a mesma coluna (largura e folha) do topo e do rodapé. */
const SheetList = forwardRef<HTMLDivElement, ListProps & ContextProp<ListContext>>(
  function SheetList({ context: _context, ...props }, ref) {
    return <div {...props} ref={ref} className="chat-scroll__inner chat-scroll__inner--list" />
  },
)

/** Fora do componente: objetos novos a cada render remontariam topo e rodapé. */
const LIST_COMPONENTS: Components<ChatNode, ListContext> = { Header: ListHeader, Footer: ListFooter, List: SheetList }
const computeNodeKey = (_index: number, node: ChatNode) => nodeKey(node)

export function ChatView() {
  const { t } = useTranslation()
  const ws = useContext(WsContext)
  const activeLocalId = useStore((s) => s.activeLocalId)
  const session = useStore((s) => activeLocalId ? s.sessions[activeLocalId] : undefined)
  const project = useStore((s) => s.projects.find((p) => p.id === session?.projectId))
  // Contagem, não `filter`: um selector que devolve array novo re-renderiza o
  // chat a cada atualização do store.
  const pastaCompartilhada = useStore((s) => s.projects.filter((p) => p.path === project?.path).length > 1)
  const items = useStore((s) => (activeLocalId ? s.chat[activeLocalId] : undefined) ?? EMPTY_ITEMS)
  const hasStreaming = useStore((s) => !!(activeLocalId && s.streaming[activeLocalId]))
  const loadedEngineSessionId = useStore((s) => activeLocalId ? s.historyLoadedFor[activeLocalId] : undefined)
  const setHistoryTail = useStore((s) => s.setHistoryTail)
  const markHistoryLoaded = useStore((s) => s.markHistoryLoaded)
  const openTerminal = useStore((s) => s.openTerminal)
  const progressOpen = useStore((s) => s.progressOpen)
  const [handoffDialog, setHandoffDialog] = useState(false)
  const [handoffPendingFor, setHandoffPendingFor] = useState<string | null>(null)
  const [editConfirm, setEditConfirm] = useState<string | null>(null)
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null)
  const [following, setFollowing] = useState(true)
  const historyCursor = useStore((s) => activeLocalId ? s.historyCursor[activeLocalId] : undefined)
  const [olderLoading, setOlderLoading] = useState<string | null>(null)
  const scrollerRef = useRef<HTMLElement | null>(null)
  const followingRef = useRef(following)
  useEffect(() => { followingRef.current = following }, [following])

  const nodes = useMemo(() => groupActions(items, session?.status === 'working'), [items, session?.status])
  const firstItemIndex = useFirstItemIndex(activeLocalId ?? undefined, nodes)

  // D4: (re)carrega o histórico sempre que a sessão ativa tiver um engineSessionId
  // ainda não carregado — cobre reviver e retorno do terminal, não só abertura inicial.
  // Sem engineSessionId (sessão nova em 'starting', o init só chega com a 1ª
  // mensagem), busca mesmo assim: o backend devolve o PREVIEW da conversa que o
  // --continue vai retomar, para o operador se contextualizar. A chave sentinela
  // '(preview)' garante que o histórico real substitua o preview quando o init chegar.
  // O preview também vale em in_terminal/stopped SEM id: o TUI pode ter conversado
  // sem o Claudinei capturar o id da sessão (terminal aberto antes da 1ª mensagem,
  // restart do servidor com a sessão no terminal) — quem decide se há algo para
  // mostrar é o servidor (continue_latest + última conversa da pasta).
  // Depende só da entrada de historyLoadedFor da sessão ativa (não do objeto inteiro),
  // pra não re-disparar o efeito quando outra sessão termina de carregar o histórico dela.
  useEffect(() => {
    if (!activeLocalId || !session) return
    const key = session.engineSessionId
      ?? (['starting', 'in_terminal', 'stopped'].includes(session.status) ? '(preview)' : null)
    if (!key || loadedEngineSessionId === key) return
    // Só a releitura mais recente da sessão chega a este callback (ver loadHistoryTail).
    loadHistoryTail(activeLocalId, key, (page) => {
      // Preview vazio não apaga nada. No resto, a reconciliação por chave não
      // deixa a releitura ENCOLHER a conversa: as páginas antigas já carregadas
      // ficam (num turno longo, loadHistoryTail lê para trás até encostar nelas),
      // o que não mudou mantém o objeto (o bloco não re-renderiza), o ao vivo é
      // trocado pelo confirmado — com as flags que só o transcript tem
      // (fromEngine, isApiError) — e o ao vivo que o transcript não tem (a
      // mensagem otimista, avisos de erro, `!comando`) fica onde estava. Página
      // vazia da mesma conversa não apaga nada. Ver chat/reconcile.ts.
      if (page.events.length > 0 || key !== '(preview)') setHistoryTail(activeLocalId, page, key)
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
   * dar tempo. Quem solta e prende é a própria rolagem: a lista virtual avisa
   * quando a tela sai ou volta ao fim (`atBottomStateChange`, com a folga do
   * scrollFollow.ts) e só acompanha item novo com ela presa (`followOutput`).
   *
   * O rodapé que cresce (streaming) a lista não acompanha: aqui. Só puxa se a
   * tela estava no fim ANTES de crescer — o aviso da lista chega em lotes de
   * 50 ms, e quem acabou de subir para ler não pode ser puxado de volta.
   */
  const onFooterGrow = useCallback((grew: number) => {
    const el = scrollerRef.current
    if (!el || !followingRef.current) return
    if (el.scrollHeight - el.scrollTop - el.clientHeight - grew > SLACK) return
    el.scrollTop = el.scrollHeight
  }, [])
  const setScroller = useCallback((el: HTMLElement | Window | null) => {
    scrollerRef.current = el instanceof HTMLElement ? el : null
  }, [])

  /**
   * Página anterior ao chegar no topo: um pedido por vez por sessão, com o
   * `before` do cursor — e é esse mesmo `before` que vai para o prependHistory,
   * que descarta a página se o cursor andou enquanto ela vinha. Falhou: não
   * marca o começo; a próxima chegada ao topo tenta de novo (sem laço).
   */
  const loadOlder = useCallback(() => {
    if (!activeLocalId) return
    const id = activeLocalId
    const pedir = (seguidas = 0) => {
      const cursor = useStore.getState().historyCursor[id]
      if (!cursor || cursor.atStart || olderInFlight.has(id)) return
      const before = cursor.before
      olderInFlight.add(id)
      setOlderLoading(id)
      let deNovo = false
      fetchHistory(id, before, OLDER_PAGE_LIMIT)
        .then((page) => {
          olderWaitTop.delete(id)
          const st0 = useStore.getState()
          const working = st0.sessions[id]?.status === 'working'
          const antes = groupActions(st0.chat[id] ?? [], working)
          st0.prependHistory(id, page, before)
          // O topo não ganhou nó novo — página sem nada que apareça, ou só ações
          // que entraram no grupo do topo: o índice do primeiro nó não mudou, e
          // a lista não avisa o topo de novo. Segue para a anterior; o cursor
          // andou para trás, então não é laço.
          const st = useStore.getState()
          deNovo = !page.atStart && page.before < before && st.historyCursor[id]?.before === page.before
            && prependedNodes(antes, groupActions(st.chat[id] ?? [], working)) === 0
        })
        .catch((err) => {
          olderWaitTop.add(id)
          console.error('[chat] falha ao carregar mensagens anteriores', err)
        })
        .finally(() => {
          olderInFlight.delete(id)
          setOlderLoading((cur) => (cur === id ? null : cur))
          if (!deNovo) return
          // O operador foi para outro terminal: a sequência para aqui (a
          // página que já veio entrou na conversa dela).
          if (useStore.getState().activeLocalId !== id) return
          if (seguidas + 1 >= OLDER_CHAIN_LIMIT) { olderWaitTop.add(id); return }
          pedir(seguidas + 1)
        })
    }
    pedir()
  }, [activeLocalId])
  // Depois de uma falha ou do teto da sequência, voltar ao topo pede de novo:
  // o `startReached` não repete o mesmo índice. Só nesses casos — ao abrir a
  // conversa a lista passa pelo topo antes de descer ao fim, e isso não é
  // pedido do operador.
  const onAtTop = useCallback((atTop: boolean) => {
    if (atTop && activeLocalId && olderWaitTop.has(activeLocalId)) loadOlder()
  }, [activeLocalId, loadOlder])

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

  // Open in terminal: disponível em qualquer status ativo, INCLUINDO 'starting' (sessão
  // revivida/--continue esperando a 1ª msg — "ready, send a message"). Com conversa da
  // engine (engineSessionId) o terminal RETOMA (claude --resume / codex resume <thread>);
  // sem id, o backend cai no último thread da pasta (fix do openInTerminal) ou abre uma
  // sessão NOVA (fresh). Só stopped/dead ficam de fora (não há processo para levar).
  const canOpenTerminal =
    session?.status === 'idle' || session?.status === 'needs_attention' ||
    session?.status === 'working' || session?.status === 'starting'

  const handleOpenTerminal = () => {
    if (!session) return
    if (session.status === 'working') { setHandoffDialog(true); return }
    openTerminal(session.localId)
  }

  // Lápis de editar: só nas últimas 5 mensagens do usuário (não-subagente).
  const editableIdx = useMemo(() => {
    const indices = new Set<number>()
    let need = 5
    for (let i = items.length - 1; i >= 0 && need > 0; i--) {
      const it = items[i]
      if (isEditableUserText(it)) { indices.add(i); need-- }
    }
    return indices
  }, [items])
  // Editar durante o turno é DESTRUTIVO (interrompe o que está rodando e
  // recomeça da mensagem editada) — o operador pode achar que só vai corrigir
  // uma mensagem enfileirada. Por isso pede confirmação antes.
  // Estável entre renders (só muda com a sessão): é o que permite ao MessageBlock
  // ser memoizado — uma closure nova por render furaria o memo em todos os
  // blocos editáveis. O status é lido na hora, não capturado.
  const localId = session?.localId
  const handleEdit = useCallback((text: string) => {
    if (!localId) return
    const st = useStore.getState()
    if (st.sessions[localId]?.status === 'working') { setEditConfirm(text); return }
    st.requestEdit(localId, text)
  }, [localId])

  const renderNode = useCallback((_index: number, node: ChatNode) => (
    <div className="chat-entry" data-key={nodeKey(node)}>
      {node.kind === 'group'
        ? <ActionGroup items={node.items} currentLocalId={localId!} />
        : <MessageBlock item={node.item} currentLocalId={localId!}
                        editable={editableIdx.has(node.index)} onEdit={handleEdit} />}
    </div>
  ), [localId, editableIdx, handleEdit])

  const edge: ListContext['edge'] = nodes.length === 0 ? null
    : historyCursor?.atStart ? 'start'
    : olderLoading === activeLocalId ? 'loading' : null
  const listContext = useMemo<ListContext | null>(() => session ? {
    localId: session.localId,
    status: session.status,
    items,
    backgroundTasks: session.backgroundTasks,
    compactingSince: session.compactingSince,
    hasStreaming,
    edge,
    onFooterGrow,
  } : null, [session?.localId, session?.status, session?.backgroundTasks, session?.compactingSince, items, hasStreaming, edge, onFooterGrow])

  if (!session || !project || !listContext) return <div style={{ padding: 24 }}>{t('chat.select')}</div>

  // O acompanhamento de tarefas longas é do terminal: projeto + motor da aba.
  const engine = session.engine

  return (
    <div className="chat-layout">
    <div className="chat-main">
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
        {/* Ícone + nome num só bloco para o celular poder escondê-los: lá a topbar
            já mostra o nome do projeto, e repeti-lo custava uma linha inteira
            de um cabeçalho que precisa caber em uma. */}
        <span className="chat-header__project">
          <Icon value={project.icon} size={20} />
          <strong>{project.name}</strong>
          {pastaCompartilhada && (
            <span className="chat-header__shared" data-testid="shared-path" title={t('chat.sharedPathTitle')}>
              ⫽ {t('chat.sharedPath')}
            </span>
          )}
        </span>
        <EngineTabs projectId={session.projectId} activeLocalId={session.localId} />
        {session.status === 'dead' && session.detail && (
          <span style={{ color: 'var(--err)' }}>{session.detail.slice(0, 140)}</span>
        )}
        <ProgressButton projectId={session.projectId} engine={engine} sessionStatus={session.status} />
        <button className="ghost"
                title={t('schedules.openTitle')}
                onClick={() => useStore.getState().openSchedules()}>
          ⏱ <span className="btn-label">{t('schedules.open')}</span>
        </button>
        <button className="ghost"
                disabled={!canOpenTerminal}
                title={!canOpenTerminal ? t('chat.handoffUnavailable') : t('chat.openInTerminal')}
                onClick={handleOpenTerminal}>
          🖥 <span className="btn-label">{t('chat.openInTerminal')}</span>
        </button>
      </div>
      {menuAt && <TerminalMenu project={project} x={menuAt.x} y={menuAt.y} onDone={() => setMenuAt(null)} />}
      <div className="chat-scroll-wrap">
      {/* Lista virtual: só os nós perto da tela ficam montados. As sequências
          de ações (tool_call/thinking) viram um grupo colapsável; a chave de
          cada linha é a do item (no grupo, a do primeiro), estável enquanto a
          cauda cresce e quando páginas antigas entram no topo. `key` por
          sessão: terminal novo é lista nova, aberta no fim. */}
      <Virtuoso<ChatNode, ListContext>
        key={session.localId}
        ref={chatListRef}
        data-testid="chat-scroll"
        className="chat-scroll"
        data={nodes}
        context={listContext}
        firstItemIndex={firstItemIndex}
        initialTopMostItemIndex={{ index: 'LAST', align: 'end' }}
        computeItemKey={computeNodeKey}
        itemContent={renderNode}
        followOutput={following ? 'auto' : false}
        atBottomThreshold={SLACK}
        atBottomStateChange={setFollowing}
        startReached={loadOlder}
        atTopStateChange={onAtTop}
        increaseViewportBy={{ top: 600, bottom: 600 }}
        scrollerRef={setScroller}
        components={LIST_COMPONENTS}
      />
      {/* A tela está solta: o rodapé da conversa continua andando lá embaixo.
          Some sozinho quando a rolagem volta ao fim — o botão é o atalho, não a
          única saída. */}
      {!following && (
        <button className="chat-tofoot" data-testid="chat-tofoot"
                onClick={() => { setFollowing(true); chatListRef.current?.scrollToIndex({ index: 'LAST', align: 'end' }) }}>
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
      {/* Pergunta do agente (AskUserQuestion): o painel mora aqui, acima da caixa,
          como o diálogo no terminal. Some sozinho quando o status chega sem ela. */}
      {session.pendingQuestion && session.status !== 'in_terminal' && (
        <QuestionPanel localId={session.localId} pending={session.pendingQuestion} />
      )}
      <ReauthBanner localId={session.localId} expired={session.authExpired} />
      <InlineFileView localId={session.localId} />
      {/* Avisos do plugin "You should know" do Claude: logo acima do campo, como no terminal. */}
      <HeadsUpBand localId={session.localId} />
      {/* Trabalho interrompido pelo reinício do Claudinei, do terminal desta aba. */}
      <InterruptedNotice projectId={session.projectId} engine={engine} />
      {/* Limite de uso que o terminal desta aba bateu. */}
      <UsageLimitNotice projectId={session.projectId} engine={engine} />
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
    </div>
    {progressOpen && <ProgressColumn projectId={session.projectId} engine={engine} sessionStatus={session.status} />}
    </div>
  )
}
