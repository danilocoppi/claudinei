import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { ChangesPanel } from '../components/undo/ChangesPanel'
import { UnifiedDiff } from '../components/undo/UnifiedDiff'
import { useUndoStore } from '../undo/undoStore'
import type { AttributedFile, ChangedFilesDto, FileDiff, TurnDto } from '../../../shared/undo'

const turn = (id: number, over: Partial<TurnDto> = {}): TurnDto => ({
  id, localId: 'a', projectId: 1, engine: 'claude', origin: 'operator', key: `t${id}`, midTurn: false,
  state: 'ok', limited: false, endKind: 'result',
  summary: { files: 1, added: 1, removed: 0, outside: 0, uncertain: 0, unsnapshotted: 0 },
  lastRun: null, startedAt: '2026-11-21T10:00:00Z', endedAt: '2026-11-21T10:01:00Z', ...over,
})
const file = (path: string, over: Partial<AttributedFile> = {}): AttributedFile => ({
  path, status: 'modified', added: 2, removed: 1, binary: false, class: 'own', overlapped: false, inProject: true, ...over,
})

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** Respostas por prefixo de URL; o resto é 404. */
function rotas(map: Record<string, unknown>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input)
    const hit = Object.keys(map).find(k => url.startsWith(k))
    return hit ? json(map[hit]) : json({ error: 'nada', code: 'x' }, 404)
  })
}
const urls = (spy: ReturnType<typeof rotas>) => spy.mock.calls.map(([u]) => String(u))

const DIFF: FileDiff = {
  path: 'src/a.ts', binary: false, truncated: false,
  text: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n contexto\n-velha\n+nova linha\n',
}

