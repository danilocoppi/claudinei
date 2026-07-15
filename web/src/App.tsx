import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from './store'
import { fetchEngines, fetchGroups, fetchMe, fetchProjects, fetchSlashCommands } from './api'
import { connectWs } from './ws'
import { WsContext } from './wsContext'
import { Sidebar } from './components/Sidebar'
import { SidebarResizer } from './components/SidebarResizer'
import { Dashboard } from './components/Dashboard'
import { ChatView } from './components/ChatView'
import { BoardPanel } from './components/BoardPanel'
import { TasksPanel } from './components/TasksPanel'
import { TerminalView } from './components/TerminalView'
import { AuthScreen } from './components/AuthScreen'
import { FileViewerModal } from './components/FileViewerModal'
import { ExternalLinkConfirm } from './components/ExternalLinkConfirm'
import { MobileTopbar } from './components/MobileTopbar'
import { initNotifications } from './notifications'

export default function App() {
  const { t } = useTranslation()
  const view = useStore((s) => s.view)
  const setProjects = useStore((s) => s.setProjects)
  const authStatus = useStore((s) => s.authStatus)
  const setAuth = useStore((s) => s.setAuth)

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
    const client = connectWs((msg) => useStore.getState().applyWsMessage(msg))
    setWs(client)
    return () => { client.close(); setWs(undefined) }
  }, [authStatus])

  useEffect(() => {
    if (authStatus !== 'ready') return
    fetchProjects().then(setProjects).catch(() => {})
    fetchGroups().then((groups) => useStore.getState().setGroups(groups)).catch(() => {})
    // Pré-carrega a lista de slash commands (persistida no backend) para o
    // autocomplete do chat mostrar tudo já no primeiro `/`, sem esperar a 1ª msg.
    fetchSlashCommands().then((cmds) => useStore.getState().setSlashCommands(cmds)).catch(() => {})
    // Metadados por engine (models/efforts/permissions/slash) p/ a UX se adaptar (SP-C).
    fetchEngines().then((engines) => useStore.getState().setEngines(engines)).catch(() => {})
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
  useEffect(() => { setNavOpen(false) }, [view, activeLocalId])
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
    return t('sidebar.overview')
  })

  if (authStatus === 'loading') return null
  if (authStatus === 'setup' || authStatus === 'login') {
    return <AuthScreen mode={authStatus} onDone={(me) => setAuth('ready', me)} />
  }

  return (
    <WsContext.Provider value={ws ?? null}>
      <div className={`app ${navOpen ? 'nav-open' : ''}`}>
        <MobileTopbar open={navOpen} onToggle={() => setNavOpen((o) => !o)} title={topbarTitle} />
        <Sidebar />
        <SidebarResizer />
        {navOpen && <div className="mobile-backdrop" onClick={() => setNavOpen(false)} />}
        <div className="main">
          {view === 'dashboard' && <Dashboard />}
          {view === 'chat' && <ChatView />}
          {view === 'board' && <BoardPanel />}
          {view === 'tasks' && <TasksPanel />}
          {view === 'terminal' && <TerminalView />}
        </div>
        <FileViewerModal />
        <ExternalLinkConfirm />
      </div>
    </WsContext.Provider>
  )
}
