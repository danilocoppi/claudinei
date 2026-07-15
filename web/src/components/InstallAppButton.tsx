import { useTranslation } from 'react-i18next'
import { useStore } from '../store'

/**
 * "Instalar app no dispositivo": aparece SÓ quando o navegador ofereceu a instalação
 * (evento beforeinstallprompt, capturado no main.tsx). Um clique abre o prompt nativo
 * — no desktop cria o atalho/janela própria; no Android instala na tela inicial.
 * Navegador sem suporte (ou app já instalado): o botão simplesmente não existe.
 */
export function InstallAppButton() {
  const { t } = useTranslation()
  const prompt = useStore((s) => s.installPrompt)
  const clear = useStore((s) => s.clearInstallPrompt)
  if (!prompt) return null
  const install = async () => {
    try {
      await prompt.prompt()
      await prompt.userChoice
    } finally {
      clear() // o evento só pode ser usado uma vez; se recusou, o browser reoferece depois
    }
  }
  return (
    <button type="button" className="install-app-btn" title={t('pwa.install')} aria-label={t('pwa.install')}
            onClick={() => void install()}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" />
      </svg>
    </button>
  )
}
