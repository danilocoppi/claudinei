// Desfazer turno: textos ao agente, a chave do turno e os tipos que o servidor
// e a web compartilham. Sem dependência de Node: a web compila este arquivo.

// ── Tipos do motor de retratos (checkpoint/diff.ts e checkpoint/restore.ts reexportam) ──

export type FileStatus = 'added' | 'modified' | 'deleted' | 'mode' | 'submodule' | 'too_big' | 'unsnapshotted'

export interface FileChange {
  path: string
  status: FileStatus
  /** Linhas acrescentadas (numstat); 0 em binário, submódulo, too_big e unsnapshotted. */
  added: number
  removed: number
  binary: boolean
  /** too_big e unsnapshotted: tamanho em bytes, quando conhecido. */
  size?: number
}

export interface FileDiff { path: string; binary: boolean; sizeKb?: number; text: string; truncated: boolean }

export type RestoreVerdict = 'revert' | 'already' | 'conflict'
export type RestoreAction = 'revert' | 'merge' | 'force' | 'keep'
/** `failed`: erro de E/S ao escrever aquele arquivo; os outros seguem. */
export type RestoreResult = 'reverted' | 'merged' | 'forced' | 'kept' | 'already' | 'changed_since_preview' | 'failed'

// ── Turnos ──

export type TurnOrigin = 'operator' | 'claudinei' | 'task' | 'schedule' | 'goal' | 'engine' | 'interactive'
export type EndKind = 'result' | 'interrupted' | 'cut' | 'dead' | 'stopped' | 'restart' | 'uncertain'

export interface TurnSummary { files: number; added: number; removed: number; outside: number; uncertain: number; unsnapshotted: number }

export interface TurnDto {
  id: number
  localId: string
  projectId: number
  engine: string
  origin: TurnOrigin
  key: string | null
  midTurn: boolean
  state: 'running' | 'ok' | 'late' | 'failed' | 'no_git' | 'lost'
  stateReason?: string
  limited: boolean
  endKind: EndKind | null
  summary: TurnSummary | null
  lastRun: { id: number; redone: boolean } | null
  startedAt: string
  endedAt: string | null
}

// ── Textos ao agente (inglês, verbatim) ──

export const FILES_REVERTED_PREFIX = '[Claudinei: files reverted]'
export const CONVERSATION_REWOUND_PREFIX = '[Claudinei: conversation rewound]'

const FILES_REVERTED_HEAD = `${FILES_REVERTED_PREFIX}: The operator reverted the file changes of an earlier turn: `
const FILES_REVERTED_TAIL = '. Re-read them before editing.'
const NOTE_MAX_PATHS = 30

export const CONVERSATION_REWOUND_NOTE = `${CONVERSATION_REWOUND_PREFIX}: Files still contain changes made after this point.`

/** Caminhos relativos ao topo; até 30, depois ` and <n> more`. */
export function filesRevertedNote(paths: string[]): string {
  const shown = paths.slice(0, NOTE_MAX_PATHS).join(', ')
  const more = paths.length > NOTE_MAX_PATHS ? ` and ${paths.length - NOTE_MAX_PATHS} more` : ''
  return `${FILES_REVERTED_HEAD}${shown}${more}${FILES_REVERTED_TAIL}`
}

/** A nota vai na frente da mensagem, separada por uma linha em branco. */
export function withNote(note: string, text: string): string {
  return `${note}\n\n${text}`
}

export type NoteKind = 'files_reverted' | 'conversation_rewound'

const NOTE_SEP = '\n\n'

// Uma nota só conta no começo do texto e seguida da linha em branco. Fora
// disso (o operador citando o prefixo no meio da mensagem, ou o prefixo com
// outra frase), o texto fica intacto.
function leadingNote(text: string): { kind: NoteKind; body: string } | null {
  if (text.startsWith(CONVERSATION_REWOUND_NOTE + NOTE_SEP)) {
    return { kind: 'conversation_rewound', body: CONVERSATION_REWOUND_NOTE }
  }
  if (text.startsWith(FILES_REVERTED_HEAD)) {
    const end = text.indexOf(FILES_REVERTED_TAIL + NOTE_SEP, FILES_REVERTED_HEAD.length)
    if (end >= 0) return { kind: 'files_reverted', body: text.slice(0, end + FILES_REVERTED_TAIL.length) }
  }
  return null
}

/** Separa as notas do Claudinei do começo da mensagem; `body` é o texto inteiro de cada nota. */
export function stripNotes(text: string): { notes: Array<{ kind: NoteKind; body: string }>; rest: string } {
  const notes: Array<{ kind: NoteKind; body: string }> = []
  let rest = text
  for (let note = leadingNote(rest); note; note = leadingNote(rest)) {
    notes.push(note)
    rest = rest.slice(note.body.length + NOTE_SEP.length)
  }
  return { notes, rest }
}

// Um envelope no começo: `[Task from …]:`, `[Agendamento: … #n]`, `[Claudinei: goal]:`, `[WIP]`.
const ENVELOPE = /^\[[^\]\n]{1,200}\]:?\s*/
const KEY_MAX = 300

/**
 * Chave para achar a mensagem do turno no histórico do motor: a mesma no
 * servidor e na web. Sem as notas, sem um envelope, espaços juntados, 300
 * caracteres.
 */
export function turnKey(text: string): string {
  return stripNotes(text).rest.replace(ENVELOPE, '').replace(/\s+/g, ' ').trim().slice(0, KEY_MAX)
}