beforeEach(() => {
  useUndoStore.setState({
    byLocal: { a: { git: true, turns: [turn(7)], outside: [], interactive: [], intervals: [] } },
    terminalOf: { a: { projectId: 1, engine: 'claude' } },
  })
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('ChangesPanel', () => {
  it('o painel não busca diff antes do clique', async () => {
    const files: ChangedFilesDto = { files: [file('src/a.ts'), file('src/b.ts')], hiddenOutside: 0, warnings: [] }
    const spy = rotas({ '/api/undo/turns/7/files': files, '/api/undo/turns/7/diff': DIFF })
    render(<ChangesPanel localId="a" focus={{ turnId: 7 }} onClose={() => {}} />)
    expect(await screen.findByText('a.ts')).toBeTruthy()
    expect(screen.getByText('b.ts')).toBeTruthy()
    expect(urls(spy).some(u => u.includes('/diff'))).toBe(false)

    fireEvent.click(screen.getByText('a.ts'))
    expect(await screen.findByText('nova linha')).toBeTruthy()
    expect(urls(spy)).toContain('/api/undo/turns/7/diff?path=src%2Fa.ts')
    expect(screen.getByText('velha')).toBeTruthy()
  })

  it('pastas recolhem e mostram +/− por arquivo', async () => {
    rotas({ '/api/undo/turns/7/files': { files: [file('src/a.ts', { added: 5, removed: 3 })], hiddenOutside: 0, warnings: [] } })
    render(<ChangesPanel localId="a" focus={{ turnId: 7 }} onClose={() => {}} />)
    expect(await screen.findByText('a.ts')).toBeTruthy()
    expect(screen.getByText('+5')).toBeTruthy()
    expect(screen.getByText('−3')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /src/ }))
    expect(screen.queryByText('a.ts')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /src/ }))
    expect(screen.getByText('a.ts')).toBeTruthy()
  })

  it('grande demais, sem retrato e submódulo não buscam diff', async () => {
    const files: ChangedFilesDto = {
      files: [
        file('big.bin', { status: 'too_big', added: 0, removed: 0, size: 3 * 1024 * 1024 }),
        file('solto.txt', { status: 'unsnapshotted', added: 0, removed: 0 }),
        file('vendor/lib', { status: 'submodule', added: 0, removed: 0 }),
      ],
      hiddenOutside: 2, warnings: [],
    }
    const spy = rotas({ '/api/undo/turns/7/files': files })
    render(<ChangesPanel localId="a" focus={{ turnId: 7 }} onClose={() => {}} />)
    fireEvent.click(await screen.findByText('big.bin'))
    expect(screen.getByText('grande demais para o retrato (3.0 MB)')).toBeTruthy()
    fireEvent.click(screen.getByText('solto.txt'))
    expect(screen.getByText('mudou, sem retrato')).toBeTruthy()
    fireEvent.click(screen.getByText('lib'))
    expect(screen.getByText('submódulo mudou')).toBeTruthy()
    expect(urls(spy).some(u => u.includes('/diff'))).toBe(false)
    // Os de fora da pasta do projeto, só a contagem.
    expect(screen.getByText('2 arquivos fora deste projeto')).toBeTruthy()
  })

  it('seções: incertos, fora da conversa, entre turnos e interativo', async () => {
    useUndoStore.setState({
      byLocal: {
        a: {
          git: true, turns: [turn(7)], outside: [turn(3)], interactive: [turn(5, { origin: 'interactive' })],
          intervals: [
            { from: 12, to: 13, kind: 'undo', at: '2026-11-21T12:00:00Z' },
            { from: 10, to: 11, kind: 'between', at: '2026-11-21T11:00:00Z' },
          ],
        },
      },
    })
    const spy = rotas({
      '/api/undo/turns/7/files': { files: [file('meu.ts'), file('talvez.ts', { class: 'uncertain' })], hiddenOutside: 0, warnings: ['uncertain_end'] },
      '/api/undo/turns/3/files': { files: [file('antigo.ts')], hiddenOutside: 0, warnings: [] },
      '/api/undo/turns/5/files': { files: [file('no-terminal.ts')], hiddenOutside: 0, warnings: [] },
      '/api/undo/intervals/10/11/files': { files: [file('editor.ts')], hiddenOutside: 0, warnings: [] },
      '/api/undo/intervals/12/13/files': { files: [file('desfeito.ts')], hiddenOutside: 0, warnings: [] },
      '/api/undo/intervals/10/11/diff': { ...DIFF, path: 'editor.ts' },
    })
    render(<ChangesPanel localId="a" focus={{ turnId: 7 }} onClose={() => {}} />)
    expect(await screen.findByText('meu.ts')).toBeTruthy()
    expect(screen.getByText('fim incerto')).toBeTruthy()
    expect(screen.getByText('Pode ser de outro terminal')).toBeTruthy()
    expect(screen.getByText('talvez.ts')).toBeTruthy()
    expect(screen.getByText('Fora da conversa atual')).toBeTruthy()
    expect(screen.getByText('Mudanças entre turnos')).toBeTruthy()
    expect(screen.getByText('Desfeito')).toBeTruthy()
    expect(screen.getByText('Feito no terminal interativo')).toBeTruthy()

    // As outras seções só buscam os arquivos ao abrir cada entrada.
    expect(urls(spy).filter(u => u.includes('/files'))).toEqual(['/api/undo/turns/7/files'])
    const entradas = screen.getAllByRole('button', { name: /^Intervalo/ })
    expect(entradas).toHaveLength(2)
    fireEvent.click(entradas.find(b => b.closest('[data-section="between"]'))!)
    fireEvent.click(await screen.findByText('editor.ts'))
    expect(await screen.findByText('nova linha')).toBeTruthy()
    expect(urls(spy)).toContain('/api/undo/intervals/10/11/files?localId=a')
    expect(urls(spy)).toContain('/api/undo/intervals/10/11/diff?localId=a&path=editor.ts')
    expect(urls(spy).some(u => u.includes('/intervals/12/13/'))).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: /^Turno #3/ }))
    expect(await screen.findByText('antigo.ts')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^Turno #5/ }))
    expect(await screen.findByText('no-terminal.ts')).toBeTruthy()
  })

  it('foco num intervalo: os arquivos dele já abertos', async () => {
    useUndoStore.setState({
      byLocal: { a: { git: true, turns: [], outside: [], interactive: [], intervals: [{ from: 10, to: 11, kind: 'between', at: '2026-11-21T11:00:00Z' }] } },
    })
    const spy = rotas({ '/api/undo/intervals/10/11/files': { files: [file('editor.ts')], hiddenOutside: 0, warnings: [] } })
    render(<ChangesPanel localId="a" focus={{ interval: { from: 10, to: 11 } }} onClose={() => {}} />)
    expect(await screen.findByText('editor.ts')).toBeTruthy()
    expect(urls(spy)).toEqual(['/api/undo/intervals/10/11/files?localId=a'])
  })

  it('declarações: sem rede, pares no DiffView e patch no UnifiedDiff', async () => {
    const spy = rotas({})
    render(<ChangesPanel localId="a" onClose={() => {}} focus={{ declared: [
      { path: '/p/a.txt', kind: 'edit', pairs: [{ old: 'antes', new: 'depois' }] },
      { path: '/p/b.txt', kind: 'patch', diff: '@@ -1 +1 @@\n-x\n+linha do patch\n' },
      { path: '/p/c.txt', kind: 'written' },
    ] }} />)
    expect(screen.getByText('Mudanças declaradas pelo agente')).toBeTruthy()
    fireEvent.click(screen.getByText('a.txt'))
    expect(screen.getByText(/- antes/)).toBeTruthy()
    expect(screen.getByText(/\+ depois/)).toBeTruthy()
    fireEvent.click(screen.getByText('b.txt'))
    expect(screen.getByText('linha do patch')).toBeTruthy()
    fireEvent.click(screen.getByText('c.txt'))
    expect(screen.getByText('arquivo escrito inteiro (sem diff)')).toBeTruthy()
    expect(spy).not.toHaveBeenCalled()
  })

  it('rodapé de ajuda sobre as refs ocultas e Esc fecha', async () => {
    rotas({ '/api/undo/turns/7/files': { files: [], hiddenOutside: 0, warnings: [] } })
    const onClose = vi.fn()
    render(<ChangesPanel localId="a" focus={{ turnId: 7 }} onClose={onClose} />)
    expect(screen.getByText(/git log --all/)).toBeTruthy()
    expect(screen.getByText(/git push --mirror/)).toBeTruthy()
    await waitFor(() => expect(screen.getByText('Nenhum arquivo mudou.')).toBeTruthy())
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })
})

