import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, within } from '@testing-library/react'
import { Sidebar } from '../components/Sidebar'
import { useStore } from '../store'
import { DEFAULT_APPEARANCE } from '../appearance'
import type { EngineMeta } from '../types'

const CLAUDE: EngineMeta = {
  id: 'claude', label: 'Claude Code', icon: 'claude', models: [''], efforts: ['auto'],
  permissions: ['default'], slashSource: 'protocol', slashCommands: [],
}

/** O servidor recusa o PATCH do grupo; o resto responde normalmente. */
const stub = (patchStatus = 200) =>
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const u = String(url)
    if (u.includes('/api/groups/') && init?.method === 'PATCH') {
      return new Response(JSON.stringify({ error: 'ícone inválido' }), { status: patchStatus })
    }
    const body = u.includes('/api/local-apps') ? {} : u.includes('/api/groups') ? [{ id: 10, name: 'Backend', icon: '🗂️', color: '#7c5cff' }] : []
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })

beforeEach(() => {
  useStore.setState({
    projects: [{ id: 1, name: 'Alpha', path: '/a', color: '#fff', icon: '🅰️', groupId: 10 }],
    groups: [{ id: 10, name: 'Backend', icon: '🗂️', color: '#7c5cff' }], sectors: [],
    schedules: [], sessions: {}, chat: {}, unread: {}, streaming: {}, historyLoadedFor: {},
    view: 'dashboard', engines: [CLAUDE], appearance: DEFAULT_APPEARANCE,
    me: { setupRequired: false, id: 1, username: 'u', isAdmin: true },
  })
  localStorage.clear()
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const abrirEditorDoGrupo = async () => {
  render(<Sidebar />)
  const cabecalho = await screen.findByText('Backend')
  const linha = cabecalho.closest('.term-group__header') as HTMLElement
  fireEvent.click(within(linha).getByTitle(/opções|editar/i))
  return document.querySelector('.sess-pop') as HTMLElement
}

/**
 * O defeito relatado: escolher ícone para o grupo, clicar em Salvar, e nada
 * acontecer. Metade era o servidor recusando token comprido; a outra metade era
 * ESTE `.catch(() => {})`, que fechava o popover e engolia o motivo.
 */
describe('salvar o grupo diz quando não deu', () => {
  it('falha mantém o editor aberto e mostra o motivo', async () => {
    stub(400)
    const pop = await abrirEditorDoGrupo()
    fireEvent.click(within(pop).getByText(/salvar|save/i))
    await vi.waitFor(() => expect(within(document.querySelector('.sess-pop')!).getByText(/ícone inválido/i)).toBeTruthy())
  })

  it('sucesso fecha o editor', async () => {
    stub(200)
    const pop = await abrirEditorDoGrupo()
    fireEvent.click(within(pop).getByText(/salvar|save/i))
    await vi.waitFor(() => expect(document.querySelector('.sess-pop')).toBeNull())
  })
})
