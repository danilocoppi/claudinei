import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from './en'
import es from './es'
import ptBR from './pt-BR'

const STORAGE_KEY = 'claudinei.locale'
export const LOCALES = [
  { code: 'en', flag: '🇺🇸', name: 'English' },
  { code: 'es', flag: '🇪🇸', name: 'Español' },
  { code: 'pt-BR', flag: '🇧🇷', name: 'Português' },
] as const

function savedLocale(): string {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    return v && LOCALES.some((l) => l.code === v) ? v : 'en'
  } catch { return 'en' }
}

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, es: { translation: es }, 'pt-BR': { translation: ptBR } },
  lng: savedLocale(),
  fallbackLng: 'en',
  interpolation: { escapeValue: false }, // React já escapa
})

i18n.on('languageChanged', (lng) => {
  try { localStorage.setItem(STORAGE_KEY, lng) } catch { /* storage indisponível: só não persiste */ }
  document.documentElement.lang = lng
})
document.documentElement.lang = i18n.language

export default i18n
