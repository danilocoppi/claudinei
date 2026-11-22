// O protocolo do WebSocket da tela do navegador embutido (`/ws/browser/:projectId/:engine`),
// que o servidor e a web compartilham. Sem dependência de Node: a web compila este arquivo.
//
// Servidor → web:
// - texto JSON: `BrowserStateMsg`;
// - binário: `FRAME_HEADER_BYTES` bytes (uint32 big-endian com o tamanho do
//   cabeçalho JSON), o cabeçalho (`FrameHeader`) e a imagem (JPEG do quadro,
//   PNG do congelado).
// Web → servidor, texto JSON: `BrowserClientMsg`.

/** O cabeçalho de um quadro binário: `frame` (JPEG do screencast) ou `still` (PNG do congelado). */
export interface FrameHeader { kind: 'frame' | 'still'; seq: number; width: number; height: number }

export interface BrowserStateMsg {
  type: 'state'; url: string; title: string; loading: boolean; crashed: boolean
  /** `you`: o dono do bastão é o usuário deste espectador. */
  baton: { kind: 'free' } | { kind: 'agent' } | { kind: 'operator'; name: string; you: boolean }
  viewport: { width: number; height: number }
  dialog: { id: number; type: 'confirm' | 'prompt'; message: string; defaultValue?: string } | null
  notices: string[]; lastAction: { text: string; at: number; point?: { x: number; y: number } } | null
  sandbox: boolean
  unavailable?: { code: 'browser_not_installed' | 'launch_failed'; hint: string; message: string }
  closed?: 'idle' | 'evicted' | 'closed_by_user' | 'closed_by_agent' | 'browser_closed' | 'shutdown'
}

export type BrowserClientMsg =
  | { type: 'visible'; visible: boolean }
  | { type: 'resize'; width: number; height: number }
  | { type: 'pointer'; phase: 'down' | 'up' | 'move'; x: number; y: number; button: 'left' | 'middle' | 'right'; clickCount?: number }
  | { type: 'wheel'; x: number; y: number; dx: number; dy: number }
  | { type: 'key'; phase: 'down' | 'up'; key: string; code: string; alt: boolean; ctrl: boolean; meta: boolean; shift: boolean }
  | { type: 'text'; text: string }
  | { type: 'navigate'; url: string }
  | { type: 'history'; action: 'back' | 'forward' | 'reload' }
  | { type: 'take' } | { type: 'release' }
  | { type: 'dialog'; accept: boolean; text?: string }
  | { type: 'freeze'; on: boolean }

export const FRAME_HEADER_BYTES = 4   // uint32 big-endian com o tamanho do JSON
