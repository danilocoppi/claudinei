import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { useStore } from '../store'
import { dentroDaTela, JANELA, readRun, RUN_KEY } from '../actionRun'
import { TerminalMenu } from '../components/TerminalMenu'
import { ActionEditor } from '../components/ActionEditor'
import { ActionRunModal } from '../components/ActionRunModal'
import type { Project } from '../types'

vi.mock('../api', async () => {
  const real = await vi.importActual<typeof import('../api')>('../api')
  return {
    ...real,
    fetchLocalApps: vi.fn(async () => ({ folder: true, vscode: false, terminal: false, local: true })),
    fetchActions: vi.fn(async () => [
      { id: 7, projectId: 1, name: 'Deploy', commands: ['awsVAEXA', 'npm run deploy'], autoClose: false, running: false },
      { id: 8, projectId: 1, name: 'Seed', commands: ['npm run seed'], autoClose: true, running: true },
    ]),
    createAction: vi.fn(async (projectId: number, input: object) => ({ id: 9, projectId, ...input })),
    updateAction: vi.fn(async (id: number, input: object) => ({ id, projectId: 1, ...input })),
    deleteAction: vi.fn(async () => undefined),
    stopAction: vi.fn(async () => undefined),
    runAction: vi.fn(async () => ({ token: 't', wsUrl: '/ws/terminal/act-7', reattached: false })),
    createSector: vi.fn(async (name: string) => ({ id: 42, name })),
    setProjectSector: vi.fn(async () => undefined),
    fetchGroups: vi.fn(async () => []),
    fetchSectors: vi.fn(async () => []),
    fetchProjects: vi.fn(async () => []),
  }
})

const api = await import('../api')

const project: Project = { id: 1, name: 'Alvo', path: '/tmp/alvo' } as Project

beforeEach(() => {
  useStore.setState({ groups: [], sectors: [], actionRun: null })
})
afterEach(() => { vi.clearAllMocks() })

const abreMenu = async () => {
  render(<TerminalMenu project={project} x={0} y={0} onDone={() => {}} />)
  await screen.findByTestId('action-7')
}

/**
 * As ações estão no menu ⋮ do terminal porque pertencem a ELE: os comandos
 * dependem da pasta em que rodam, e a mesma ação em dois projetos é cadastro em
 * dois lugares — de propósito.
 */
