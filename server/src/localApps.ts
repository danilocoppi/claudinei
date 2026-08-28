import { execFileSync, spawn } from 'node:child_process'
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
    // No mac e no Windows o comando já SIGNIFICA o gerenciador de arquivos.
    if (mac) return [{ cmd: 'open', args: [dir] }]
    if (win) return [{ cmd: 'explorer', args: [dir] }]
    // No Linux, não. `xdg-open` abre o diretório com quem estiver registrado para
    // `inode/directory` — e IDEs reivindicam essa associação na instalação: numa
    // máquina real, "Abrir pasta" abria o Android Studio, porque era ele que
    // respondia por diretório. O item promete o navegador de ARQUIVOS (ele fica ao
    // lado de "Abrir no VS Code"), então é ele que se procura primeiro. O
    // `xdg-open` fica como último recurso: abrir a coisa errada ainda é melhor que
    // não abrir nada.
    return [
      { cmd: 'nautilus', args: [dir] },
      { cmd: 'dolphin', args: [dir] },
      { cmd: 'nemo', args: [dir] },
      { cmd: 'thunar', args: [dir] },
      { cmd: 'caja', args: [dir] },
      { cmd: 'pcmanfm', args: [dir] },
      { cmd: 'pcmanfm-qt', args: [dir] },
      { cmd: 'xdg-open', args: [dir] },
    ]
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

/**
 * As variáveis que dizem ONDE está a tela do usuário. Só estas três: o resto do
 * ambiente do gerenciador é dele, e misturar traria PATH e HOME de carona.
 */
const GRAPHICAL = ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY'] as const

/**
 * O ambiente gráfico da sessão VIVA, perguntado ao gerenciador do systemd.
 *
 * O serviço nasce quando o systemd manda, que costuma ser ANTES de a sessão
 * gráfica exportar essas variáveis — e o usuário ainda pode sair e entrar de novo,
 * trocando de X11 para Wayland, o que muda todas elas. O env congelado no arranque
 * aponta para uma sessão que já não existe; o gerenciador sabe a de agora.
 *
 * Foi exatamente esse o defeito: com o VS Code fechado, `code <pasta>` saía com 0,
 * sem janela e sem erro — o CLI bifurca o Electron e volta na hora, e o filho
 * morria sem display, invisível.
 */
export function graphicalEnv(deps: { run?: () => string; platform?: NodeJS.Platform } = {}): Record<string, string> {
  if ((deps.platform ?? process.platform) !== 'linux') return {}
  const run = deps.run ?? (() =>
    execFileSync('systemctl', ['--user', 'show-environment'], { encoding: 'utf8', timeout: 2000 }))
  try {
    const out: Record<string, string> = {}
    for (const linha of run().split('\n')) {
      const at = linha.indexOf('=')
      if (at <= 0) continue
      const chave = linha.slice(0, at)
      if ((GRAPHICAL as readonly string[]).includes(chave)) out[chave] = linha.slice(at + 1)
    }
    return out
  } catch {
    // Sem systemd, sem sessão, sem permissão: segue com o que já havia.
    return {}
  }
}

/**
 * O ambiente do serviço com o gráfico da sessão viva por cima.
 *
 * A sessão VENCE o valor herdado: um `DISPLAY` velho aponta para uma sessão morta,
 * e é justamente o que sobra quando alguém sai e entra de novo.
 */
export function withDisplay(
  env: NodeJS.ProcessEnv,
  deps: { run?: () => string; platform?: NodeJS.Platform } = {},
): NodeJS.ProcessEnv {
  const g = graphicalEnv(deps)
  return Object.keys(g).length ? { ...env, ...g } : env
}

export interface LocalAppsDeps {
  available?: (bin: string) => boolean
  platform?: NodeJS.Platform
  spawnFn?: typeof spawn
  /** Terminal escolhido nas configurações. Vazio = o padrão do sistema. */
  terminal?: string | null
  /** Injetável para o teste não depender do env do processo. */
  env?: NodeJS.ProcessEnv
  /** Injetável: de onde vêm DISPLAY/WAYLAND_DISPLAY/XAUTHORITY (ver graphicalEnv). */
  graphical?: () => Record<string, string>
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

  const base = desktopEnv(deps.env ?? process.env)
  const grafico = deps.graphical ? deps.graphical() : graphicalEnv({ platform })
  const ambiente = { ...base, ...grafico }

  // Sem servidor gráfico não há janela para abrir — e alguns programas MENTEM
  // sobre isso: o `code` sai com 0 e não abre nada. Dizer é melhor que repetir o
  // silêncio que gerou o relato.
  if (platform === 'linux' && !ambiente.DISPLAY && !ambiente.WAYLAND_DISPLAY) {
    throw new Error('o serviço não enxerga a sessão gráfica — rode: systemctl --user import-environment DISPLAY WAYLAND_DISPLAY XAUTHORITY && systemctl --user restart claudinei.service')
  }

  const child = (deps.spawnFn ?? spawn)(launcher.cmd, launcher.args, {
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    // Ambiente do SISTEMA (ver desktopEnv) com a tela da sessão VIVA por cima
    // (ver graphicalEnv) — montado acima, em `ambiente`.
    env: ambiente,
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

  // NÃO destruir o cano: o filho continua escrevendo nele, e a ponta fechada lhe
  // dá EPIPE. O VS Code fala muito no stderr (log de arranque inteiro) e morre
  // assim — foi o que fez "Abrir no VS Code" parar de abrir quando este trecho
  // ganhou a captura de erro. Consome e joga fora, sem referenciar o laço.
  child.stderr?.removeAllListeners('data')
  child.stderr?.resume()
  ;(child.stderr as unknown as { unref?: () => void })?.unref?.()
  child.unref?.()
  if (erro) throw new Error(`${launcher.cmd}: ${erro}`)
}
