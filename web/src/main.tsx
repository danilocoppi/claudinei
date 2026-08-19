import React from 'react'
import ReactDOM from 'react-dom/client'
import './i18n'
import App from './App'
import './styles.css'

import { useStore } from './store'
import { applyAppearance, readCachedAppearance } from './appearance'

// A aparência mora no servidor, mas chega depois de um fetch: sem aplicar o cache
// ANTES da primeira pintura, o app abre escuro e pisca para claro. O servidor
// continua sendo a verdade e reconcilia assim que responde (App.tsx).
applyAppearance(readCachedAppearance())

// PWA: o beforeinstallprompt pode disparar antes do React montar — captura aqui
// e guarda no store; o InstallAppButton (sidebar) só aparece quando ele existe.
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault()
  useStore.getState().setInstallPrompt(e as unknown as { prompt(): Promise<void>; userChoice: Promise<unknown> })
})
window.addEventListener('appinstalled', () => useStore.getState().clearInstallPrompt())

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