describe('seção de ações no menu do terminal', () => {
  it('lista as ações do terminal com um + para criar', async () => {
    await abreMenu()
    expect(screen.getByText('Deploy')).toBeTruthy()
    expect(screen.getByText('Seed')).toBeTruthy()
    expect(screen.getByTestId('action-new')).toBeTruthy()
  })

  /** Pela rede, o botão abriria um shell na máquina de outra pessoa. */
  it('não aparece fora da máquina do servidor', async () => {
    vi.mocked(api.fetchLocalApps).mockResolvedValueOnce({
      folder: false, vscode: false, terminal: false, local: false,
    })
    render(<TerminalMenu project={project} x={0} y={0} onDone={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Copiar caminho')).toBeTruthy())
    expect(screen.queryByTestId('action-new')).toBeNull()
    expect(api.fetchActions).not.toHaveBeenCalled()
  })

  /**
   * Clicar fecha o menu e abre a caixinha PELO STORE. Se a caixinha morasse no
   * menu, fechar o menu mataria o deploy junto.
   */
  it('clicar na ação fecha o menu e registra a execução no store', async () => {
    const onDone = vi.fn()
    render(<TerminalMenu project={project} x={0} y={0} onDone={onDone} />)
    fireEvent.click(await screen.findByTestId('action-7'))
    expect(onDone).toHaveBeenCalled()
    expect(useStore.getState().actionRun).toEqual({ actionId: 7, name: 'Deploy', autoClose: false })
  })

  it('o botão de excluir não dispara a ação', async () => {
    await abreMenu()
    const linha = screen.getByTestId('action-7')
    fireEvent.click(linha.querySelector('.sess-pop__act-btn--danger')!)
    await waitFor(() => expect(api.deleteAction).toHaveBeenCalledWith(7))
    expect(useStore.getState().actionRun).toBeNull()
    await waitFor(() => expect(screen.queryByText('Deploy')).toBeNull())
  })

  it('mostra que uma ação já está rodando', async () => {
    await abreMenu()
    expect(screen.getByTestId('action-8').querySelector('.sess-pop__act-live')).toBeTruthy()
    expect(screen.getByTestId('action-7').querySelector('.sess-pop__act-live')).toBeNull()
  })
})

describe('cadastro de ação', () => {
  const preenche = (nome: string, comandos: string) => {
    fireEvent.change(screen.getByPlaceholderText('ex.: Deploy'), { target: { value: nome } })
    fireEvent.change(screen.getByPlaceholderText(/awsVAEXA/), { target: { value: comandos } })
  }

  it('salva os comandos como uma lista, um por linha', async () => {
    const onSaved = vi.fn()
    render(<ActionEditor projectId={1} onSaved={onSaved} onClose={() => {}} />)
    preenche('Deploy', 'awsVAEXA\nnpm run deploy')
    fireEvent.click(screen.getByText('Salvar'))
    await waitFor(() => expect(api.createAction).toHaveBeenCalledWith(1, {
      name: 'Deploy', commands: ['awsVAEXA', 'npm run deploy'], autoClose: false,
    }))
    expect(onSaved).toHaveBeenCalled()
  })

  /** Linha em branco no meio é descuido de digitação, não comando. */
  it('descarta linhas vazias', async () => {
    render(<ActionEditor projectId={1} onSaved={() => {}} onClose={() => {}} />)
    preenche('Deploy', 'a\n\n  \nb\n')
    fireEvent.click(screen.getByText('Salvar'))
    await waitFor(() => expect(api.createAction).toHaveBeenCalledWith(1, expect.objectContaining({
      commands: ['a', 'b'],
    })))
  })

  it('sem nome ou sem comando não dá para salvar', () => {
    render(<ActionEditor projectId={1} onSaved={() => {}} onClose={() => {}} />)
    const salvar = screen.getByText('Salvar') as HTMLButtonElement
    expect(salvar.disabled).toBe(true)
    preenche('Deploy', '')
    expect(salvar.disabled).toBe(true)
    preenche('Deploy', 'ls')
    expect(salvar.disabled).toBe(false)
  })

  /** Fechar sozinho é o padrão DESLIGADO: quem roda um deploy quer ler o fim dele. */
  it('fechar ao terminar vem desligado e é escolha de quem cadastra', async () => {
    render(<ActionEditor projectId={1} onSaved={() => {}} onClose={() => {}} />)
    const check = screen.getByRole('checkbox') as HTMLInputElement
    expect(check.checked).toBe(false)
    fireEvent.click(check)
    preenche('Seed', 'npm run seed')
    fireEvent.click(screen.getByText('Salvar'))
    await waitFor(() => expect(api.createAction).toHaveBeenCalledWith(1, expect.objectContaining({ autoClose: true })))
  })

  it('editando, parte do que já estava lá e faz PATCH', async () => {
    const acao = { id: 7, projectId: 1, name: 'Deploy', commands: ['a', 'b'], autoClose: true }
    render(<ActionEditor projectId={1} action={acao} onSaved={() => {}} onClose={() => {}} />)
    expect((screen.getByPlaceholderText('ex.: Deploy') as HTMLInputElement).value).toBe('Deploy')
    expect((screen.getByPlaceholderText(/awsVAEXA/) as HTMLTextAreaElement).value).toBe('a\nb')
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true)
    fireEvent.click(screen.getByText('Salvar'))
    await waitFor(() => expect(api.updateAction).toHaveBeenCalledWith(7, expect.objectContaining({ name: 'Deploy' })))
  })

  /** O erro do servidor aparece: um formulário que fecha sem salvar é pior. */
  it('mostra o erro em vez de fechar', async () => {
    vi.mocked(api.createAction).mockRejectedValueOnce(new Error('a ação precisa de um nome'))
    const onSaved = vi.fn()
    render(<ActionEditor projectId={1} onSaved={onSaved} onClose={() => {}} />)
    preenche('  x  ', 'ls')
    fireEvent.click(screen.getByText('Salvar'))
    await waitFor(() => expect(screen.getByText('a ação precisa de um nome')).toBeTruthy())
    expect(onSaved).not.toHaveBeenCalled()
  })
})

/**
 * O fim do processo chega pelo broadcast, e não pelo socket do PTY: o gerenciador
 * não fecha os clientes ao encerrar (ele ainda tem buffer para entregar), então
 * esperar o `onclose` deixaria a caixinha pulsando "rodando" para sempre.
 */
describe('fim da execução', () => {
  const rodando = (autoClose: boolean) =>
    useStore.setState({ actionRun: { actionId: 7, name: 'Deploy', autoClose } })

  it('com fechar-ao-terminar, some sozinha', () => {
    rodando(true)
    useStore.getState().applyWsMessage({ type: 'action_exit', actionId: 7 })
    expect(useStore.getState().actionRun).toBeNull()
  })

  it('sem fechar-ao-terminar, fica aberta e marcada como terminada', () => {
    rodando(false)
    useStore.getState().applyWsMessage({ type: 'action_exit', actionId: 7 })
    expect(useStore.getState().actionRun).toMatchObject({ actionId: 7, exited: true })
  })

  it('o fim de OUTRA ação não mexe na que está aberta', () => {
    rodando(true)
    useStore.getState().applyWsMessage({ type: 'action_exit', actionId: 99 })
    expect(useStore.getState().actionRun).toMatchObject({ actionId: 7 })
  })
})

describe('CSS das ações', () => {
  // fileURLToPath direto: o jsdom troca o construtor global de URL.
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'styles.css'), 'utf8')

  /** Editar/excluir só no hover: o clique que se quer na lista é o de RODAR. */
  it('os botões de editar e excluir nascem escondidos e aparecem no hover', () => {
    expect(css).toMatch(/\.sess-pop__act-btn\s*\{[^}]*opacity:\s*0/)
    expect(css).toMatch(/\.sess-pop__item--act:hover \.sess-pop__act-btn\s*\{[^}]*opacity:\s*1/)
  })

  /**
   * JANELA, não modal. O véu que come cliques era o defeito: como fechar é
   * PARAR, um clique distraído no fundo matava o deploy sem avisar.
   */
  it('não existe véu de overlay cobrindo a página', () => {
    expect(css, 'o véu voltou — clicar fora volta a matar o processo').not.toContain('.actrun__overlay')
    expect(css).toMatch(/\.actrun\s*\{[^}]*position:\s*fixed/)
  })

  /** A barra inteira é a alça, e o desenho tem que dizer isso antes do arrasto. */
  it('a barra de título se apresenta como alça', () => {
    expect(css).toMatch(/\.actrun__bar\s*\{[^}]*cursor:\s*move/)
    expect(css).toMatch(/\.actrun__bar\s*\{[^}]*user-select:\s*none/)
  })

  /** Encolhida, o processo continua TENDO um lugar na tela. */
  it('a pílula fica num canto fixo, por cima de tudo', () => {
    expect(css).toMatch(/\.actrun-pill\s*\{[^}]*position:\s*fixed/)
    expect(css).toMatch(/\.actrun-pill\s*\{[^}]*z-index/)
  })

  it('o ponto de "rodando" pulsa e o de "terminou" para', () => {
    expect(css).toMatch(/\.actrun__dot\s*\{[^}]*animation:\s*act-pulse/)
    expect(css).toMatch(/\.actrun__dot--done\s*\{[^}]*animation:\s*none/)
  })
})

