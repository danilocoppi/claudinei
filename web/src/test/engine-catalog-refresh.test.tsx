import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchEngines } from '../api'
import { useEngineCatalog } from '../useEngineCatalog'
import { useStore } from '../store'
import type { EngineMeta } from '../types'

vi.mock('../api', () => ({ fetchEngines: vi.fn() }))
const fetchCatalog = vi.mocked(fetchEngines)
const engine = (model: string): EngineMeta => ({
  id: 'codex', label: 'Codex', icon: 'openai', models: ['', model],
  efforts: ['auto', 'medium'], permissions: [], slashSource: 'curated', slashCommands: [],
})
const old = engine('gpt-5.6-sol')
const current = engine('gpt-6-sol')
const flush = () => act(async () => {})

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-23T12:00:00Z'))
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  fetchCatalog.mockReset().mockResolvedValue([old])
  useStore.setState({ engines: [old] })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers() })

describe('atualização do catálogo sem recarregar a página', () => {
  it('busca ao autenticar e recebe novos modelos em uma aba que continua aberta', async () => {
    const { rerender } = renderHook(({ enabled }) => useEngineCatalog(enabled), { initialProps: { enabled: false } })
    expect(fetchCatalog).not.toHaveBeenCalled()
    rerender({ enabled: true })
    await flush()
    expect(fetchCatalog).toHaveBeenCalledTimes(1)
    fetchCatalog.mockResolvedValue([current])
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000) })
    expect(useStore.getState().engines).toEqual([current])
  })

  it('ignora abas ocultas e atualiza ao voltar sem duplicar focus/visibility', async () => {
    const hidden = vi.mocked(Object.getOwnPropertyDescriptor(document, 'hidden')!.get!)
    hidden.mockReturnValue(true)
    renderHook(() => useEngineCatalog(true))
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000) })
    expect(fetchCatalog).not.toHaveBeenCalled()
    hidden.mockReturnValue(false)
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('focus'))
    await flush()
    expect(fetchCatalog).toHaveBeenCalledTimes(1)
    window.dispatchEvent(new Event('focus'))
    await flush()
    expect(fetchCatalog).toHaveBeenCalledTimes(1)
    fetchCatalog.mockResolvedValue([current])
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    window.dispatchEvent(new Event('focus'))
    await flush()
    expect(useStore.getState().engines).toEqual([current])
  })

  it('mantém o último catálogo em falha e recupera na consulta seguinte', async () => {
    fetchCatalog.mockRejectedValueOnce(new Error('offline'))
    renderHook(() => useEngineCatalog(true))
    await flush()
    expect(useStore.getState().engines).toEqual([old])
    fetchCatalog.mockResolvedValue([current])
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000) })
    expect(useStore.getState().engines).toEqual([current])
  })

  it('não sobrepõe consultas lentas nem aplica respostas depois do logout', async () => {
    let resolve!: (engines: EngineMeta[]) => void
    fetchCatalog.mockImplementation(() => new Promise((done) => { resolve = done }))
    const { rerender } = renderHook(({ enabled }) => useEngineCatalog(enabled), { initialProps: { enabled: true } })
    await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000) })
    window.dispatchEvent(new Event('focus'))
    expect(fetchCatalog).toHaveBeenCalledTimes(1)
    rerender({ enabled: false })
    await act(async () => { resolve([current]) })
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000) })
    window.dispatchEvent(new Event('focus'))
    document.dispatchEvent(new Event('visibilitychange'))
    expect(fetchCatalog).toHaveBeenCalledTimes(1)
    expect(useStore.getState().engines).toEqual([old])
  })
})
