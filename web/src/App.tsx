import { lazy, Suspense, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from './store'
import { fetchGroups, fetchMe, fetchProjects, fetchSchedules, fetchSectors, fetchSlashCommands } from './api'
import { syncPrefs } from './prefsSync'
import { connectWs } from './ws'
import { WsContext } from './wsContext'
import { Sidebar } from './components/Sidebar'
import { SidebarResizer } from './components/SidebarResizer'
import { Dashboard } from './components/Dashboard'
import { ChatView } from './components/ChatView'
import { BoardPanel } from './components/BoardPanel'
import { TasksPanel } from './components/TasksPanel'
import { AuthScreen } from './components/AuthScreen'
import { OrphanActions } from './components/OrphanActions'
import { FileOpenMenu } from './components/FileOpenMenu'
import { ExternalLinkConfirm } from './components/ExternalLinkConfirm'
import { MobileTopbar } from './components/MobileTopbar'
import { UndoToast } from './components/UndoToast'
import { initNotifications } from './notifications'
import { installIndicatorMotion } from './indicatorMotion'
import { useAccessHours } from './useAccessHours'
import { useEngineCatalog } from './useEngineCatalog'
import { useTerminalStatesSync } from './useTerminalStatesSync'
import { useUsageShortcut } from './useUsageShortcut'
import { useTriageSync } from './useTriageSync'
import { useZenShortcut } from './useZenShortcut'
import { useShortcutLabel } from './shortcuts/active'
import { AccessLocked } from './components/AccessLocked'
import './access-hours.css'

/**
 * O que não pertence ao carregamento inicial.
 *
 * O bundle era um arquivo só de 1,38 MB, e 45% dele eram bibliotecas que a tela
 * de login nunca usa: o xterm (terminal e Actions), o seletor de emoji, e as
 * telas que só abrem por clique. Cada uma vira um chunk que baixa na primeira
 * vez que é preciso. Em localhost a diferença é nula; em acesso remoto por rede
 * lenta é a diferença entre 1 e 3 segundos até a tela responder.
 */
const SchedulesView = lazy(() => import('./components/SchedulesView').then((m) => ({ default: m.SchedulesView })))
const TerminalView = lazy(() => import('./components/TerminalView').then((m) => ({ default: m.TerminalView })))
const ActionRunModal = lazy(() => import('./components/ActionRunModal').then((m) => ({ default: m.ActionRunModal })))
const FileViewerModal = lazy(() => import('./components/FileViewerModal').then((m) => ({ default: m.FileViewerModal })))
const UsagePage = lazy(() => import('./components/UsagePage').then((m) => ({ default: m.UsagePage })))

/**
 * Os modais são renderizados SEMPRE (devolvem null quando inativos), então um
 * lazy puro baixaria o chunk no mount do App e não ganharia nada. Estes portões
 * só montam o componente quando há o que mostrar — é aí que o xterm baixa.
 */
function ActionRunsGate() {
  const temRuns = useStore((s) => s.actionRuns.length > 0)
  return temRuns ? <Suspense fallback={null}><ActionRunModal /></Suspense> : null
}
function FileViewerGate() {
  const aberto = useStore((s) => !!s.fileViewer)
  return aberto ? <Suspense fallback={null}><FileViewerModal /></Suspense> : null
}

/**
 * O atalho e a saída do modo Zen. Só monta com o app liberado: na tela de login o
 * atalho do Zen não tem moldura para esconder. O botão é estático (sem animação: a
 * interface precisa andar sem GPU) e serve a quem não lembra a tecla e ao celular.
 */
function ZenControls() {
  const { t } = useTranslation()
  useZenShortcut()
  const atalho = useShortcutLabel('view.zen')
  const zen = useStore((s) => s.zen)
  const toggleZen = useStore((s) => s.toggleZen)
  if (!zen) return null
  return (
    <button type="button" className="ghost zen-exit" title={atalho === null ? t('zen.hintNoKey') : t('zen.hint', { combo: atalho })} onClick={toggleZen}>
      {t('zen.exit')}
    </button>
  )
}

export default function App() {
  const { t } = useTranslation()
  const view = useStore((s) => s.view)
  const setProjects = useStore((s) => s.setProjects)
  const authStatus = useStore((s) => s.authStatus)
  // Zen esconde a moldura (lateral, topbar do celular, cabeçalho do chat e coluna
  // do acompanhamento); a conversa, os avisos e o campo ficam.
  const zen = useStore((s) => s.zen)
  const setAuth = useStore((s) => s.setAuth)
  useAccessHours()
  useEngineCatalog(authStatus === 'ready')
  useTerminalStatesSync()
  // Ctrl+U só para administrador: a página lê o uso de todos (a rota dá 403 aos demais).
  // Mesma regra da lateral para o cartão Uso: sem `me` (sem login) vale como administrador.
  const isAdmin = useStore((s) => !s.me || s.me.isAdmin !== false)
  useUsageShortcut(authStatus === 'ready' && isAdmin)
  useTriageSync()

  useEffect(() => installIndicatorMotion(), [])

  useEffect(() => {
    const syncVisibility = () => { document.documentElement.dataset.pageHidden = String(document.hidden) }
    syncVisibility()
    document.addEventListener('visibilitychange', syncVisibility)
    return () => {
      document.removeEventListener('visibilitychange', syncVisibility)
      delete document.documentElement.dataset.pageHidden
    }
  }, [])

  // Gate de boot: /me decide setup (0 usuários) × login × app liberado.
  useEffect(() => {
    fetchMe()
      .then((me) => setAuth(me.setupRequired ? 'setup' : 'ready', me.setupRequired ? null : me))
      .catch(() => setAuth('login'))
  }, [])

  // Sessão expirou/revogada no meio do uso → volta ao login.
  useEffect(() => {
    const onUnauthorized = () => setAuth('login', null)
    window.addEventListener('claudinei:unauthorized', onUnauthorized)
    return () => window.removeEventListener('claudinei:unauthorized', onUnauthorized)
  }, [])

  // O WS é criado DENTRO do efeito (não no inicializador do useState): assim o
  // ciclo mount→cleanup→mount do StrictMode cria→fecha→cria UMA única conexão
  // viva. Criá-lo no useState fazia o cleanup fechar o socket usado para ENVIAR
  // enquanto um socket órfão seguia recebendo — o chat recebia mas não enviava.
  // Só conecta quando autenticado ('ready'): antes disso o handshake levaria 401.
  const [ws, setWs] = useState<ReturnType<typeof connectWs>>()
  useEffect(() => {
    if (authStatus !== 'ready') return
    const client = connectWs(
      (msg) => useStore.getState().applyWsMessage(msg),
      // RE-conexão: eventos perdidos na queda não são reenviados pelo servidor —
      // invalida os históricos carregados (o ChatView rebusca) e limpa streaming órfão.
      () => useStore.getState().resyncOnReconnect(),
    )
    setWs(client)
    return () => { client.close(); setWs(undefined) }
  }, [authStatus])

  useEffect(() => {
    if (authStatus !== 'ready') return
    fetchProjects().then(setProjects).catch(() => {})
    fetchGroups().then((groups) => useStore.getState().setGroups(groups)).catch(() => {})
    fetchSectors().then((sectors) => useStore.getState().setSectors(sectors)).catch(() => {})
    // Lista enxuta de agendamentos: é ela que acende o ⏱ nos cartões da sidebar.
    fetchSchedules().then((s) => useStore.getState().setSchedules(s)).catch(() => {})
    // Reconcilia aparência e atalhos com o servidor: se ele discordar do cache, ele vence.
    void syncPrefs()
    // Pré-carrega a lista de slash commands (persistida no backend) para o
    // autocomplete do chat mostrar tudo já no primeiro `/`, sem esperar a 1ª msg.
    fetchSlashCommands().then((cmds) => useStore.getState().setSlashCommands(cmds)).catch(() => {})
  }, [authStatus])

  useEffect(() => {
    const once = () => { initNotifications(); window.removeEventListener('click', once) }
    window.addEventListener('click', once)
    return () => window.removeEventListener('click', once)
  }, [])

  const totalUnread = useStore((s) => Object.values(s.unread).reduce((a, b) => a + b, 0))
  useEffect(() => {
    document.title = totalUnread > 0 ? `(${totalUnread}) Claudinei` : 'Claudinei'
  }, [totalUnread])

  // Gaveta mobile: navegar (trocar de visão/sessão) fecha; Esc fecha.
  const [navOpen, setNavOpen] = useState(false)
  const activeLocalId = useStore((s) => s.activeLocalId)
  // Entrar ou sair do Zen também fecha: a gaveta não reaparece aberta ao sair.
  useEffect(() => { setNavOpen(false) }, [view, activeLocalId, zen])
  useEffect(() => {
    if (!navOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setNavOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navOpen])
  // Título de contexto da topbar: nome do projeto na visão de chat/terminal, senão a visão.
  const topbarTitle = useStore((s) => {
    if ((s.view === 'chat' || s.view === 'terminal') && s.activeLocalId) {
      const session = s.sessions[s.activeLocalId]
      return s.projects.find((p) => p.id === session?.projectId)?.name ?? 'Claudinei'
    }
    if (s.view === 'board') return t('sidebar.board')
    if (s.view === 'tasks') return t('sidebar.tasks')
    if (s.view === 'usage') return t('usagePage.title')
    return t('sidebar.overview')
  })

  if (authStatus === 'loading') return null
  if (authStatus === 'locked') return <AccessLocked />
  if (authStatus === 'setup' || authStatus === 'login') {
    return <AuthScreen mode={authStatus} onDone={(me) => setAuth('ready', me)} />
  }

  return (
    <WsContext.Provider value={ws ?? null}>
      {/* Zen esconde a moldura por CSS (`.app.zen`), sem desmontá-la: um modal aberto
          a partir da lateral (Aparência, Novo terminal…) ou um campo meio preenchido
          nela sobrevivem à combinação do Zen, e o "cancelar" deles continua sendo o
          único jeito de desfazer uma prévia. */}
      <div className={`app ${navOpen ? 'nav-open' : ''} ${zen ? 'zen' : ''}`}>
        {/* Nas visões de detalhe (conversa e terminal) o ☰ vira "voltar", e voltar
            é trazer a lista de terminais — que no celular É a gaveta. */}
        <MobileTopbar
          open={navOpen}
          onToggle={() => setNavOpen((o) => !o)}
          title={topbarTitle}
          onBack={view === 'chat' || view === 'terminal' ? () => setNavOpen(true) : undefined}
        />
        <Sidebar />
        <SidebarResizer />
        {navOpen && <div className="mobile-backdrop" onClick={() => setNavOpen(false)} />}
        <div className="main">
          {view === 'dashboard' && <Dashboard />}
          {view === 'chat' && <ChatView />}
          {view === 'board' && <BoardPanel />}
          {view === 'tasks' && <TasksPanel />}
          {view === 'schedules' && <Suspense fallback={null}><SchedulesView /></Suspense>}
          {view === 'terminal' && <Suspense fallback={null}><TerminalView /></Suspense>}
          {view === 'usage' && <Suspense fallback={null}><UsagePage /></Suspense>}
        </div>
        <ActionRunsGate />
        <OrphanActions />
        <FileViewerGate />
        <FileOpenMenu />
        <ExternalLinkConfirm />
        <UndoToast />
        <ZenControls />
      </div>
    </WsContext.Provider>
  )
}
