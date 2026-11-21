import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { UndoDialog } from '../components/undo/UndoDialog'
import type { FileDiff, PreviewFile, UndoPreview, UndoRunDto } from '../../../shared/undo'

const pf = (path: string, over: Partial<PreviewFile> = {}): PreviewFile => ({
  path, class: 'own', verdict: 'revert', mergeable: false, overlapped: false, checked: true, ...over,
})
const preview = (over: Partial<UndoPreview> = {}): UndoPreview => ({
  token: 'tok1', turnIds: [7], blockedBy: null, branchChanged: null, files: [pf('src/a.ts')], notUndoable: [], hiddenOutside: 0, ...over,
})
const RUN: UndoRunDto = { id: 4, kind: 'undo', turnIds: [7], files: [{ path: 'src/a.ts', result: 'reverted' }], redone: false }

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

type Reply = unknown | ((body: any) => Response | unknown)
/** Respostas por prefixo de URL, uma por chamada quando é lista (a última se repete); o resto é 404. */
function rotas(map: Record<string, Reply | Reply[]>) {
  const count: Record<string, number> = {}
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input)
    const hit = Object.keys(map).find(k => url.startsWith(k))
    if (!hit) return json({ error: 'nada', code: 'x' }, 404)
    const list = Array.isArray(map[hit]) ? map[hit] as Reply[] : [map[hit]]
    const n = count[hit] = (count[hit] ?? 0) + 1
    const r = list[Math.min(n, list.length) - 1]
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    const out = typeof r === 'function' ? (r as (b: any) => unknown)(body) : r
    return out instanceof Response ? out : json(out)
  })
}
const calls = (spy: ReturnType<typeof rotas>, prefix: string) =>
  spy.mock.calls.filter(([u]) => String(u).startsWith(prefix)).map(([, init]) => (init?.body ? JSON.parse(String(init.body)) : undefined))

const confirmar = () => screen.getByRole('button', { name: 'Desfazer' }) as HTMLButtonElement

afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('UndoDialog', () => {
  it('bloqueado mostra a espera com o nome ou "outro terminal"', async () => {
    const spy = rotas({
      '/api/undo/preview': [
        preview({ blockedBy: { kind: 'working', terminal: 'Alfa · Codex' } }),
        preview({ blockedBy: { kind: 'in_terminal', terminal: null } }),
        preview(),
      ],
    })
    render(<UndoDialog request={{ turnIds: [7] }} onClose={() => {}} onDone={() => {}} />)
    expect(await screen.findByText('Esperando o turno de Alfa · Codex terminar')).toBeTruthy()
    expect(confirmar().disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }))
    expect(await screen.findByText('Esperando o turno de outro terminal terminar')).toBeTruthy()
    expect(confirmar().disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }))
    await waitFor(() => expect(confirmar().disabled).toBe(false))
    expect(screen.queryByText(/Esperando o turno/)).toBeNull()
    expect(calls(spy, '/api/undo/preview')).toEqual([{ turnIds: [7] }, { turnIds: [7] }, { turnIds: [7] }])
  })

  it('incerto nasce desmarcado e marcar manda revert', async () => {
    const DIFF: FileDiff = { path: 'talvez.ts', binary: false, truncated: false, text: '@@ -1 +1 @@\n-antes\n+linha do outro\n' }
    const spy = rotas({
      '/api/undo/preview': preview({
        files: [pf('meu.ts'), pf('talvez.ts', { class: 'uncertain', checked: false }), pf('outro.ts', { class: 'uncertain', checked: false })],
      }),
      '/api/undo/turns/7/diff': DIFF,
      '/api/undo/apply': RUN,
    })
    const onDone = vi.fn()
    render(<UndoDialog request={{ turnIds: [7] }} onClose={() => {}} onDone={onDone} />)
    const talvez = await screen.findByRole('checkbox', { name: 'talvez.ts' }) as HTMLInputElement
    expect(talvez.checked).toBe(false)
    expect((screen.getByRole('checkbox', { name: 'meu.ts' }) as HTMLInputElement).checked).toBe(true)
    expect(screen.getByText('Pode ser de outro terminal')).toBeTruthy()

    // "ver diff" busca o diff do arquivo no turno, só ao clicar.
    expect(spy.mock.calls.some(([u]) => String(u).includes('/diff'))).toBe(false)
    fireEvent.click(screen.getAllByRole('button', { name: 'ver diff' })[0])
    expect(await screen.findByText('linha do outro')).toBeTruthy()
    expect(spy.mock.calls.map(([u]) => String(u))).toContain('/api/undo/turns/7/diff?path=talvez.ts')

    fireEvent.click(talvez)
    fireEvent.click(confirmar())
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(RUN))
    expect(calls(spy, '/api/undo/apply')).toEqual([
      { turnIds: [7], token: 'tok1', decisions: { 'meu.ts': 'revert', 'talvez.ts': 'revert', 'outro.ts': 'keep' } },
    ])
  })

  it('conflitos um de cada vez; sem mergeable não há "só as linhas do turno"', async () => {
    rotas({
      '/api/undo/preview': preview({
        files: [
          pf('c1.ts', { verdict: 'conflict', mergeable: true, checked: false, sinceTurn: '@@ -1 +1 @@\n-do turno\n+mudou depois\n' }),
          pf('c2.ts', { verdict: 'conflict', mergeable: false, checked: false, overlapped: true }),
        ],
      }),
    })
    render(<UndoDialog request={{ turnIds: [7] }} onClose={() => {}} onDone={() => {}} />)
    expect(await screen.findByText('c1.ts')).toBeTruthy()
    expect(screen.getByText('mudou depois')).toBeTruthy()
    expect(screen.getByLabelText('desfazer só as linhas do turno')).toBeTruthy()
    expect(screen.getByLabelText('voltar ao antes mesmo assim (perde o que mudou depois)')).toBeTruthy()
    expect(screen.getByLabelText('manter como está')).toBeTruthy()
    // O segundo ainda não abriu.
    expect(screen.queryByText('c2.ts')).toBeNull()
    expect(screen.getByText('Mais 1 conflito depois deste')).toBeTruthy()

    fireEvent.click(screen.getByLabelText('manter como está'))
    expect(await screen.findByText('c2.ts')).toBeTruthy()
    // O primeiro continua com as escolhas (dá para trocar); o segundo, sem mergeable, só tem duas.
    expect(screen.getAllByLabelText('desfazer só as linhas do turno')).toHaveLength(1)
    expect(screen.getAllByLabelText('manter como está')).toHaveLength(2)
    expect(screen.getAllByLabelText('voltar ao antes mesmo assim (perde o que mudou depois)')).toHaveLength(2)
    expect(screen.queryByText(/Mais \d+ conflito/)).toBeNull()
  })

  it('confirmar só liga com todos os conflitos escolhidos', async () => {
    const spy = rotas({
      '/api/undo/preview': preview({
        files: [
          pf('a.ts'),
          pf('c1.ts', { verdict: 'conflict', mergeable: true, checked: false }),
          pf('c2.ts', { verdict: 'conflict', mergeable: false, checked: false }),
        ],
      }),
      '/api/undo/apply': RUN,
    })
    const onDone = vi.fn()
    render(<UndoDialog request={{ turnIds: [7] }} onClose={() => {}} onDone={onDone} />)
    await screen.findByText('c1.ts')
    expect(confirmar().disabled).toBe(true)
    fireEvent.click(screen.getByLabelText('desfazer só as linhas do turno'))
    expect(confirmar().disabled).toBe(true)
    const force = await screen.findAllByLabelText('voltar ao antes mesmo assim (perde o que mudou depois)')
    fireEvent.click(force[1])
    expect(confirmar().disabled).toBe(false)
    fireEvent.click(confirmar())
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(RUN))
    expect(calls(spy, '/api/undo/apply')[0].decisions).toEqual({ 'a.ts': 'revert', 'c1.ts': 'merge', 'c2.ts': 'force' })
  })

  it('409 troca a prévia e avisa', async () => {
    const nova = preview({ token: 'tok2', files: [pf('a.ts'), pf('novo.ts', { verdict: 'conflict', checked: false })] })
    const spy = rotas({
      '/api/undo/preview': preview({ files: [pf('a.ts')] }),
      '/api/undo/apply': [
        () => json({ error: 'mudou', code: 'undo_changed', preview: nova }, 409),
        RUN,
      ],
    })
    const onDone = vi.fn()
    render(<UndoDialog request={{ turnIds: [7] }} onClose={() => {}} onDone={onDone} />)
    await screen.findByText('a.ts')
    fireEvent.click(confirmar())
    expect(await screen.findByText('Os arquivos mudaram desde que você abriu esta tela')).toBeTruthy()
    expect(screen.getByText('novo.ts')).toBeTruthy()
    expect(onDone).not.toHaveBeenCalled()
    // A prévia nova pede a escolha do conflito novo antes de confirmar, e vai com o token novo.
    expect(confirmar().disabled).toBe(true)
    fireEvent.click(screen.getByLabelText('manter como está'))
    fireEvent.click(confirmar())
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(RUN))
    expect(calls(spy, '/api/undo/apply')[1]).toEqual({ turnIds: [7], token: 'tok2', decisions: { 'a.ts': 'revert', 'novo.ts': 'keep' } })
  })

  it('branch mudou aparece no topo', async () => {
    rotas({ '/api/undo/preview': preview({ branchChanged: { from: 'main', to: 'feature/x' } }) })
    render(<UndoDialog request={{ turnIds: [7] }} onClose={() => {}} onDone={() => {}} />)
    const aviso = await screen.findByText('O branch mudou desde o turno (era main, agora feature/x)')
    const corpo = aviso.closest('.undo-dialog__body')!
    expect(corpo.firstElementChild).toBe(aviso)
  })

  it('refazer usa o mesmo diálogo com redoRunId', async () => {
    const REDO: UndoRunDto = { ...RUN, id: 5, kind: 'redo' }
    const spy = rotas({
      '/api/undo/runs/4/redo/preview': preview({ token: 'r1', turnIds: [7] }),
      '/api/undo/runs/4/redo': REDO,
    })
    const onDone = vi.fn()
    render(<UndoDialog request={{ redoRunId: 4 }} onClose={() => {}} onDone={onDone} />)
    expect(await screen.findByRole('dialog', { name: 'Refazer as mudanças nos arquivos' })).toBeTruthy()
    await screen.findByText('src/a.ts')
    fireEvent.click(screen.getByRole('button', { name: 'Refazer' }))
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(REDO))
    const urls = spy.mock.calls.map(([u, init]) => `${init?.method ?? 'GET'} ${String(u)}`)
    expect(urls).toEqual(['POST /api/undo/runs/4/redo/preview', 'POST /api/undo/runs/4/redo'])
    expect(calls(spy, '/api/undo/runs/4/redo')[1]).toEqual({ token: 'r1', decisions: { 'src/a.ts': 'revert' } })
  })

  it('mostra os que não dá para desfazer e a contagem de fora do projeto', async () => {
    rotas({
      '/api/undo/preview': preview({
        notUndoable: [{ path: 'big.bin', status: 'too_big', added: 0, removed: 0, binary: true, size: 9e6 }],
        hiddenOutside: 3,
      }),
    })
    render(<UndoDialog request={{ turnIds: [7] }} onClose={() => {}} onDone={() => {}} />)
    expect(await screen.findByText('Não dá para desfazer')).toBeTruthy()
    expect(screen.getByText('big.bin')).toBeTruthy()
    expect(screen.queryByRole('checkbox', { name: 'big.bin' })).toBeNull()
    expect(screen.getByText('3 arquivos fora deste projeto')).toBeTruthy()
  })

  it('arquivo que falhou na escrita aparece antes de fechar; fechar avisa o fim', async () => {
    const MEIO: UndoRunDto = { ...RUN, files: [{ path: 'src/a.ts', result: 'failed', error: 'EACCES' }] }
    rotas({ '/api/undo/preview': preview(), '/api/undo/apply': MEIO })
    const onDone = vi.fn()
    const onClose = vi.fn()
    render(<UndoDialog request={{ turnIds: [7] }} onClose={onClose} onDone={onDone} />)
    await screen.findByText('src/a.ts')
    fireEvent.click(confirmar())
    expect(await screen.findByText('falhou: EACCES')).toBeTruthy()
    expect(onDone).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onDone).toHaveBeenCalledWith(MEIO)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('modo de escolha devolve token e decisões sem rede', async () => {
    const spy = rotas({})
    const onSelect = vi.fn()
    const p = preview({ files: [pf('a.ts'), pf('b.ts', { class: 'uncertain', checked: false })] })
    render(<UndoDialog mode="select" preview={p} confirmLabel="Voltar e editar" onClose={() => {}} onSelect={onSelect} />)
    fireEvent.click(screen.getByRole('button', { name: 'Voltar e editar' }))
    expect(onSelect).toHaveBeenCalledWith({ token: 'tok1', decisions: { 'a.ts': 'revert', 'b.ts': 'keep' } })
    expect(spy).not.toHaveBeenCalled()
  })

  it('Esc fecha sem chegar a quem escuta a janela; o foco entra e volta', async () => {
    rotas({ '/api/undo/preview': preview() })
    const antes = document.createElement('textarea')
    document.body.appendChild(antes)
    antes.focus()
    const chegou: boolean[] = []
    const ouvinte = (e: KeyboardEvent) => { if (e.key === 'Escape') chegou.push(e.defaultPrevented) }
    window.addEventListener('keydown', ouvinte)
    try {
      const onClose = vi.fn()
      const { unmount } = render(<UndoDialog request={{ turnIds: [7] }} onClose={onClose} onDone={() => {}} />)
      const dialog = screen.getByRole('dialog')
      expect(document.activeElement).toBe(dialog)
      await screen.findByText('src/a.ts')
      fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
      expect(onClose).toHaveBeenCalledTimes(1)
      // O Esc para no diálogo; se algum chegasse à janela, viria marcado.
      expect(chegou).not.toContain(false)
      unmount()
      expect(document.activeElement).toBe(antes)
    } finally {
      window.removeEventListener('keydown', ouvinte)
      antes.remove()
    }
  })
})
