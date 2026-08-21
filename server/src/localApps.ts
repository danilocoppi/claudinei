import { spawn } from 'node:child_process'
import { posix, win32 } from 'node:path'
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

/**
 * Os terminais que sabemos abrir, em ordem de preferência, com o nome pelo qual
 * uma pessoa os reconhece.
 *
 * `x-terminal-emulator` vem primeiro por princípio — é a alternativa que o próprio
 * sistema aponta — mas ela não é confiável como ADIVINHAÇÃO: nesta máquina resolvia
 * para o terminator, que não é o terminal que o dono usa. Daí a lista existir: o
 * padrão continua sendo o do sistema, e quem discorda escolhe.
 */
export const TERMINALS: { id: string; label: string; args: (dir: string) => string[] }[] = [
  { id: 'x-terminal-emulator', label: 'Padrão do sistema', args: (d) => ['--working-directory', d] },
  { id: 'gnome-terminal', label: 'GNOME Terminal', args: (d) => ['--working-directory', d] },
  { id: 'konsole', label: 'Konsole', args: (d) => ['--workdir', d] },
  { id: 'xfce4-terminal', label: 'Xfce Terminal', args: (d) => [`--working-directory=${d}`] },
  { id: 'terminator', label: 'Terminator', args: (d) => ['--working-directory', d] },
  { id: 'tilix', label: 'Tilix', args: (d) => ['--working-directory', d] },
  { id: 'alacritty', label: 'Alacritty', args: (d) => ['--working-directory', d] },
  { id: 'kitty', label: 'kitty', args: (d) => ['--directory', d] },
  { id: 'wezterm', label: 'WezTerm', args: (d) => ['start', '--cwd', d] },
  { id: 'ghostty', label: 'Ghostty', args: (d) => [`--working-directory=${d}`] },
  { id: 'foot', label: 'foot', args: (d) => ['--working-directory', d] },
  { id: 'xterm', label: 'xterm', args: () => [] },
]

/**
 * Marcador deixado por `reexecIfNeeded`: o `LD_LIBRARY_PATH` de ANTES de o
 * Claudinei injetar o dele. É o que permite devolver o ambiente do sistema a um
 * app do sistema (ver `desktopEnv`).
 */
export const ORIG_LD = 'CLAUDINEI_ORIG_LD_LIBRARY_PATH'

/** Quanto se espera para ver se o app morre no arranque antes de soltá-lo. */
const GRACE_MS = 900

/**
 * O ambiente com que um app do desktop tem que nascer.
 *
 * O Claudinei roda com um `LD_LIBRARY_PATH` próprio, apontando para o libstdc++
 * portátil que ele carrega para a transcrição de voz — e todo processo filho
 * HERDA esse env. O libstdc++ embarcado é mais velho que o do sistema, então
 * qualquer app gráfico que precise de símbolo novo morre no arranque:
 *
 *   gnome-terminal: libstdc++.so.6: version `GLIBCXX_3.4.31' not found
 *                   (required by /lib/x86_64-linux-gnu/libvte-2.91.so.0)
 *
 * E como o spawn descartava a saída de erro, isso chegava ao usuário como
 * silêncio: clicava em "Abrir terminal" e nada acontecia.
 *
 * Sem o marcador, nada foi injetado (rodando do fonte) — e aí um LD_LIBRARY_PATH
 * que exista é do usuário, que não se mexe.
 */
export function desktopEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (!(ORIG_LD in env)) return env
  const out = { ...env }
  const original = out[ORIG_LD]
  delete out[ORIG_LD]
  if (original) out.LD_LIBRARY_PATH = original
  else delete out.LD_LIBRARY_PATH
  return out
}

export interface Launcher {
  cmd: string
  args: string[]
  /** Pasta como diretório de trabalho, quando ela NÃO pode ir em argumento. */
  cwd?: string
}

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
  // O `cmd.exe` RE-INTERPRETA a linha de comando que recebe: um nome de pasta com
  // "&" (que o Windows permite) emendaria um segundo comando. Por isso a pasta vai
  // como `cwd`, que não passa por interpretação nenhuma, em vez de ser interpolada.
  if (win) return [{ cmd: 'wt', args: ['-d', dir] }, { cmd: 'cmd', args: ['/c', 'start', '', 'cmd'], cwd: dir }]
  return TERMINALS.map((t) => ({ cmd: t.id, args: t.args(dir) }))
}