/**
 * Sobreviver ao F5 é o que impede o terminal órfão: sem isso, recarregar a página
 * no meio de um deploy deixava o processo de pé no servidor sem nada na tela que
 * o mostrasse ou o parasse.
 */
describe('a janelinha atravessa o recarregamento', () => {
  beforeEach(() => localStorage.clear())

  it('abrir grava qual ação está aberta; fechar apaga', () => {
    useStore.getState().openActionRun({ actionId: 7, name: 'Deploy', autoClose: false })
    expect(readRun()).toMatchObject({ actionId: 7, name: 'Deploy', autoClose: false })
    useStore.getState().closeActionRun()
    expect(readRun()).toBeNull()
  })

  /** Terminou: sai do registro mesmo ficando na tela. Um F5 aqui não deve
   *  reabrir a janela de um processo que já não existe. */
  it('o fim da execução tira do registro, mesmo com a janela aberta', () => {
    useStore.getState().openActionRun({ actionId: 7, name: 'Deploy', autoClose: false })
    useStore.getState().applyWsMessage({ type: 'action_exit', actionId: 7 })
    expect(useStore.getState().actionRun).toMatchObject({ exited: true })
    expect(readRun()).toBeNull()
  })

  it('lixo gravado não vira requisição a /api/actions/undefined', () => {
    localStorage.setItem(RUN_KEY, '{"name":"Deploy"}')
    expect(readRun()).toBeNull()
    localStorage.setItem(RUN_KEY, 'não é json')
    expect(readRun()).toBeNull()
  })
})

