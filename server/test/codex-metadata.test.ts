import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { codexCatalog, codexLimits, createCodexMetadataService } from '../src/engine/codex/codex-metadata.js'
import { readCodexMetadata } from '../src/engine/codex/codex-app-server.js'
import { effortsForModel } from '../../shared/engine-options.js'

const model = (id: string, efforts = ['low', 'max', 'ultra']) => ({
  model: id, supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort })),
  defaultReasoningEffort: efforts[0], isDefault: true,
})
const window = { usedPercent: 19, windowDurationMins: 300, resetsAt: 1_800_000_000 }
const bucket = { limitId: 'codex', primary: window, secondary: { ...window, usedPercent: 3, windowDurationMins: 10080 } }

describe('Codex model catalog', () => {
  it('usa modelos visíveis, efforts por modelo e a escolha padrão do config', () => {
    const c = codexCatalog([model('new-model'), model('small', ['medium', 'high']), { ...model('hidden'), hidden: true }], 'small')!
    expect(c.models).toEqual(['', 'new-model', 'small'])
    expect(effortsForModel(c, 'new-model')).toEqual(['auto', 'low', 'max', 'ultra'])
    expect(effortsForModel(c, '')).toEqual(['auto', 'medium', 'high'])
    expect(c.modelOptions?.small.defaultEffort).toBe('medium')
  })
  it('não aceita flags como id de modelo nem valores arbitrários de effort', () => {
    expect(codexCatalog([null, model('--flag'), model('broken', ['evil'])])).toBeNull()
    expect(codexCatalog([model('valid', ['max', 'max', 'evil'])])?.modelOptions?.valid.efforts).toEqual(['max'])
  })
})

describe('Codex account limits', () => {
  it('normaliza 5h e semanal e deduplica a visão legada', () => {
    const limits = codexLimits({ rateLimits: bucket, rateLimitsByLimitId: { codex: bucket } })
    expect(limits).toHaveLength(2)
    expect(limits[0]).toMatchObject({ percent: 19, provider: 'codex', group: 'session', windowMinutes: 300, resetsAt: '2027-01-15T08:00:00.000Z' })
    expect(limits[1]).toMatchObject({ percent: 3, group: 'weekly', windowMinutes: 10080 })
  })
  it('preserva cotas adicionais e janelas com outras durações', () => {
    const limits = codexLimits({ rateLimitsByLimitId: {
      codex: bucket,
      other: { limitName: 'Special model', primary: { ...window, windowDurationMins: 60, usedPercent: 0 } },
    } })
    expect(limits).toHaveLength(3)
    expect(limits[2]).toMatchObject({ label: 'Special model', group: 'unknown', windowMinutes: 60, percent: 0 })
  })
  it('ausência de dados e janelas inválidas não viram barras falsas', () => {
    expect(codexLimits(undefined)).toEqual([])
    expect(codexLimits({ rateLimits: { primary: { ...window, usedPercent: '19' }, secondary: { ...window, resetsAt: Infinity } } })).toEqual([])
  })
})

describe('Codex metadata cache', () => {
  it('compartilha consulta entre catálogo e uso e recupera depois de falha', async () => {
    let time = 0
    const read = vi.fn().mockResolvedValue({ models: [model('available')], rateLimits: { rateLimits: bucket } })
    const s = createCodexMetadataService({ read, now: () => time, cacheMs: 100 })
    await Promise.all([s.refresh(), s.getLimits(), s.refresh()])
    expect(read).toHaveBeenCalledTimes(1)
    expect(s.catalog().models).toContain('available')
    expect(await s.getLimits()).toHaveLength(2)
    time = 101
    read.mockRejectedValueOnce(new Error('offline'))
    expect(await s.getLimits()).toEqual([])
    expect(s.catalog().models).toContain('available')
    time = 202
    expect(await s.getLimits()).toHaveLength(2)
    expect(read).toHaveBeenCalledTimes(3)
  })
  it('sem CLI mantém fallback atualizado e não inventa limites', async () => {
    const s = createCodexMetadataService({ read: async () => ({}) })
    await s.refresh()
    expect(s.catalog().models).toContain('gpt-6-astra')
    expect(effortsForModel(s.catalog(), 'gpt-5.6-luna')).toContain('max')
    expect(effortsForModel(s.catalog(), 'gpt-5.6-luna')).not.toContain('ultra')
    expect(await s.getLimits()).toEqual([])
  })
})

const fake = fileURLToPath(new URL('./fake-codex-app-server.mjs', import.meta.url))
const query = (mode = '') => readCodexMetadata({ bin: process.execPath, args: [fake, mode] })

describe('Codex app-server metadata transport', () => {
  it('inicializa, pagina os modelos e retorna somente os metadados necessários', async () => {
    expect(await query()).toEqual({
      models: [{ model: 'first' }, { model: 'second' }], configuredModel: 'second',
      rateLimits: { rateLimits: { limitId: 'codex' }, rateLimitsByLimitId: undefined },
    })
  })
  it('login sem limites não impede a lista de modelos', async () => {
    expect(await query('no-limits')).toEqual({ models: [{ model: 'first' }, { model: 'second' }], configuredModel: 'second' })
  })
  it('CLI ausente ou inicialização recusada terminam sem rejeição', async () => {
    expect(await readCodexMetadata({ bin: '/does/not/exist/codex' })).toEqual({})
    expect(await query('init-error')).toEqual({})
  })
  it('timeout mata até um processo que ignora SIGTERM', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-meta-'))
    const pidFile = join(dir, 'pid')
    try {
      expect(await readCodexMetadata({ bin: process.execPath, args: [fake, 'hang', pidFile], timeoutMs: 500 })).toEqual({})
      const pid = Number(readFileSync(pidFile, 'utf8'))
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 3000 })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
