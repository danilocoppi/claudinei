import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
vi.mock('../notifications', () => ({ notifySessionChange: vi.fn(), notifyQuestion: vi.fn() }))
import { parseBranchCommand, runBranchCommand } from '../branch/commands'
import { useSideStore } from '../branch/sideStore'
import { BUILTIN_FALLBACK, CLAUDINEI_COMMANDS, SLASH_DESCRIPTIONS, filterCommands } from '../slash'
import { useSessionSlashCommands, useStore } from '../store'
import en from '../i18n/en'
import ptBR from '../i18n/pt-BR'
import es from '../i18n/es'
import type { EngineMeta, Project, SessionInfo } from '../types'

/**
 * `/side`, `/btw` e `/fork` são do Claudinei: o campo os reconhece e chama a
 * rota própria na hora, sem fila e sem passar pelo motor.
 */

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const ALPHA: Project = { id: 1, name: 'Alpha', path: '/a', color: '#fff', icon: '📁' }
const ctx = { localId: 'c1', projectId: 1, engine: 'claude' }

beforeEach(() => {
  useStore.setState({ projects: [ALPHA], sessions: {}, chat: {}, activeLocalId: 'c1', view: 'chat', unread: {} })
  useSideStore.setState({ sides: {}, replaceAsk: null, appendRequest: null })
})
afterEach(() => { vi.restoreAllMocks() })

describe('parseBranchCommand', () => {
  it('reconhece /side e /btw com e sem pergunta', () => {
    expect(parseBranchCommand('/side x')).toEqual({ kind: 'side', text: 'x' })
    expect(parseBranchCommand('/side  por que isto?\nlinha 2')).toEqual({ kind: 'side', text: 'por que isto?\nlinha 2' })
    expect(parseBranchCommand('/btw')).toEqual({ kind: 'side', text: '' })
  })

  it('reconhece /fork com e sem nome', () => {
    expect(parseBranchCommand('/fork')).toEqual({ kind: 'fork', name: '' })
    expect(parseBranchCommand('/fork Nome')).toEqual({ kind: 'fork', name: 'Nome' })
  })

  it('/sidebar, /forked e texto comum não casam', () => {
    expect(parseBranchCommand('/sidebar')).toBeNull()
    expect(parseBranchCommand('/forked')).toBeNull()
    expect(parseBranchCommand('/btwx oi')).toBeNull()
    expect(parseBranchCommand('veja o /side')).toBeNull()
  })
})

describe('slash', () => {
  const engine = (id: string, slashSource: EngineMeta['slashSource'], slashCommands: string[] = []): EngineMeta =>
    ({ id, label: id, icon: id, models: [''], efforts: ['auto'], permissions: [], slashSource, slashCommands })
  const sess = (engineId: string): SessionInfo =>
    ({ localId: engineId, projectId: 1, status: 'idle', engineSessionId: null, updatedAt: 'x', engine: engineId })

  it('side, btw e fork aparecem para qualquer motor', () => {
    useStore.setState({
      engines: [engine('claude', 'protocol'), engine('codex', 'curated', ['review']), engine('kimi', 'none')],
      slashCommands: ['compact'],
    })
    for (const id of ['claude', 'codex', 'kimi']) {
      const { result } = renderHook(() => useSessionSlashCommands(sess(id)))
      for (const c of ['side', 'btw', 'fork']) expect(filterCommands(result.current, ''), `${c} no ${id}`).toContain(c)
    }
    for (const c of ['side', 'btw', 'fork']) {
      expect(CLAUDINEI_COMMANDS).toContain(c)
      expect(BUILTIN_FALLBACK).toContain(c)
      expect(SLASH_DESCRIPTIONS[c]).toBe(`slash.${c}`)
      for (const dict of [en, ptBR, es]) expect(dict.slash[c as 'side' | 'btw' | 'fork']).toBeTruthy()
    }
  })
})

