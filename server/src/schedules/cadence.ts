/**
 * Cadência de um agendamento: quando ele deve rodar.
 *
 * As formas amigáveis e o cron cru compilam para o MESMO alvo interno (conjuntos
 * de minuto, hora, dia da semana e dia do mês, mais uma janela de horário). É o
 * que garante que a interface de frase e o campo de cron não divirjam com o tempo
 * — há um avaliador só, e é ele que o agendador usa.
 *
 * Tudo em hora LOCAL do servidor: "todo dia 12:00" é meio-dia na máquina que roda
 * o Claudinei. Não há fuso por agendamento.
 */

export type Cadence =
  | { kind: 'every'; n: number; unit: 'minutes' | 'hours'; weekdays?: number[]; from?: string; to?: string }
  | { kind: 'daily'; at: string; weekdays?: number[] }
  | { kind: 'weekly'; weekdays: number[]; at: string }
  | { kind: 'monthly'; day: number; at: string }
  | { kind: 'cron'; expr: string }

interface Compiled {
  minutes: number[]
  hours: number[]
  weekdays: Set<number>
  monthdays: Set<number>
  months: Set<number>
  /** Cron faz OU entre dia-do-mês e dia-da-semana quando os DOIS estão restritos. */
  domRestricted: boolean
  dowRestricted: boolean
  /** Janela de minutos do dia (inclusiva nas duas pontas), quando houver. */
  window?: { from: number; to: number }
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/
const minuteOfDay = (hhmm: string): number => {
  const m = HHMM.exec(hhmm)
  if (!m) throw new Error(`horário inválido: ${hhmm}`)
  return Number(m[1]) * 60 + Number(m[2])
}

/** Dias da semana são 0..6 (domingo..sábado); 7 nunca casaria e viraria agendamento morto. */
const checkWeekdays = (days: number[] | undefined): void => {
  for (const d of days ?? []) {
    if (!Number.isInteger(d) || d < 0 || d > 6) throw new Error(`dia da semana inválido: ${d}`)
  }
}

const range = (from: number, to: number, step = 1): number[] => {
  const out: number[] = []
  for (let v = from; v <= to; v += step) out.push(v)
  return out
}

// Um campo de cron (curinga, valor, faixa, lista, passo) → lista de valores.
function cronField(field: string, min: number, max: number): number[] {
  const values = new Set<number>()
  for (const part of field.split(',')) {
    const [spec, stepRaw] = part.split('/')
    const step = stepRaw === undefined ? 1 : Number(stepRaw)
    if (!Number.isInteger(step) || step < 1) throw new Error(`passo inválido em "${part}"`)
    let lo: number, hi: number
    if (spec === '*') { lo = min; hi = max }
    else if (spec.includes('-')) {
      const [a, b] = spec.split('-').map(Number)
      lo = a; hi = b
    } else { lo = Number(spec); hi = Number(spec) }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
      throw new Error(`campo fora de faixa: "${part}"`)
    }
    for (const v of range(lo, hi, step)) values.add(v)
  }
  return [...values].sort((a, b) => a - b)
}