export interface LocalAppsDeps {
  available?: (bin: string) => boolean
  platform?: NodeJS.Platform
  spawnFn?: typeof spawn
  /** Terminal escolhido nas configurações. Vazio = o padrão do sistema. */
  terminal?: string | null
  /** Injetável para o teste não depender do env do processo. */
  env?: NodeJS.ProcessEnv
}

/** Os terminais instalados aqui, para a tela de configuração oferecer a escolha. */
export function availableTerminals(deps: LocalAppsDeps = {}): { id: string; label: string }[] {
  const available = deps.available ?? binAvailableCached
  if ((deps.platform ?? process.platform) !== 'linux') return []
  return TERMINALS.filter((t) => available(t.id)).map(({ id, label }) => ({ id, label }))
}

/** O primeiro candidato instalado, ou null se nenhum está. */
export function resolveLauncher(app: LocalApp, dir: string, deps: LocalAppsDeps = {}): Launcher | null {
  const available = deps.available ?? binAvailableCached
  const platform = deps.platform ?? process.platform
  const candidates = candidatesFor(app, dir, platform)
  // A escolha do usuário é uma CHAVE, como a ação: ela só pode APONTAR para um
  // candidato desta lista, nunca virar um comando. E se o escolhido sumiu da
  // máquina, cai na ordem de sempre em vez de deixar o botão morto.
  if (app === 'terminal' && deps.terminal) {
    const escolhido = candidates.find((c) => c.cmd === deps.terminal && available(c.cmd))
    if (escolhido) return escolhido
  }
  return candidates.find((c) => available(c.cmd)) ?? null
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
 *
 * Espera um instante antes de soltar, só para saber se o app MORREU no arranque.
 * Antes disso a saída de erro ia para o lixo e um app que não subia era
 * indistinguível de um que subiu: clicava-se no botão e não acontecia nada, sem
 * mensagem nenhuma para investigar.
 */
export async function launchApp(app: LocalApp, dir: string, deps: LocalAppsDeps = {}): Promise<void> {
  // A regra de "absoluto" é da PLATAFORMA, não do processo: `path.isAbsolute` no
  // Linux recusa `C:\\...`, e usá-lo direto tornaria a checagem errada em Windows.
  const platform = deps.platform ?? process.platform
  const isAbsolute = (platform === 'win32' ? win32 : posix).isAbsolute
  // Caminho ABSOLUTO, sempre. Não é formalidade: um valor começando com "-" seria
  // lido como FLAG pelo programa, não como pasta — inofensivo no xdg-open, nada
  // inofensivo no `code`, que tem flags para instalar extensão e trocar o
  // diretório de dados. Exigir absoluto mata a classe inteira de uma vez, porque
  // caminho absoluto nunca começa com hífen.
  if (!dir || !isAbsolute(dir)) throw new Error(`caminho do terminal precisa ser absoluto: "${dir}"`)
  const launcher = resolveLauncher(app, dir, deps)
  if (!launcher) throw new Error(`nada instalado para abrir "${app}" nesta máquina`)

  const child = (deps.spawnFn ?? spawn)(launcher.cmd, launcher.args, {
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    // Ambiente do SISTEMA, não o nosso: ver `desktopEnv`.
    env: desktopEnv(deps.env ?? process.env),
    ...(launcher.cwd ? { cwd: launcher.cwd } : {}),
  })

  const erro = await new Promise<string | null>((resolve) => {
    let saida = ''
    // Muitos terminais entregam a janela a um serviço e saem com 0 no ato: sair
    // cedo COM sucesso é normal, sair com erro não é.
    const solta = setTimeout(() => resolve(null), GRACE_MS)
    child.stderr?.on('data', (b: Buffer) => { saida += b.toString() })
    child.once('error', (e: Error) => { clearTimeout(solta); resolve(e.message) })
    child.once('exit', (code: number | null) => {
      clearTimeout(solta)
      resolve(code ? (saida.trim().split('\n').pop() ?? `saiu com código ${code}`) : null)
    })
  })

  child.stderr?.destroy()
  child.unref?.()
  if (erro) throw new Error(`${launcher.cmd}: ${erro}`)
}
