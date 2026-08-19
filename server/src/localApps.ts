import { spawn } from 'node:child_process'
import { binAvailableCached } from './engine/available.js'

/**
 * Abrir a pasta, o editor ou um terminal na pasta do projeto.
 *
 * A ação é uma CHAVE, nunca um comando: o cliente manda `vscode`, não `code`. É o
 * que impede o parâmetro de virar "execute qualquer coisa nesta máquina" — a
 * tradução de chave em comando mora aqui, numa tabela fechada.
 */
export type LocalApp = 'folder' | 'vscode' | 'terminal'
export const LOCAL_APPS: LocalApp[] = ['folder', 'vscode', 'terminal']

export interface Launcher { cmd: string; args: string[] }

/**
 * Candidatos por app, em ordem de preferência — vence o primeiro que existir no
 * PATH. Terminal no Linux não tem padrão: cada desktop traz o seu, e
 * `x-terminal-emulator` (a alternativa do Debian/Ubuntu) vem primeiro justamente
 * porque respeita a escolha que o usuário já fez no sistema.
 */
function candidatesFor(app: LocalApp, dir: string, platform: NodeJS.Platform): Launcher[] {
  const mac = platform === 'darwin'
  const win = platform === 'win32'

  if (app === 'folder') {
    if (mac) return [{ cmd: 'open', args: [dir] }]
    if (win) return [{ cmd: 'explorer', args: [dir] }]
    return [{ cmd: 'xdg-open', args: [dir] }]
  }

  if (app === 'vscode') {
    // `code` é o comando que o próprio VS Code instala no PATH; `codium` cobre a
    // build livre, que é comum em Linux.
    return [{ cmd: 'code', args: [dir] }, { cmd: 'codium', args: [dir] }]
  }

  if (mac) return [{ cmd: 'open', args: ['-a', 'Terminal', dir] }]
  if (win) return [{ cmd: 'wt', args: ['-d', dir] }, { cmd: 'cmd', args: ['/c', 'start', 'cmd', '/k', `cd /d ${dir}`] }]
  return [
    { cmd: 'x-terminal-emulator', args: ['--working-directory', dir] },
    { cmd: 'gnome-terminal', args: ['--working-directory', dir] },
    { cmd: 'konsole', args: ['--workdir', dir] },
    { cmd: 'xfce4-terminal', args: [`--working-directory=${dir}`] },
    { cmd: 'alacritty', args: ['--working-directory', dir] },
    { cmd: 'kitty', args: ['--directory', dir] },
    { cmd: 'xterm', args: [] },
  ]
}

export interface LocalAppsDeps {
  available?: (bin: string) => boolean
  platform?: NodeJS.Platform
  spawnFn?: typeof spawn
}

/** O primeiro candidato instalado, ou null se nenhum está. */
export function resolveLauncher(app: LocalApp, dir: string, deps: LocalAppsDeps = {}): Launcher | null {
  const available = deps.available ?? binAvailableCached
  const platform = deps.platform ?? process.platform
  return candidatesFor(app, dir, platform).find((c) => available(c.cmd)) ?? null
}

/** Quais apps dá para abrir nesta máquina. O menu só mostra o que vai funcionar. */
export function availableApps(deps: LocalAppsDeps = {}): Record<LocalApp, boolean> {
  return Object.fromEntries(
    LOCAL_APPS.map((app) => [app, resolveLauncher(app, '.', deps) !== null]),
  ) as Record<LocalApp, boolean>
}

/**
 * Dispara e solta: `detached` + `unref` para o Claudinei não ficar preso ao
 * processo do editor ou do terminal, e sem shell para o caminho não passar por
 * interpretação de aspas.
 */
export function launchApp(app: LocalApp, dir: string, deps: LocalAppsDeps = {}): void {
  const launcher = resolveLauncher(app, dir, deps)
  if (!launcher) throw new Error(`nada instalado para abrir "${app}" nesta máquina`)
  const child = (deps.spawnFn ?? spawn)(launcher.cmd, launcher.args, { detached: true, stdio: 'ignore' })
  child.unref?.()
}
