import { describe, it, expect, vi } from 'vitest'
import {
  desktopEnv, graphicalEnv, launchApp, withDisplay,
  ORIG_LD, availableTerminals, resolveLauncher, TERMINALS,
} from '../src/localApps.js'

/** Um filho de mentira que nunca morre: o `launchApp` espera pelo arranque. */
const fakeChild = () => ({
  unref: () => {}, once: () => {},
  stderr: { on: () => {}, removeAllListeners: () => {}, resume: () => {}, unref: () => {} },
})

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

/**
 * O defeito relatado: "Abrir no VS Code" não faz nada.
 *
 * Medido: com o VS Code FECHADO e o ambiente do serviço, `code /tmp` sai com 0,
 * sem saída e sem janela. O serviço não tem `DISPLAY` — ele nasceu antes de a
 * sessão gráfica exportar as variáveis, e o usuário ainda trocou de sessão (X11
 * para Wayland) no meio do caminho. O CLI do VS Code bifurca o Electron e volta
 * 0 na hora; o filho morre sem display, e essa morte é invisível para nós.
 *
 * Com o VS Code ABERTO funcionava — o comando só conversava com a instância viva
 * por IPC, sem precisar de display. Foi por isso que passou por bom no primeiro
 * exame.
 *
 * Quem sabe onde está a sessão é o gerenciador do systemd, e ele sabe AGORA:
 * é dele que as variáveis têm que vir, não do env congelado no arranque.
 */
describe('o ambiente gráfico vem da sessão viva', () => {
  const systemctlDizendo = (saida: string) => () => saida

  it('lê DISPLAY, WAYLAND_DISPLAY e XAUTHORITY do gerenciador', () => {
    const g = graphicalEnv({ run: systemctlDizendo(
      'DISPLAY=:0\nWAYLAND_DISPLAY=wayland-0\nXAUTHORITY=/run/user/1000/.mutter-Xwaylandauth.3W35U3\nLANG=pt_BR.UTF-8\n',
    ) })
    expect(g).toEqual({
      DISPLAY: ':0',
      WAYLAND_DISPLAY: 'wayland-0',
      XAUTHORITY: '/run/user/1000/.mutter-Xwaylandauth.3W35U3',
    })
  })

  /** Só as três: o resto do ambiente do serviço é dele, e não se mistura. */
  it('não traz de carona o resto do ambiente', () => {
    const g = graphicalEnv({ run: systemctlDizendo('PATH=/roubado\nDISPLAY=:0\nHOME=/outro\n') })
    expect(Object.keys(g)).toEqual(['DISPLAY'])
  })

  /**
   * A sessão VENCE o que o serviço herdou: um `DISPLAY` velho aponta para uma
   * sessão que já morreu, e é justamente esse o caso quando alguém sai e volta.
   */
  it('a sessão viva vence o valor congelado no arranque', () => {
    const out = withDisplay({ DISPLAY: ':1', HOME: '/home/x' }, { run: systemctlDizendo('DISPLAY=:0\n') })
    expect(out.DISPLAY).toBe(':0')
    expect(out.HOME).toBe('/home/x')
  })

  it('sem resposta do systemd, não inventa nada', () => {
    const env = { HOME: '/home/x' }
    expect(withDisplay(env, { run: () => { throw new Error('sem systemctl') } })).toEqual(env)
    expect(withDisplay(env, { run: () => '' })).toEqual(env)
  })

  it('fora do Linux não mexe em nada', () => {
    const env = { HOME: '/Users/x' }
    expect(withDisplay(env, { platform: 'darwin', run: systemctlDizendo('DISPLAY=:0\n') })).toEqual(env)
  })
})

/**
 * Sem servidor gráfico, abrir um app de janela é impossível — e o `code` mente:
 * sai com 0 e não abre nada. Dizer isso é melhor que repetir o silêncio que
 * gerou o relato.
 */
describe('sem display, avisa em vez de fingir', () => {
  it('recusa e explica', async () => {
    await expect(launchApp('vscode', '/p', {
      platform: 'linux', available: () => true, spawnFn: (() => fakeChild()) as never,
      env: { HOME: '/home/x' }, graphical: () => ({}),
    })).rejects.toThrow(/gráfic/i)
  })

  it('com display, segue normalmente', async () => {
    const spawnFn = (() => fakeChild()) as never
    await expect(launchApp('vscode', '/p', {
      platform: 'linux', available: () => true, spawnFn,
      env: { HOME: '/home/x' }, graphical: () => ({ DISPLAY: ':0' }),
    })).resolves.toBeUndefined()
  })

  /** Wayland puro também é sessão gráfica: não se exige X. */
  it('só WAYLAND_DISPLAY basta', async () => {
    await expect(launchApp('folder', '/p', {
      platform: 'linux', available: () => true, spawnFn: (() => fakeChild()) as never,
      env: {}, graphical: () => ({ WAYLAND_DISPLAY: 'wayland-0' }),
    })).resolves.toBeUndefined()
  })
})

/**
 * O defeito relatado: "Abrir no VS Code" parou de abrir.
 *
 * Foi a captura de erro deste mesmo arquivo que o quebrou. Medido: `code <pasta>`
 * com o stdout num CANO sai com 0 e não abre janela; com o stdout descartado,
 * abre — o CLI do VS Code decide o que fazer olhando para onde a saída vai.
 *
 * O stderr continua no cano, e é de propósito: é dele que veio a mensagem que
 * explicou o "Abrir terminal" (o GLIBCXX do libstdc++). Perder isso seria trocar
 * um silêncio por outro.
 */
describe('o cano do stdout mata quem se importa com ele', () => {
  it('lança com stdout descartado e stderr capturado', async () => {
    const spawnFn = vi.fn(() => fakeChild()) as never
    await launchApp('vscode', '/p', {
      platform: 'linux', available: () => true, spawnFn,
      env: {}, graphical: () => ({ DISPLAY: ':0' }),
    })
    const opcoes = (spawnFn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][2] as { stdio: string[] }
    expect(opcoes.stdio, 'stdout no cano faz o VS Code não abrir').toEqual(['ignore', 'ignore', 'pipe'])
  })

  /**
   * Montar o ambiente certo e mandar OUTRO para o spawn foi exatamente o erro que
   * eu cometi consertando isto: o guard de "sem sessão gráfica" passava (ele olha
   * o ambiente montado) e o filho nascia cego mesmo assim.
   */
  it('o ambiente que chega ao filho é o que tem a sessão gráfica', async () => {
    const spawnFn = vi.fn(() => fakeChild()) as never
    await launchApp('vscode', '/p', {
      platform: 'linux', available: () => true, spawnFn,
      env: { HOME: '/home/x' }, graphical: () => ({ DISPLAY: ':0', XAUTHORITY: '/run/user/1000/.Xauth' }),
    })
    const opcoes = (spawnFn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][2] as { env: Record<string, string> }
    expect(opcoes.env).toMatchObject({ HOME: '/home/x', DISPLAY: ':0', XAUTHORITY: '/run/user/1000/.Xauth' })
  })
})
