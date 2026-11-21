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

// ── Atribuição entre terminais (server/src/undo/attribution.ts reexporta) ──

/** `own`: do turno; `uncertain`: mudou com outros turnos ativos e ninguém declarou o caminho. */
export type FileClass = 'own' | 'uncertain'

export interface AttributedFile extends FileChange {
  class: FileClass
  /** Outro turno ativo na mesma janela também declarou o caminho: vira conflito na prévia. */
  overlapped: boolean
  /** Dentro da pasta do projeto do terminal. */
  inProject: boolean
}

export type RestoreVerdict = 'revert' | 'already' | 'conflict'
export type RestoreAction = 'revert' | 'merge' | 'force' | 'keep'
/** `failed`: erro de E/S ao escrever aquele arquivo; os outros seguem. */
export type RestoreResult = 'reverted' | 'merged' | 'forced' | 'kept' | 'already' | 'changed_since_preview' | 'failed'

// ── Prévia e desfazer (server/src/undo/service.ts) ──

/** Quem pede: o administrador vê tudo; os outros, só os projetos da lista. */
export interface ViewerFull { isAdmin: boolean; projectIds: number[] | 'all' }

export interface PreviewFile {
  path: string
  class: FileClass
  /** O que a tela mostra: `overlapped` aparece sempre como `conflict`. */
  verdict: RestoreVerdict
  /** Só em conflict: "desfazer só as linhas do turno" aplica sem choque. */
  mergeable: boolean
  /** Só em conflict: o "agora" não é arquivo (pasta, bloqueado); a única escolha é manter. */
  keepOnly?: true
  overlapped: boolean
  /** Marcado de saída: só o `own` sem sobreposição que volta limpo. */
  checked: boolean
  /** conflict: o que mudou desde o turno (diff unificado, ≤ 2000 linhas). */
  sinceTurn?: string
  sinceTurnTruncated?: boolean
}

export interface UndoPreview {
  /** sha1 dos caminhos e digests do "agora", em ordem; o apply recusa se mudou. */
  token: string
  turnIds: number[]
  blockedBy: { kind: 'working' | 'in_terminal'; terminal: string | null } | null
  branchChanged: { from: string | null; to: string | null } | null
  /** own e uncertain; uncertain nasce desmarcado; overlapped vira conflict. */
  files: PreviewFile[]
  /** too_big, unsnapshotted e submodule: aparecem, sem desfazer. */
  notUndoable: FileChange[]
  hiddenOutside: number
}

export interface UndoRunDto {
  id: number
  kind: 'undo' | 'redo'
  turnIds: number[]
  /** `error` só em `failed`. */
  files: Array<{ path: string; result: RestoreResult; error?: string }>
  redone: boolean
  /**
   * Arquivos do desfazer fora da pasta do projeto, sem nome: vem no `undo_run`
   * publicado (vai a todos que veem o projeto, R15) e na resposta a quem não é
   * administrador.
   */
  hiddenOutside?: number
}

// ── Editar a partir daqui (server/src/undo/rewind.ts) ──

/**
 * A mensagem do operador a editar: o turno gravado (quando a web o conhece) e,
 * sempre, o texto e a ocorrência dele (0 = a última mensagem com a mesma chave).
 */
export interface RewindTarget { turnId?: number; text: string; occurrence: number }

export type RewindMode = 'conversation' | 'conversation_and_files'

/**
 * Por que uma das duas voltas está desligada. `claude_mid_turn`: a mensagem
 * entrou no meio do turno do Claude, e o corte ali não foi ensaiado (R20).
 * `in_terminal`: a sessão está aberta no terminal interativo e não pode ser
 * relançada.
 */
export type RewindReason =
  | 'engine_unsupported' | 'codex_mid_turn' | 'claude_mid_turn' | 'anchor_not_found' | 'no_git' | 'no_snapshot'
  | 'snapshot_late' | 'snapshot_lost' | 'no_session' | 'in_terminal'

export interface Availability { enabled: boolean; reason?: RewindReason; params?: Record<string, string> }

/**
 * POST /api/undo/terminals/:localId/rewind/options. `files.preview` só vem com
 * os turnos do trecho terminados; com o agente trabalhando, a prévia chega no
 * 409 do `rewind` depois da interrupção. `filesTouched`: algum turno do trecho
 * mexeu em arquivos (a volta só da conversa leva a nota).
 */
export interface RewindOptionsDto {
  engine: string
  conversation: Availability
  files: Availability & { preview?: UndoPreview }
  filesTouched: boolean
  working: boolean
}

/** POST /api/undo/terminals/:localId/rewind. `error`: a conversa não voltou (ou o texto não saiu); `run` fica. */
export interface RewindResultDto { conversationRewound: boolean; run?: UndoRunDto; error?: { code: string; message: string } }

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

/**
 * Mudanças fora de turno entre dois marcos seguidos do repositório (`from` e
 * `to` são ids de marco). `between`: entre turnos; `undo`: o próprio desfazer.
 * `at`: quando o marco de fim foi tirado.
 */
export interface IntervalDto { from: number; to: number; kind: 'between' | 'undo'; at: string }

/** GET /api/undo/terminals/:localId/turns */
export interface TerminalTurnsDto {
  git: boolean
  /** Conversa atual: não voltados, e da conversa de agora (ou sem conversa registrada). */
  turns: TurnDto[]
  /** "Fora da conversa atual". */
  outside: TurnDto[]
  /** Feito no terminal interativo. */
  interactive: TurnDto[]
  /** Só os que mudaram algo, do mais novo para o mais velho, até 50. */
  intervals: IntervalDto[]
}

/**
 * Arquivos de um turno ou de um intervalo. `warnings`: `late` (retrato
 * atrasado), `limited` (retrato limitado), `uncertain_end` (fim incerto).
 */
export interface ChangedFilesDto { files: AttributedFile[]; hiddenOutside: number; warnings: string[] }

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
