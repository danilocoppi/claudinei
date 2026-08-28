/**
 * O texto digitado e ainda não enviado, por terminal.
 *
 * O `ChatInput` é remontado a cada troca de terminal (`key={session.localId}` no
 * ChatView), então o que estava escrito sumia junto — e não havia como recuperar.
 * Aqui ele fica no navegador, e volta quando se volta.
 *
 * Um mapa só, e não uma chave por terminal: assim os rascunhos vão e voltam
 * juntos, e há um lugar único para descartar os antigos quando a cota aperta.
 */
export const DRAFTS_KEY = 'claudinei:drafts'

type Drafts = Record<string, string>

function readAll(): Drafts {
  try {
    const raw = localStorage.getItem(DRAFTS_KEY)
    if (!raw) return {}
    const v = JSON.parse(raw) as unknown
    // Só objeto de strings: qualquer outra coisa é lixo de uma versão anterior ou
    // de outra aba, e devolver isso viraria texto estranho no campo de alguém.
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).filter(([, t]) => typeof t === 'string'),
    ) as Drafts
  } catch {
    return {}
  }
}

const write = (d: Drafts): boolean => {
  try { localStorage.setItem(DRAFTS_KEY, JSON.stringify(d)); return true } catch { return false }
}

export function readDraft(localId: string): string {
  return readAll()[localId] ?? ''
}

export function saveDraft(localId: string, text: string): void {
  const drafts = readAll()
  // Campo vazio é rascunho APAGADO, não rascunho em branco: é assim que enviar
  // limpa o que ficou para trás, sem o envio precisar saber que rascunho existe.
  if (text) drafts[localId] = text
  else delete drafts[localId]

  if (write(drafts)) return

  // Cota cheia. O que está sendo escrito AGORA não pode ser o sacrificado: saem os
  // outros, do mais antigo para o mais novo (a ordem de inserção das chaves), até
  // caber ou não sobrar mais ninguém para descartar.
  const antigos = Object.keys(drafts).filter((k) => k !== localId)
  for (const k of antigos) {
    delete drafts[k]
    if (write(drafts)) return
  }
}
