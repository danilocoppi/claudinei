import { describe, it, expect } from 'vitest'
import { desktopEnv, ORIG_LD, availableTerminals, resolveLauncher, TERMINALS } from '../src/localApps.js'

/**
 * O defeito, visto rodando: clicar em "Abrir terminal" não fazia nada.
 *
 * O Claudinei roda com um `LD_LIBRARY_PATH` próprio — ele carrega um libstdc++
 * portátil para a transcrição de voz — e esse env é HERDADO por todo processo
 * filho. Só que o libstdc++ embarcado é mais VELHO que o do sistema, então um app
 * gráfico que precise de símbolo novo morre no arranque:
 *
 *   gnome-terminal: libstdc++.so.6: version `GLIBCXX_3.4.31' not found
 *                   (required by /lib/x86_64-linux-gnu/libvte-2.91.so.0)
 *
 * Como o spawn descarta a saída de erro, isso chegava ao usuário como silêncio.
 * Estes são apps do SISTEMA: têm que nascer no ambiente do sistema.
 */
describe('o ambiente de um app do desktop', () => {
  it('desfaz a injeção do Claudinei, devolvendo o valor original', () => {
    const out = desktopEnv({
      LD_LIBRARY_PATH: '/cache/claudinei/stdcxx:/cache/claudinei/sherpa:/opt/meu',
      [ORIG_LD]: '/opt/meu',
      HOME: '/home/x',
    })
    expect(out.LD_LIBRARY_PATH).toBe('/opt/meu')
    expect(out.HOME).toBe('/home/x')
  })

  /** Não havia valor antes: o certo é a variável não existir, não existir vazia. */
  it('sem valor original, a variável sai de cena', () => {
    const out = desktopEnv({ LD_LIBRARY_PATH: '/cache/claudinei/stdcxx:', [ORIG_LD]: '' })
    expect('LD_LIBRARY_PATH' in out).toBe(false)
  })

  /** O marcador não some do processo, mas não tem por que viajar para o filho. */
  it('o marcador não é repassado adiante', () => {
    expect(ORIG_LD in desktopEnv({ [ORIG_LD]: '/x', LD_LIBRARY_PATH: '/y' })).toBe(false)
  })

  /**
   * Sem marcador, nada foi injetado — rodando do fonte, por exemplo. Aí um
   * LD_LIBRARY_PATH que exista é do usuário, e apagá-lo seria quebrar o ambiente
   * dele para consertar um problema que não existe.
   */
  it('sem injeção, não mexe em nada', () => {
    const env = { LD_LIBRARY_PATH: '/opt/dele', HOME: '/home/x' }
    expect(desktopEnv(env)).toEqual(env)
  })
})

/**
 * "x-terminal-emulator" é a escolha certa em tese — é a alternativa que o próprio
 * sistema aponta — mas nesta máquina ela resolvia para o terminator, que não é o
 * terminal que o dono usa. Escolher deixa de ser adivinhação.
 */
describe('quais terminais existem nesta máquina', () => {
  const has = (...bins: string[]) => (bin: string) => bins.includes(bin)

  it('lista todos os instalados, não só o primeiro', () => {
    const out = availableTerminals({ platform: 'linux', available: has('gnome-terminal', 'kitty', 'xterm') })
    expect(out.map((t) => t.id)).toEqual(['gnome-terminal', 'kitty', 'xterm'])
  })

  it('cada um se apresenta com nome de gente', () => {
    const [t] = availableTerminals({ platform: 'linux', available: has('gnome-terminal') })
    expect(t.label).toBe('GNOME Terminal')
  })

  it('nenhum instalado é lista vazia, não erro', () => {
    expect(availableTerminals({ platform: 'linux', available: () => false })).toEqual([])
  })

  it('todo candidato de terminal tem rótulo (senão a lista mostra o binário cru)', () => {
    for (const t of TERMINALS) expect(t.label, t.id).toBeTruthy()
  })
})

describe('o terminal escolhido', () => {
  const has = (...bins: string[]) => (bin: string) => bins.includes(bin)

  it('a escolha vence a ordem de preferência', () => {
    const deps = { platform: 'linux' as const, available: has('x-terminal-emulator', 'kitty') }
    expect(resolveLauncher('terminal', '/p', deps)?.cmd).toBe('x-terminal-emulator')
    expect(resolveLauncher('terminal', '/p', { ...deps, terminal: 'kitty' })?.cmd).toBe('kitty')
  })

  /** Escolha que sumiu da máquina não pode deixar o botão morto. */
  it('escolha desinstalada cai na ordem de sempre', () => {
    const deps = { platform: 'linux' as const, available: has('gnome-terminal'), terminal: 'kitty' }
    expect(resolveLauncher('terminal', '/p', deps)?.cmd).toBe('gnome-terminal')
  })

  /** A escolha é uma CHAVE de lista fechada, como a ação — nunca um comando. */
  it('escolha que não é um terminal conhecido é ignorada', () => {
    const deps = { platform: 'linux' as const, available: () => true, terminal: 'rm -rf /' }
    expect(resolveLauncher('terminal', '/p', deps)?.cmd).toBe('x-terminal-emulator')
  })

  it('a escolha não vaza para as outras ações', () => {
    const deps = { platform: 'linux' as const, available: () => true, terminal: 'kitty' }
    expect(resolveLauncher('folder', '/p', deps)?.cmd).toBe('nautilus')
  })
})

/**
 * O defeito relatado: "Abrir pasta" abria o Android Studio.
 *
 * Não era o comando errado — era o comando CERTO obedecendo o sistema. O item
 * rodava `xdg-open`, que abre o diretório com quem estiver registrado para
 * `inode/directory`; e o Android Studio se registra ali na instalação (a máquina
 * do relato respondia `com.google.AndroidStudio.desktop`).
 *
 * Mas o item se chama "Abrir pasta" e fica ao lado de "Abrir no VS Code": ele
 * promete o navegador de ARQUIVOS. Delegar essa escolha transformava o rótulo em
 * mentira quando qualquer IDE reivindicasse a associação.
 */
describe('abrir pasta abre o gerenciador de arquivos', () => {
  const has = (...bins: string[]) => (bin: string) => bins.includes(bin)
  const cmd = (available: (b: string) => boolean) =>
    resolveLauncher('folder', '/p', { platform: 'linux', available })?.cmd

  it('prefere um gerenciador de arquivos de verdade ao xdg-open', () => {
    expect(cmd(has('xdg-open', 'nautilus'))).toBe('nautilus')
    expect(cmd(has('xdg-open', 'dolphin'))).toBe('dolphin')
    expect(cmd(has('xdg-open', 'thunar'))).toBe('thunar')
  })

  /** Sem nenhum instalado, o xdg-open ainda é melhor que não abrir nada. */
  it('sem gerenciador, cai no xdg-open', () => {
    expect(cmd(has('xdg-open'))).toBe('xdg-open')
  })

  it('nada instalado é nada aberto', () => {
    expect(cmd(() => false)).toBeUndefined()
  })

  /** No mac e no Windows o comando já SIGNIFICA o gerenciador — não há o que trocar. */
  it('mac e Windows seguem como estavam', () => {
    expect(resolveLauncher('folder', '/p', { platform: 'darwin', available: () => true })?.cmd).toBe('open')
    expect(resolveLauncher('folder', 'C:\\p', { platform: 'win32', available: () => true })?.cmd).toBe('explorer')
  })
})