function compile(c: Cadence): Compiled {
  const all = <T>(s: T[]) => new Set(s)
  const everyDay = {
    weekdays: all(range(0, 6)), monthdays: all(range(1, 31)), months: all(range(1, 12)),
    domRestricted: false, dowRestricted: false,
  }

  switch (c.kind) {
    case 'every': {
      if (!Number.isInteger(c.n) || c.n < 1) throw new Error('intervalo inválido')
      checkWeekdays(c.weekdays)
      const limit = c.unit === 'minutes' ? 59 : 23
      if (c.n > limit) throw new Error(`intervalo acima do que o modelo expressa (máx. ${limit})`)
      const minutes = c.unit === 'minutes' ? range(0, 59, c.n) : [0]
      const hours = c.unit === 'hours' ? range(0, 23, c.n) : range(0, 23)
      return {
        ...everyDay, minutes, hours,
        weekdays: c.weekdays?.length ? new Set(c.weekdays) : everyDay.weekdays,
        dowRestricted: !!c.weekdays?.length,
        window: c.from !== undefined && c.to !== undefined
          ? { from: minuteOfDay(c.from), to: minuteOfDay(c.to) }
          : undefined,
      }
    }
    case 'daily': {
      checkWeekdays(c.weekdays)
      const t = minuteOfDay(c.at)
      return {
        ...everyDay, minutes: [t % 60], hours: [Math.floor(t / 60)],
        weekdays: c.weekdays?.length ? new Set(c.weekdays) : everyDay.weekdays,
        dowRestricted: !!c.weekdays?.length,
      }
    }
    case 'weekly': {
      if (!c.weekdays?.length) throw new Error('escolha ao menos um dia da semana')
      checkWeekdays(c.weekdays)
      const t = minuteOfDay(c.at)
      return { ...everyDay, minutes: [t % 60], hours: [Math.floor(t / 60)], weekdays: new Set(c.weekdays), dowRestricted: true }
    }
    case 'monthly': {
      if (!Number.isInteger(c.day) || c.day < 1 || c.day > 31) throw new Error('dia do mês inválido')
      const t = minuteOfDay(c.at)
      return { ...everyDay, minutes: [t % 60], hours: [Math.floor(t / 60)], monthdays: new Set([c.day]), domRestricted: true }
    }
    case 'cron': {
      const f = String(c.expr ?? '').trim().split(/\s+/)
      if (f.length !== 5) throw new Error('cron precisa de 5 campos (min hora dia mês dia-da-semana)')
      const [min, hour, dom, month, dow] = f
      return {
        minutes: cronField(min, 0, 59),
        hours: cronField(hour, 0, 23),
        months: new Set(cronField(month, 1, 12)),
        monthdays: new Set(cronField(dom, 1, 31)),
        weekdays: new Set(cronField(dow, 0, 6).map((d) => d % 7)),
        domRestricted: dom !== '*',
        dowRestricted: dow !== '*',
      }
    }
    default:
      throw new Error(`cadência desconhecida: ${(c as { kind?: string })?.kind}`)
  }
}

/** Mensagem do primeiro problema encontrado, ou null se a cadência é válida. */
export function validateCadence(c: Cadence): string | null {
  try {
    const compiled = compile(c)
    if (candidateMinutes(compiled).length === 0) return 'a janela de horário não deixa nenhum horário válido'
    // Rede final: cadências que compilam mas nunca casam (30 de fevereiro) viram
    // agendamento morto-vivo — melhor recusar na gravação que nunca disparar.
    if (nextRun(c, new Date(), 1).length === 0) return 'esta cadência não tem próxima execução no próximo ano'
    return null
  } catch (err) {
    return (err as Error).message
  }
}

/** O dia casa? Com dom E dow restritos, cron manda casar QUALQUER um dos dois. */
function dayMatches(c: Compiled, when: Date): boolean {
  if (!c.months.has(when.getMonth() + 1)) return false
  const dom = c.monthdays.has(when.getDate())
  const dow = c.weekdays.has(when.getDay())
  if (c.domRestricted && c.dowRestricted) return dom || dow
  return dom && dow
}

/** Minutos-do-dia em que a cadência dispara, em ordem. */
function candidateMinutes(c: Compiled): number[] {
  const out: number[] = []
  for (const h of c.hours) {
    for (const m of c.minutes) {
      const t = h * 60 + m
      if (c.window && (t < c.window.from || t > c.window.to)) continue
      out.push(t)
    }
  }
  return out.sort((a, b) => a - b)
}

export function matches(cadence: Cadence, when: Date): boolean {
  const c = compile(cadence)
  if (!dayMatches(c, when)) return false
  return candidateMinutes(c).includes(when.getHours() * 60 + when.getMinutes())
}

/**
 * As próximas `count` execuções DEPOIS de `after` (exclusivo). Percorre dia a dia
 * — não minuto a minuto — e, dentro do dia, só os horários que já casam.
 *
 * O teto de 366 dias é o que impede uma cadência impossível (30 de fevereiro) de
 * rodar para sempre: devolve o que achou, possivelmente vazio.
 */
export function nextRun(cadence: Cadence, after: Date, count = 1): Date[] {
  const c = compile(cadence)
  const times = candidateMinutes(c)
  if (times.length === 0) return []

  const out: Date[] = []
  const day = new Date(after.getFullYear(), after.getMonth(), after.getDate())
  const afterMinutes = after.getHours() * 60 + after.getMinutes()

  for (let d = 0; d <= 366 && out.length < count; d++) {
    const cur = new Date(day.getFullYear(), day.getMonth(), day.getDate() + d)
    if (!dayMatches(c, cur)) continue
    for (const t of times) {
      // No primeiro dia, só o que ainda não passou (o minuto de `after` já é passado).
      if (d === 0 && t <= afterMinutes) continue
      out.push(new Date(cur.getFullYear(), cur.getMonth(), cur.getDate(), Math.floor(t / 60), t % 60, 0, 0))
      if (out.length === count) break
    }
  }
  return out
}