/**
 * A janela deixou de ser modal, e cada teste aqui trava um sintoma relatado:
 * "clicando fora, o terminal some e não sei onde vê-los".
 *
 * Era pior do que sumir: o clique no véu chamava o mesmo caminho do ✕, que MATA
 * o processo. Um clique distraído no fundo derrubava o deploy sem avisar.
 */
describe('a janela flutuante', () => {
  const abre = (extra: object = {}) => {
    useStore.setState({
      actionRun: { actionId: 7, name: 'Deploy', autoClose: false, ...extra },
    })
    render(<ActionRunModal />)
  }

  it('clicar fora não fecha nem para nada', () => {
    abre()
    fireEvent.click(document.body)
    expect(useStore.getState().actionRun, 'clicar fora derrubou o processo').not.toBeNull()
    expect(api.stopAction).not.toHaveBeenCalled()
  })

  /** Encolher é sair da frente, não parar: o processo segue e a pílula o mostra. */
  it('minimizar guarda na pílula sem tocar no processo', () => {
    abre()
    fireEvent.click(screen.getByTestId('action-run-min'))
    expect(api.stopAction).not.toHaveBeenCalled()
    expect(screen.queryByTestId('action-run')).toBeNull()
    const pilula = screen.getByTestId('action-run-pill')
    expect(pilula.textContent).toContain('Deploy')

    fireEvent.click(pilula)
    expect(screen.getByTestId('action-run')).toBeTruthy()
  })

  /** E atravessa o F5 encolhida: quem minimizou não quer a janela de volta. */
  it('o estado encolhido fica gravado', () => {
    localStorage.clear()
    useStore.getState().openActionRun({ actionId: 7, name: 'Deploy', autoClose: false })
    useStore.getState().setActionRunMinimized(true)
    expect(readRun()?.minimized).toBe(true)
  })

  /** Parar não tem desfazer — mas só enquanto há o que parar. */
  it('o ✕ pergunta com o processo de pé e fecha direto depois do fim', () => {
    abre()
    fireEvent.click(screen.getByTestId('action-run-close'))
    expect(screen.getByTestId('action-run-ask')).toBeTruthy()
    expect(api.stopAction).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('Parar'))
    expect(api.stopAction).toHaveBeenCalledWith(7)
    expect(useStore.getState().actionRun).toBeNull()
  })

  it('terminada, o ✕ não pergunta nada', () => {
    abre({ exited: true })
    fireEvent.click(screen.getByTestId('action-run-close'))
    expect(screen.queryByTestId('action-run-ask')).toBeNull()
    expect(useStore.getState().actionRun).toBeNull()
  })

  it('a posição arrastada fica gravada para o F5 reencontrar', () => {
    localStorage.clear()
    useStore.getState().openActionRun({ actionId: 7, name: 'Deploy', autoClose: false })
    useStore.getState().moveActionRun(300, 120)
    expect(readRun()).toMatchObject({ x: 300, y: 120 })
  })
})

/**
 * Não há campo de digitação, e isso é a decisão — não a falta dela.
 *
 * O terminal É o campo: cada tecla vai direto para o PTY (medido: um `read -p`
 * recebeu a resposta digitada com o campo ausente). Um `<input>` no rodapé
 * perderia justamente o que faz dele um terminal — Ctrl-C, setas,
 * tab-completion, histórico do shell.
 */
describe('digitar no terminal', () => {
  const abre = (extra: object = {}) => {
    useStore.setState({ actionRun: { actionId: 7, name: 'Deploy', autoClose: false, ...extra } })
    render(<ActionRunModal />)
  }

  it('não há campo separado — o terminal recebe a digitação', () => {
    abre()
    expect(screen.queryByTestId('action-run-input')).toBeNull()
    // o xterm monta sua própria área de digitação dentro da tela
    expect(screen.getByTestId('action-run').querySelector('.actrun__screen textarea')).toBeTruthy()
  })
})

/**
 * A posição foi gravada numa tela que pode não ser esta. Sem trazer de volta,
 * quem arrastou para a direita num monitor grande e abriu no notebook acharia a
 * janela fora da área visível — sem barra de título, perdida de vez.
 */
