import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateProgress, createProgressStore, type ProgressInput } from '../src/progress.js'

/**
 * Acompanhamento de tarefas longas: o agente publica o estado inteiro (título,
 * o que faz agora, tarefas, o que espera o operador) e o Claudinei guarda um
 * arquivo por terminal (projeto + motor). Ver
 * docs/superpowers/specs/2026-11-18-acompanhamento-de-tarefas-design.md.
 */
const estado = (o: Partial<ProgressInput> = {}): ProgressInput => ({
  title: 'Fase 4, parte 1',
  now: { title: 'Revisando os contratos', detail: 'falta a trava' },
  tasks: [
    { name: 'Levantamento', status: 'done' },
    { name: 'Contratos', status: 'in_progress', note: 'commit bfdb080' },
    { name: 'Tela de versões', status: 'pending' },
  ],
  waiting: ['Qual plano de licença usar?'],
  ...o,
})
const erro = (input: unknown) => {
  const r = validateProgress(input)
  if (r.ok) throw new Error('era para recusar')
  return r.error
}

describe('validação do acompanhamento', () => {
  it('aceita o estado completo e preenche waiting vazio', () => {
    const { waiting: _w, ...sem } = estado()
    const r = validateProgress(sem)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.waiting).toEqual([])
      expect(r.value.tasks[1]).toEqual({ name: 'Contratos', status: 'in_progress', note: 'commit bfdb080' })
    }
  })

  it('recusa status desconhecido, nome vazio e mais de 40 tarefas, dizendo o campo', () => {
    expect(erro(estado({ tasks: [{ name: 'x', status: 'feito' as never }] }))).toContain('tasks[0].status')
    expect(erro(estado({ tasks: [{ name: '   ', status: 'done' }] }))).toContain('tasks[0].name')
    expect(erro(estado({ tasks: Array.from({ length: 41 }, (_, i) => ({ name: `t${i}`, status: 'pending' as const })) }))).toContain('tasks')
    expect(erro({ ...estado(), now: undefined })).toContain('now')
    expect(erro('não é objeto')).toBeTruthy()
  })

  it('recusa textos acima dos limites', () => {
    expect(erro(estado({ title: 'x'.repeat(201) }))).toContain('title')
    expect(erro(estado({ now: { title: 'a', detail: 'x'.repeat(1001) } }))).toContain('now.detail')
    expect(erro(estado({ tasks: [{ name: 'a', status: 'done', note: 'x'.repeat(501) }] }))).toContain('tasks[0].note')
    expect(erro(estado({ waiting: Array.from({ length: 11 }, () => 'x') }))).toContain('waiting')
    expect(erro(estado({ waiting: ['x'.repeat(501)] }))).toContain('waiting[0]')
  })
})

describe('arquivo do acompanhamento', () => {
  let dir: string
  beforeEach(() => { dir = join(mkdtempSync(join(tmpdir(), 'acomp-')), 'acompanhamento') })
  const store = () => createProgressStore({ dir, now: () => new Date('2026-11-18T10:00:00.000Z') })

  it('grava, lê e carimba updatedAt', () => {
    const s = store()
    const salvo = s.set(1, 'claude', estado())
    expect(salvo.updatedAt).toBe('2026-11-18T10:00:00.000Z')
    expect(s.pathOf(1, 'claude')).toBe(join(dir, '1-claude.json'))
    expect(existsSync(s.pathOf(1, 'claude'))).toBe(true)
    expect(store().get(1, 'claude')).toEqual(salvo)
  })

  it('motores separados no mesmo projeto', () => {
    const s = store()
    s.set(1, 'claude', estado({ title: 'do Claude' }))
    s.set(1, 'codex', estado({ title: 'do Codex' }))
    expect(s.get(1, 'claude')?.title).toBe('do Claude')
    expect(s.get(1, 'codex')?.title).toBe('do Codex')
    expect(s.get(2, 'claude')).toBeNull()
  })

  it('engine com caminho é recusado e nada é gravado fora', () => {
    const s = store()
    expect(() => s.set(1, '../x', estado())).toThrow()
    expect(() => s.set(1, 'a/b', estado())).toThrow()
    expect(() => s.get(1, '../x')).toThrow()
    const pai = join(dir, '..')
    expect(readdirSync(pai).filter((f) => f !== 'acompanhamento')).toEqual([])
  })

  it('arquivo corrompido lê como null', () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '1-claude.json'), '{"title": "pela met')
    expect(store().get(1, 'claude')).toBeNull()
  })

  it('clear apaga e get volta null', () => {
    const s = store()
    s.set(1, 'claude', estado())
    s.clear(1, 'claude')
    expect(s.get(1, 'claude')).toBeNull()
    expect(() => s.clear(1, 'claude')).not.toThrow()
  })

  it('gravação é atômica', () => {
    const s = store()
    s.set(1, 'claude', estado())
    s.set(1, 'claude', estado({ title: 'de novo' }))
    expect(readdirSync(dir)).toEqual(['1-claude.json'])
  })
})
