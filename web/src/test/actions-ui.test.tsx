import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { useStore } from '../store'
import { readRun, RUN_KEY } from '../actionRun'
import { TerminalMenu } from '../components/TerminalMenu'
import { ActionEditor } from '../components/ActionEditor'
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

  /** A caixinha não é modal de confirmação: não pode tapar a conversa. */
  it('a janelinha ancora num canto, não no centro', () => {
    expect(css).toMatch(/\.actrun__overlay\s*\{[^}]*align-items:\s*flex-end/)
    expect(css).toMatch(/\.actrun__overlay\s*\{[^}]*justify-content:\s*flex-end/)
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
    expect(readRun()).toEqual({ actionId: 7, name: 'Deploy', autoClose: false })
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