describe('a janela não se perde fora da tela', () => {
  const tela = { w: 1000, h: 800 }

  it('segura uma faixa alcançável em qualquer borda', () => {
    expect(dentroDaTela(5000, 400, tela).x).toBeLessThanOrEqual(tela.w - 120)
    expect(dentroDaTela(-5000, 400, tela).x).toBeGreaterThanOrEqual(-(JANELA.largura - 120))
    expect(dentroDaTela(400, -300, tela).y).toBe(0)
    expect(dentroDaTela(400, 5000, tela).y).toBeLessThanOrEqual(tela.h - 40)
  })

  it('posição boa passa intacta', () => {
    expect(dentroDaTela(200, 150, tela)).toEqual({ x: 200, y: 150 })
  })

  it('e a posição lida do armazenamento já vem corrigida', () => {
    localStorage.setItem(RUN_KEY, JSON.stringify({
      actionId: 7, name: 'Deploy', autoClose: false, x: 99999, y: 99999,
    }))
    const r = readRun()!
    expect(r.x).toBeLessThan(99999)
    expect(r.y).toBeLessThan(99999)
  })
})

/**
 * O que é gravado descreve a JANELA, não a execução.
 *
 * `attachOnly` é a resposta de uma pergunta que a próxima sessão ainda vai fazer
 * ao servidor ("isto ainda está de pé?"). Gravá-la seria deixar um estado velho
 * mandar num mundo novo.
 */
describe('o que vai para o armazenamento', () => {
  it('não leva o estado de execução junto', () => {
    localStorage.clear()
    useStore.setState({
      actionRun: {
        actionId: 7, name: 'Deploy', autoClose: false,
        attachOnly: true, exited: true,
      },
    })
    useStore.getState().moveActionRun(10, 20)
    const cru = JSON.parse(localStorage.getItem(RUN_KEY) ?? 'null')
    // terminada, nem grava — mas se um dia gravar, não pode ser com isto dentro
    if (cru) {
      expect(cru).not.toHaveProperty('attachOnly')
      expect(cru).not.toHaveProperty('exited')
    }
  })

  it('grava a pose completa de uma execução viva', () => {
    localStorage.clear()
    useStore.getState().openActionRun({
      actionId: 7, name: 'Deploy', autoClose: false, attachOnly: true,
    })
    useStore.getState().moveActionRun(10, 20)
    useStore.getState().setActionRunMinimized(true)
    const cru = JSON.parse(localStorage.getItem(RUN_KEY)!)
    expect(cru).toEqual({
      actionId: 7, name: 'Deploy', autoClose: false, minimized: true, x: 10, y: 20,
    })
    expect(cru).not.toHaveProperty('attachOnly')
  })
})

/**
 * Criar setor mudou de lugar: era um 🏢+ na barra de cima, longe do terminal que
 * ia para dentro dele. Agora fica junto de grupo, no ⋮ do terminal — onde já se
 * responde "onde este terminal fica".
 */
describe('criar setor pelo menu do terminal', () => {
  it('o campo aparece mesmo sem nenhum setor cadastrado', async () => {
    useStore.setState({ sectors: [] })
    await abreMenu()
    // sem isto, o único caminho para o PRIMEIRO setor teria sumido com o botão antigo
    expect(screen.getByTestId('menu-new-sector')).toBeTruthy()
    expect(screen.getByTestId('menu-sector')).toBeTruthy()
  })

  it('cria e já move o terminal para dentro dele', async () => {
    await abreMenu()
    fireEvent.change(screen.getByTestId('menu-new-sector'), { target: { value: 'Financeiro' } })
    fireEvent.keyDown(screen.getByTestId('menu-new-sector'), { key: 'Enter' })
    await waitFor(() => expect(api.createSector).toHaveBeenCalledWith('Financeiro'))
    await waitFor(() => expect(api.setProjectSector).toHaveBeenCalledWith(project.id, 42))
  })

  it('nome vazio não cria nada', async () => {
    await abreMenu()
    fireEvent.change(screen.getByTestId('menu-new-sector'), { target: { value: '   ' } })
    fireEvent.keyDown(screen.getByTestId('menu-new-sector'), { key: 'Enter' })
    expect(api.createSector).not.toHaveBeenCalled()
  })
})