describe('runBranchCommand', () => {
  const sideInfo = { id: 's1', projectId: 1, engine: 'claude', status: 'starting', mode: 'native', cutAt: null, files: 'no_edit_tools', question: 'x', openedAt: '2026-11-20T12:00:00Z' }

  it('/side chama a rota com a pergunta e já mostra a lateral', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json(201, sideInfo))
    await runBranchCommand({ kind: 'side', text: 'x' }, ctx)
    expect(fetch).toHaveBeenCalledWith('/api/projects/1/side', expect.objectContaining({ method: 'POST' }))
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ engine: 'claude', text: 'x' })
    expect(useSideStore.getState().sides['1:claude']?.info.id).toBe('s1')
    expect(useStore.getState().chat.c1 ?? []).toEqual([])
  })

  it('/side sem pergunta não manda texto', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json(201, { ...sideInfo, question: null }))
    await runBranchCommand({ kind: 'side', text: '' }, ctx)
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ engine: 'claude' })
  })

  it('409 side_exists vira replaceAsk', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      json(409, { error: 'já existe uma conversa lateral aberta neste terminal', code: 'side_exists', params: {} }))
    await runBranchCommand({ kind: 'side', text: 'e agora?' }, ctx)
    expect(useSideStore.getState().replaceAsk).toEqual({ projectId: 1, engine: 'claude', text: 'e agora?' })
    // A coluna é que pergunta: nada vai ao chat.
    expect(useStore.getState().chat.c1 ?? []).toEqual([])
  })

  it('outra recusa do /side vai ao chat como erro, no idioma da tela', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      json(409, { error: 'texto do servidor', code: 'no_conversation', params: {} }))
    await runBranchCommand({ kind: 'side', text: 'x' }, ctx)
    expect(useStore.getState().chat.c1).toEqual([
      expect.objectContaining({ kind: 'command_output', text: 'Ainda não há conversa para copiar', isError: true }),
    ])
    expect(useSideStore.getState().replaceAsk).toBeNull()
  })

  it('/fork com 403 mostra "Só um administrador pode criar terminais"', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      json(403, { error: 'forbidden by server', code: 'fork_admin_only', params: {} }))
    await runBranchCommand({ kind: 'fork', name: '' }, ctx)
    expect(useStore.getState().chat.c1).toEqual([
      expect.objectContaining({ kind: 'command_output', text: 'Só um administrador pode criar terminais', isError: true }),
    ])
  })

  it('/fork cria o terminal, grava o projeto e abre a sessão dele', async () => {
    const ramo: Project = { id: 2, name: 'Alpha (ramo)', path: '/a', color: '#fff', icon: '📁', forkedFrom: 1, forkedCutAt: '2026-11-20T11:59:00Z' }
    const session: SessionInfo = { localId: 'r1', projectId: 2, status: 'starting', engineSessionId: null, updatedAt: 'x', engine: 'claude' }
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
      String(url) === '/api/projects' ? json(200, [ALPHA, ramo]) : json(201, { project: ramo, session }))
    await runBranchCommand({ kind: 'fork', name: 'Nome' }, ctx)
    expect(fetch).toHaveBeenCalledWith('/api/projects/1/fork', expect.objectContaining({ method: 'POST' }))
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ engine: 'claude', name: 'Nome' })
    expect(useStore.getState().projects.map((p) => p.id)).toEqual([1, 2])
    expect(useStore.getState().activeLocalId).toBe('r1')
    expect(useStore.getState().view).toBe('chat')
  })

  it('/fork sem nome não manda nome (o servidor escolhe "(ramo)")', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json(403, { error: 'x', code: 'fork_admin_only' }))
    await runBranchCommand({ kind: 'fork', name: '   ' }, ctx)
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({ engine: 'claude' })
  })

  it('falha de rede vai ao chat, sem estourar', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'))
    // Falhou: `false`, para o campo devolver o texto.
    await expect(runBranchCommand({ kind: 'side', text: 'x' }, ctx)).resolves.toBe(false)
    expect(useStore.getState().chat.c1).toEqual([expect.objectContaining({ kind: 'command_output', text: 'Failed to fetch', isError: true })])
  })
})

describe('serverErrors dos comandos', () => {
  it('os erros novos existem nas três línguas', () => {
    const codes = ['no_conversation', 'side_exists', 'side_not_found', 'fork_admin_only', 'handoff_same_engine',
      'handoff_engine_unavailable', 'handoff_target_busy', 'handoff_target_limited'] as const
    for (const dict of [en, ptBR, es]) for (const c of codes) expect(dict.serverErrors[c], c).toBeTruthy()
    expect(ptBR.serverErrors.no_conversation).toBe('Ainda não há conversa para copiar')
    expect(ptBR.serverErrors.fork_admin_only).toBe('Só um administrador pode criar terminais')
  })
})
