import { describe, it, expect } from 'vitest'
import { buildClaudeArgs } from '../src/claude/session.js'
import { buildInstructions, PROGRESS_RULE } from '../src/hermes/instructions.js'

/**
 * Acompanhamento de tarefas longas, obrigatório (decisão do operador): todo
 * trabalho que muda arquivos ou tem três etapas ou mais publica o andamento.
 * Medido em sessões reais: como sugestão nas instructions do MCP, o Claude
 * pulava tarefas de 40-80 s; no prompt de sistema a regra pesa mais.
 */
const hermes = { command: 'node', args: ['h.mjs'], apiUrl: 'http://x', projectId: 1 }

describe('regra obrigatória do acompanhamento', () => {
  it('é obrigação para trabalho que muda arquivos ou tem três etapas, e só pergunta/comando rápido fica fora', () => {
    expect(PROGRESS_RULE).toMatch(/required/i)
    expect(PROGRESS_RULE).toContain('change files')
    expect(PROGRESS_RULE).toContain('three or more steps')
    expect(PROGRESS_RULE).toContain('update_progress')
    expect(PROGRESS_RULE).toMatch(/before you start/)
    expect(PROGRESS_RULE).toMatch(/questions/)
  })

  it('o Claude recebe a regra no prompt de sistema quando tem o Hermes', () => {
    const args = buildClaudeArgs({ hermes })
    const i = args.indexOf('--append-system-prompt')
    expect(i).toBeGreaterThan(-1)
    expect(args[i + 1]).toBe(PROGRESS_RULE)
  })

  it('sem o Hermes não há regra (a ferramenta nem existe)', () => {
    expect(buildClaudeArgs({})).not.toContain('--append-system-prompt')
  })

  it('os outros motores recebem a mesma regra pelas instructions do Hermes', () => {
    expect(buildInstructions(1, [{ id: 1, name: 'P' }])).toContain(PROGRESS_RULE)
  })
})
