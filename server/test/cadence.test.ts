import { describe, it, expect } from 'vitest'
import { validateCadence, matches, nextRun, type Cadence } from '../src/schedules/cadence.js'

// Datas em hora LOCAL de propósito: a cadência é hora de parede ("todo dia 12:00"
// é meio-dia na máquina que roda o Claudinei), então o teste fala a mesma língua.
const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min, 0, 0)
const fmt = (d: Date) =>
  `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
const nexts = (c: Cadence, from: Date, n = 4) => nextRun(c, from, n).map(fmt)

describe('validateCadence', () => {
  it('aceita as formas amigáveis bem formadas', () => {
    expect(validateCadence({ kind: 'every', n: 15, unit: 'minutes' })).toBeNull()
    expect(validateCadence({ kind: 'daily', at: '12:00' })).toBeNull()
    expect(validateCadence({ kind: 'weekly', weekdays: [1, 5], at: '09:30' })).toBeNull()
    expect(validateCadence({ kind: 'monthly', day: 31, at: '00:00' })).toBeNull()
    expect(validateCadence({ kind: 'cron', expr: '*/15 9-18 * * 1-5' })).toBeNull()
  })

  it('recusa o que não tem próxima execução possível ou está fora de faixa', () => {
    expect(validateCadence({ kind: 'daily', at: '25:00' })).toBeTruthy()
    expect(validateCadence({ kind: 'daily', at: '12:60' })).toBeTruthy()
    expect(validateCadence({ kind: 'every', n: 0, unit: 'minutes' })).toBeTruthy()
    // o modelo só expressa múltiplos dentro da hora — 90 min não cabe (nem em cron)
    expect(validateCadence({ kind: 'every', n: 90, unit: 'minutes' })).toBeTruthy()
    expect(validateCadence({ kind: 'weekly', weekdays: [], at: '09:00' })).toBeTruthy()
    expect(validateCadence({ kind: 'weekly', weekdays: [7], at: '09:00' })).toBeTruthy()
    expect(validateCadence({ kind: 'monthly', day: 32, at: '09:00' })).toBeTruthy()
    expect(validateCadence({ kind: 'cron', expr: '* * *' })).toBeTruthy()
    expect(validateCadence({ kind: 'cron', expr: '60 * * * *' })).toBeTruthy()
    expect(validateCadence({ kind: 'nope' } as unknown as Cadence)).toBeTruthy()
  })
})

describe('a cada N', () => {
  it('minutos: múltiplos dentro da hora, virando a hora certo', () => {
    const c: Cadence = { kind: 'every', n: 15, unit: 'minutes' }
    expect(nexts(c, at(2026, 8, 18, 9, 50))).toEqual(['08-18 10:00', '08-18 10:15', '08-18 10:30', '08-18 10:45'])
  })

  it('horas: conta a partir da meia-noite', () => {
    const c: Cadence = { kind: 'every', n: 6, unit: 'hours' }
    expect(nexts(c, at(2026, 8, 18, 7, 0))).toEqual(['08-18 12:00', '08-18 18:00', '08-19 00:00', '08-19 06:00'])
  })

  /** "entre 09:00 e 18:00" é janela, não faixa de horas: 18:15 está fora dela. */
  it('respeita a janela de horário, inclusive o limite exato', () => {
    const c: Cadence = { kind: 'every', n: 15, unit: 'minutes', from: '09:00', to: '18:00' }
    expect(nexts(c, at(2026, 8, 18, 17, 40))).toEqual(['08-18 17:45', '08-18 18:00', '08-19 09:00', '08-19 09:15'])
  })

  it('só nos dias da semana escolhidos', () => {
    // 2026-08-21 é uma sexta; seg–sex pula sábado e domingo
    const c: Cadence = { kind: 'every', n: 12, unit: 'hours', weekdays: [1, 2, 3, 4, 5] }
    expect(nexts(c, at(2026, 8, 21, 13, 0))).toEqual(['08-24 00:00', '08-24 12:00', '08-25 00:00', '08-25 12:00'])
  })
})

describe('diário, semanal e mensal', () => {
  it('todo dia no horário, pulando para amanhã quando já passou', () => {
    const c: Cadence = { kind: 'daily', at: '12:00' }
    expect(nexts(c, at(2026, 8, 18, 12, 0), 2)).toEqual(['08-19 12:00', '08-20 12:00'])
    expect(nexts(c, at(2026, 8, 18, 11, 59), 1)).toEqual(['08-18 12:00'])
  })

  it('semanal só nos dias escolhidos', () => {
    // 2026-08-18 é terça; seg(1) e qui(4)
    const c: Cadence = { kind: 'weekly', weekdays: [1, 4], at: '09:00' }
    expect(nexts(c, at(2026, 8, 18, 10, 0), 3)).toEqual(['08-20 09:00', '08-24 09:00', '08-27 09:00'])
  })

  it('mensal salta os meses que não têm aquele dia', () => {
    const c: Cadence = { kind: 'monthly', day: 31, at: '08:00' }
    // set(30) e nov(30) não têm dia 31
    expect(nexts(c, at(2026, 8, 31, 9, 0), 3)).toEqual(['10-31 08:00', '12-31 08:00', '01-31 08:00'])
  })
})

describe('cron cru', () => {
  it('compila para o mesmo que a forma estruturada equivalente', () => {
    const from = at(2026, 8, 18, 9, 50)
    expect(nexts({ kind: 'cron', expr: '*/15 * * * *' }, from))
      .toEqual(nexts({ kind: 'every', n: 15, unit: 'minutes' }, from))
    expect(nexts({ kind: 'cron', expr: '0 12 * * *' }, from))
      .toEqual(nexts({ kind: 'daily', at: '12:00' }, from))
  })

  it('entende listas, faixas e passos', () => {
    const c: Cadence = { kind: 'cron', expr: '0,30 9-11 * * *' }
    expect(nexts(c, at(2026, 8, 18, 8, 0))).toEqual(['08-18 09:00', '08-18 09:30', '08-18 10:00', '08-18 10:30'])
  })

  /**
   * Semântica clássica do cron: com dia-do-mês E dia-da-semana restritos, casa
   * QUALQUER um dos dois (não os dois juntos). Errar isso faz um agendamento
   * disparar num punhado de dias em vez de todos os previstos.
   */
  it('faz OU entre dia-do-mês e dia-da-semana quando os dois estão restritos', () => {
    const c: Cadence = { kind: 'cron', expr: '0 0 1 * 1' }  // dia 1 OU toda segunda
    expect(nexts(c, at(2026, 8, 18, 0, 0), 4)).toEqual(['08-24 00:00', '08-31 00:00', '09-01 00:00', '09-07 00:00'])
  })

  it('faz E quando só um dos dois está restrito', () => {
    expect(nexts({ kind: 'cron', expr: '0 0 15 * *' }, at(2026, 8, 18), 2)).toEqual(['09-15 00:00', '10-15 00:00'])
  })
})

describe('matches', () => {
  it('responde pelo minuto exato, não pelo intervalo', () => {
    const c: Cadence = { kind: 'daily', at: '12:00' }
    expect(matches(c, at(2026, 8, 18, 12, 0))).toBe(true)
    expect(matches(c, at(2026, 8, 18, 12, 1))).toBe(false)
  })
})

describe('cadência impossível', () => {
  it('devolve vazio em vez de rodar para sempre', () => {
    // 30 de fevereiro não existe em nenhum ano
    expect(nextRun({ kind: 'cron', expr: '0 0 30 2 *' }, at(2026, 8, 18), 1)).toEqual([])
  })
})

/** Meses são um campo de cron como os outros — "todo 1º de janeiro" tem de valer. */
describe('restrição por mês (cron)', () => {
  it('respeita o campo de mês', () => {
    // Só uma ocorrência cabe: o teto de 366 dias não alcança o janeiro seguinte —
    // limitação assumida, e é o que o preview mostra para cadências anuais.
    expect(nexts({ kind: 'cron', expr: '0 0 1 1 *' }, at(2026, 8, 18), 4)).toEqual(['01-01 00:00'])
    expect(nextRun({ kind: 'cron', expr: '0 0 1 1 *' }, at(2026, 8, 18), 1)[0].getFullYear()).toBe(2027)
  })

  it('rejeita na validação a data que não existe em mês nenhum', () => {
    expect(validateCadence({ kind: 'cron', expr: '0 0 30 2 *' })).toMatch(/próxima execução/)
  })
})