describe('ChangesPanel: Esc e Desfazer nas entradas', () => {
  it('Esc no painel fecha sem chegar a quem escuta a janela; o foco entra e volta', async () => {
    rotas({ '/api/undo/turns/7/files': { files: [], hiddenOutside: 0, warnings: [] } })
    const antes = document.createElement('textarea')
    document.body.appendChild(antes)
    antes.focus()
    const chegou: boolean[] = []
    const ouvinte = (e: KeyboardEvent) => { if (e.key === 'Escape') chegou.push(e.defaultPrevented) }
    window.addEventListener('keydown', ouvinte)
    try {
      const onClose = vi.fn()
      const { unmount } = render(<ChangesPanel localId="a" focus={{ turnId: 7 }} onClose={onClose} />)
      const dialog = screen.getByRole('dialog')
      expect(document.activeElement).toBe(dialog)
      await screen.findByText('Nenhum arquivo mudou.')
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

  it('fora da conversa e terminal interativo têm Desfazer (ou Refazer) por turno', async () => {
    useUndoStore.setState({
      byLocal: {
        a: {
          git: true, turns: [turn(7)], outside: [turn(3), turn(4, { lastRun: { id: 9, redone: false } })],
          interactive: [turn(5, { origin: 'interactive' }), turn(6, { origin: 'interactive', state: 'failed', summary: null })],
          intervals: [],
        },
      },
    })
    rotas({ '/api/undo/turns/7/files': { files: [], hiddenOutside: 0, warnings: [] } })
    const onUndo = vi.fn()
    render(<ChangesPanel localId="a" focus={{ turnId: 7 }} onClose={() => {}} onUndo={onUndo} />)
    const fora = screen.getByText('Fora da conversa atual').closest('section')!
    const desfazerFora = fora.querySelectorAll<HTMLButtonElement>('button.undo-entry__action')
    expect([...desfazerFora].map(b => b.textContent)).toEqual(['Desfazer', 'Refazer'])
    fireEvent.click(desfazerFora[0])
    expect(onUndo).toHaveBeenLastCalledWith({ turnIds: [3] })
    fireEvent.click(desfazerFora[1])
    expect(onUndo).toHaveBeenLastCalledWith({ redoRunId: 9 })

    // O interativo sem ponto de restauração não tem a ação.
    const interativo = screen.getByText('Feito no terminal interativo').closest('section')!
    const desfazerInt = interativo.querySelectorAll<HTMLButtonElement>('button.undo-entry__action')
    expect(desfazerInt).toHaveLength(1)
    fireEvent.click(desfazerInt[0])
    expect(onUndo).toHaveBeenLastCalledWith({ turnIds: [5] })
  })
})

describe('UnifiedDiff', () => {
  it('binário e corte de 2000 linhas mostram o aviso', () => {
    const { rerender } = render(<UnifiedDiff diff={{ path: 'x.png', binary: true, sizeKb: 12, text: '', truncated: false }} />)
    expect(screen.getByText('binário, 12 KB')).toBeTruthy()
    rerender(<UnifiedDiff diff={{ ...DIFF, truncated: true }} />)
    expect(screen.getByText('O diff foi cortado em 2.000 linhas.')).toBeTruthy()
    // Linhas +, − e contexto, cada uma com a sua classe.
    expect(screen.getByText('nova linha').closest('.undo-diff__line--add')).toBeTruthy()
    expect(screen.getByText('velha').closest('.undo-diff__line--del')).toBeTruthy()
    expect(screen.getByText('contexto').closest('.undo-diff__line--ctx')).toBeTruthy()
  })
})

// O mesmo padrão do sidebar-css.test.ts: lê os fontes. Sem GPU (AGENTS.md),
// nada de animação, transição ou desfoque nos componentes novos.
describe('estilos do desfazer', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const dir = join(here, '..', 'components', 'undo')
  const ler = (f: string) => readFileSync(join(dir, f), 'utf8')

  it('nenhum estilo novo usa animation, transition ou backdrop-filter', () => {
    const css = ler('undo.css')
    expect(css).not.toMatch(/@keyframes/)
    // Só vale zerar (`transition: none` desliga a do botão base).
    for (const m of css.matchAll(/(?:^|[;{\s])((?:-webkit-)?(?:animation|transition|backdrop-filter)[\w-]*)\s*:\s*([^;}]*)/g)) {
      expect(m[2].trim(), `${m[1]} no undo.css`).toBe('none')
    }
    for (const f of ['TurnLine.tsx', 'ChangesPanel.tsx', 'UnifiedDiff.tsx', 'UndoDialog.tsx', 'EditFromHereDialog.tsx']) {
      const src = ler(f)
      expect(src, f).not.toMatch(/\b(animation|transition|backdropFilter|WebkitBackdropFilter)\s*:/)
      // As classes do vidro e do fundo dos modais trazem backdrop-filter.
      expect(src, f).not.toMatch(/['"`\s](glass|modal-overlay)['"`\s]/)
    }
  })
})
