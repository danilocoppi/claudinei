# Card de uso na sidebar — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Card na sidebar (acima de "Terminal Interaction") com as barras do /usage — Sessão atual, Todos os modelos, Fable, e futuras — onde o preenchimento é o % usado e a COR é o ritmo (verde = sustentável até o reset; degradê até vermelho = estourando).

**Architecture:** Backend proxy `GET /api/usage` (lê o token OAuth de `~/.claude/.credentials.json`, chama `api.anthropic.com/api/oauth/usage`, normaliza `limits`, cache 60s, falha → `[]`). Front: helpers puros de ritmo (`web/src/usage/pace.ts`), `UsageCard` na Sidebar com poll de 60s + refetch no focus.

**Tech Stack:** Fastify 5 + TS strict ESM (imports `.js`); React 18 + TS strict (imports sem extensão); Vitest.

## Global Constraints

- Português com acentuação correta; i18n nas 3 línguas (en, es, pt-BR).
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- TDD; `npm test` em `server/` e `web/`.
- Endpoint e headers EXATOS (validados por spike): `GET https://api.anthropic.com/api/oauth/usage`, `Authorization: Bearer <token>`, `anthropic-beta: oauth-2025-04-20`. Token de `~/.claude/.credentials.json` → `.claudeAiOauth.accessToken`.
- O token NUNCA sai do servidor.
- Janelas de ritmo: `session` = 5h / chunks de 20 min (15); `weekly` = 7 dias / chunks de 1h (168); grupo desconhecido = neutro.
- Qualquer falha do serviço → `[]` (card oculto), nunca erro na UI.

---

### Task 1: Serviço + rota `GET /api/usage` no servidor

**Files:**
- Create: `server/src/usage.ts`
- Create: `server/src/routes/usage.ts`
- Modify: `server/src/app.ts` (deps opcionais `usage`, registro condicional — padrão do `speech`)
- Modify: `server/src/index.ts` (cria o serviço e injeta)
- Test: `server/test/usage.test.ts`

**Interfaces:**
- Produces:
  - `interface UsageLimit { kind: string; group: string; label: string | null; percent: number; severity: string; resetsAt: string }`
  - `createUsageService(opts?: { credentialsPath?: string; endpoint?: string; fetchFn?: typeof fetch; cacheMs?: number }): { getLimits(): Promise<UsageLimit[]> }`
  - Rota `GET /api/usage` → `{ limits: UsageLimit[] }`.

- [ ] **Step 1: teste falhando**

Create `server/test/usage.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import { createUsageService } from '../src/usage.js'
import { registerUsageRoutes } from '../src/routes/usage.js'

/** Resposta real do endpoint (spike 2026-07-12), reduzida ao que importa. */
const API_RESPONSE = {
  limits: [
    { kind: 'session', group: 'session', percent: 10, severity: 'normal', resets_at: '2026-07-12T13:20:00Z', scope: null, is_active: false },
    { kind: 'weekly_all', group: 'weekly', percent: 43, severity: 'normal', resets_at: '2026-07-14T00:00:00Z', scope: null, is_active: false },
    { kind: 'weekly_scoped', group: 'weekly', percent: 48, severity: 'normal', resets_at: '2026-07-14T00:00:00Z', scope: { model: { id: null, display_name: 'Fable' }, surface: null }, is_active: true },
  ],
}

function makeCreds(): string {
  const dir = mkdtempSync(join(tmpdir(), 'creds-'))
  const path = join(dir, 'credentials.json')
  writeFileSync(path, JSON.stringify({ claudeAiOauth: { accessToken: 'tok-teste' } }))
  return path
}

const okFetch = () => vi.fn(async () => new Response(JSON.stringify(API_RESPONSE), { status: 200 })) as unknown as typeof fetch

describe('createUsageService', () => {
  it('normaliza os limits (label do scoped, resets_at → resetsAt)', async () => {
    const fetchFn = okFetch()
    const svc = createUsageService({ credentialsPath: makeCreds(), fetchFn })
    const limits = await svc.getLimits()
    expect(limits).toEqual([
      { kind: 'session', group: 'session', label: null, percent: 10, severity: 'normal', resetsAt: '2026-07-12T13:20:00Z' },
      { kind: 'weekly_all', group: 'weekly', label: null, percent: 43, severity: 'normal', resetsAt: '2026-07-14T00:00:00Z' },
      { kind: 'weekly_scoped', group: 'weekly', label: 'Fable', percent: 48, severity: 'normal', resetsAt: '2026-07-14T00:00:00Z' },
    ])
    // headers corretos
    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(String(url)).toBe('https://api.anthropic.com/api/oauth/usage')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-teste')
    expect((init.headers as Record<string, string>)['anthropic-beta']).toBe('oauth-2025-04-20')
  })

  it('cache: duas chamadas dentro do cacheMs fazem UM fetch', async () => {
    const fetchFn = okFetch()
    const svc = createUsageService({ credentialsPath: makeCreds(), fetchFn, cacheMs: 60_000 })
    await svc.getLimits()
    await svc.getLimits()
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('sem arquivo de credenciais → []', async () => {
    const svc = createUsageService({ credentialsPath: '/nao/existe.json', fetchFn: okFetch() })
    expect(await svc.getLimits()).toEqual([])
  })

  it('401 da API → []', async () => {
    const fetchFn = vi.fn(async () => new Response('{}', { status: 401 })) as unknown as typeof fetch
    const svc = createUsageService({ credentialsPath: makeCreds(), fetchFn })
    expect(await svc.getLimits()).toEqual([])
  })

  it('shape inesperado → []', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ nada: true }), { status: 200 })) as unknown as typeof fetch
    const svc = createUsageService({ credentialsPath: makeCreds(), fetchFn })
    expect(await svc.getLimits()).toEqual([])
  })

  it('erro de rede → [] (e não lança)', async () => {
    const fetchFn = vi.fn(async () => { throw new Error('offline') }) as unknown as typeof fetch
    const svc = createUsageService({ credentialsPath: makeCreds(), fetchFn })
    expect(await svc.getLimits()).toEqual([])
  })
})

describe('GET /api/usage', () => {
  it('devolve { limits } do serviço', async () => {
    const app = Fastify()
    await registerUsageRoutes(app, { usage: { getLimits: async () => [{ kind: 'session', group: 'session', label: null, percent: 10, severity: 'normal', resetsAt: 'x' }] } })
    const res = await app.inject({ method: 'GET', url: '/api/usage' })
    expect(res.statusCode).toBe(200)
    expect(res.json().limits).toHaveLength(1)
    await app.close()
  })
})
```

- [ ] **Step 2: rodar (falha)** — `cd server && npm test -- usage` → FAIL.

- [ ] **Step 3: implementar `usage.ts`**

Create `server/src/usage.ts`:
```ts
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Uma barra do /usage, normalizada para o front. */
export interface UsageLimit {
  kind: string
  group: string
  /** Nome vindo da API (ex.: "Fable" no weekly_scoped); null → o front rotula por kind. */
  label: string | null
  percent: number
  severity: string
  resetsAt: string
}

export interface UsageService { getLimits(): Promise<UsageLimit[]> }

interface Opts {
  credentialsPath?: string
  endpoint?: string
  fetchFn?: typeof fetch
  cacheMs?: number
}

/**
 * Proxy do endpoint OAuth de uso do Claude (o mesmo que alimenta o /usage do CLI).
 * Lê o token de ~/.claude/.credentials.json; qualquer falha vira [] — o card some.
 * O token nunca sai do servidor.
 */
export function createUsageService(opts: Opts = {}): UsageService {
  const credentialsPath = opts.credentialsPath ?? join(homedir(), '.claude', '.credentials.json')
  const endpoint = opts.endpoint ?? 'https://api.anthropic.com/api/oauth/usage'
  const fetchFn = opts.fetchFn ?? fetch
  const cacheMs = opts.cacheMs ?? 60_000
  let cache: { at: number; limits: UsageLimit[] } | null = null

  return {
    async getLimits(): Promise<UsageLimit[]> {
      if (cache && Date.now() - cache.at < cacheMs) return cache.limits
      const limits = await fetchLimits().catch(() => [])
      cache = { at: Date.now(), limits }
      return limits
    },
  }

  async function fetchLimits(): Promise<UsageLimit[]> {
    const creds = JSON.parse(readFileSync(credentialsPath, 'utf8')) as { claudeAiOauth?: { accessToken?: string } }
    const token = creds.claudeAiOauth?.accessToken
    if (!token) return []
    const res = await fetchFn(endpoint, {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
    })
    if (!res.ok) return []
    const body = (await res.json()) as { limits?: unknown }
    if (!Array.isArray(body.limits)) return []
    return body.limits.flatMap((raw) => {
      const l = raw as { kind?: string; group?: string; percent?: number; severity?: string; resets_at?: string; scope?: { model?: { display_name?: string } } | null }
      if (typeof l.kind !== 'string' || typeof l.percent !== 'number' || typeof l.resets_at !== 'string') return []
      return [{
        kind: l.kind,
        group: typeof l.group === 'string' ? l.group : 'unknown',
        label: l.scope?.model?.display_name ?? null,
        percent: l.percent,
        severity: typeof l.severity === 'string' ? l.severity : 'normal',
        resetsAt: l.resets_at,
      }]
    })
  }
}
```
Nota: falha em `fetchLimits` também é cacheada por 60s (evita marteladas quando offline) — comportamento intencional.

- [ ] **Step 4: implementar a rota + wiring**

Create `server/src/routes/usage.ts`:
```ts
import type { FastifyInstance } from 'fastify'
import type { UsageService } from '../usage.js'

export interface UsageRouteDeps { usage: Pick<UsageService, 'getLimits'> }

export async function registerUsageRoutes(app: FastifyInstance, deps: UsageRouteDeps): Promise<void> {
  app.get('/api/usage', async () => ({ limits: await deps.usage.getLimits() }))
}
```
Em `server/src/app.ts`: adicionar `usage?: Pick<UsageService, 'getLimits'>` aos deps e `if (deps.usage) await registerUsageRoutes(app, { usage: deps.usage })` (padrão do speech; LEIA o arquivo). Em `server/src/index.ts`: `const usage = createUsageService()` e passar no buildApp.

- [ ] **Step 5: rodar (passa)** — `npm test` inteiro + `npx tsc --noEmit` verdes.

- [ ] **Step 6: Commit**

```bash
git add server/src/usage.ts server/src/routes/usage.ts server/src/app.ts server/src/index.ts server/test/usage.test.ts
git commit -m "feat(usage): proxy do endpoint OAuth de uso (GET /api/usage, cache 60s)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Helpers de ritmo (`web/src/usage/pace.ts`)

**Files:**
- Create: `web/src/usage/pace.ts`
- Test: `web/src/test/pace.test.ts`

**Interfaces:**
- Produces:
  - `windowFor(group: string): { windowMs: number; chunkMs: number } | null` — session → {5h, 20min}; weekly → {7d, 1h}; outro → null.
  - `expectedPercent(resetsAt: string, windowMs: number, chunkMs: number, now: number): number`
  - `paceRatio(percent: number, expected: number): number`
  - `paceColor(ratio: number | null): string` — null → `var(--accent)`; ≤1 → `var(--ok)`; 1..2 → `hsl(H 70% 55%)` com H interpolado 140→0; ≥2 → `var(--err)`.

- [ ] **Step 1: teste falhando**

Create `web/src/test/pace.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { windowFor, expectedPercent, paceRatio, paceColor } from '../usage/pace'

const H = 3_600_000
const SESSION = { windowMs: 5 * H, chunkMs: H / 3 }   // 5h, chunks de 20min
const WEEKLY = { windowMs: 168 * H, chunkMs: H }       // 7d, chunks de 1h

describe('windowFor', () => {
  it('session → 5h/20min; weekly → 7d/1h; desconhecido → null', () => {
    expect(windowFor('session')).toEqual(SESSION)
    expect(windowFor('weekly')).toEqual(WEEKLY)
    expect(windowFor('mensal_do_futuro')).toBeNull()
  })
})

describe('expectedPercent (chunks decorridos / total, chunk atual conta cheio)', () => {
  // janela de sessão: reset daqui a 4h → 1h decorrida → 3 chunks de 20min / 15 = 20%
  const now = Date.parse('2026-07-12T10:00:00Z')
  const reset4h = new Date(now + 4 * H).toISOString()
  it('1h decorrida da sessão → 20%', () => {
    expect(expectedPercent(reset4h, SESSION.windowMs, SESSION.chunkMs, now)).toBeCloseTo(20, 5)
  })
  it('início da janela → 1º chunk conta cheio (1/15 ≈ 6,67%), sem explosão', () => {
    const resetQuaseCheio = new Date(now + 5 * H - 1000).toISOString() // 1s decorrido
    expect(expectedPercent(resetQuaseCheio, SESSION.windowMs, SESSION.chunkMs, now)).toBeCloseTo(100 / 15, 3)
  })
  it('resets_at no passado → clampa em 100', () => {
    const resetPassado = new Date(now - 1000).toISOString()
    expect(expectedPercent(resetPassado, SESSION.windowMs, SESSION.chunkMs, now)).toBe(100)
  })
  it('semana: 84h decorridas → 50%', () => {
    const reset84h = new Date(now + 84 * H).toISOString()
    expect(expectedPercent(reset84h, WEEKLY.windowMs, WEEKLY.chunkMs, now)).toBeCloseTo(50, 5)
  })
})

describe('paceRatio + paceColor (exemplos canônicos do usuário)', () => {
  it('10% usado com 20% esperado → razão 0,5 → verde', () => {
    const ratio = paceRatio(10, 20)
    expect(ratio).toBeCloseTo(0.5)
    expect(paceColor(ratio)).toBe('var(--ok)')
  })
  it('40% usado com 20% esperado → razão 2,0 → vermelho', () => {
    const ratio = paceRatio(40, 20)
    expect(ratio).toBeCloseTo(2)
    expect(paceColor(ratio)).toBe('var(--err)')
  })
  it('razão 1,5 → matiz intermediário (amarelo ~70°)', () => {
    expect(paceColor(1.5)).toBe('hsl(70 70% 55%)')
  })
  it('razão exatamente 1 → verde; null (grupo desconhecido) → accent', () => {
    expect(paceColor(1)).toBe('var(--ok)')
    expect(paceColor(null)).toBe('var(--accent)')
  })
  it('esperado 0 não acontece (chunk mínimo), mas por segurança razão vira Infinity → vermelho', () => {
    expect(paceColor(paceRatio(10, 0))).toBe('var(--err)')
  })
})
```

- [ ] **Step 2: rodar (falha)** e **implementar**

Create `web/src/usage/pace.ts`:
```ts
/** Ritmo de uso: a cor da barra diz se o ritmo atual estoura o limite antes do reset. */

const HOUR = 3_600_000

/** Janela e granularidade por grupo de limite. Grupo desconhecido → sem ritmo. */
export function windowFor(group: string): { windowMs: number; chunkMs: number } | null {
  if (group === 'session') return { windowMs: 5 * HOUR, chunkMs: HOUR / 3 } // 5h em chunks de 20min
  if (group === 'weekly') return { windowMs: 168 * HOUR, chunkMs: HOUR }    // 7d em chunks de 1h
  return null
}

/** % da janela que já passou, quantizado por chunks (o chunk atual conta cheio). */
export function expectedPercent(resetsAt: string, windowMs: number, chunkMs: number, now: number): number {
  const reset = Date.parse(resetsAt)
  const start = reset - windowMs
  const elapsed = now - start
  const totalChunks = Math.round(windowMs / chunkMs)
  const chunks = Math.min(totalChunks, Math.max(1, Math.ceil(elapsed / chunkMs)))
  return (chunks / totalChunks) * 100
}

/** usado ÷ esperado. >1 = gastando rápido demais para chegar ao reset. */
export function paceRatio(percent: number, expected: number): number {
  if (expected <= 0) return percent > 0 ? Infinity : 0
  return percent / expected
}

/** ≤1 verde; 1→2 degradê (matiz 140→0); ≥2 vermelho; null = sem ritmo (accent). */
export function paceColor(ratio: number | null): string {
  if (ratio === null) return 'var(--accent)'
  if (ratio <= 1) return 'var(--ok)'
  if (ratio >= 2) return 'var(--err)'
  const hue = Math.round(140 * (2 - ratio) - 0) // 1→140, 2→0
  return `hsl(${hue} 70% 55%)`
}
```
ATENÇÃO à conta do matiz: em razão 1,5 → `140 × 0,5 = 70` ✓ (o teste exige `hsl(70 70% 55%)`).

- [ ] **Step 3: rodar (passa)** — `npm test -- pace` PASS.

- [ ] **Step 4: Commit**

```bash
git add web/src/usage/pace.ts web/src/test/pace.test.ts
git commit -m "feat(usage): helpers de ritmo (janela por chunks, razão e cor)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: UsageCard na Sidebar

**Files:**
- Create: `web/src/components/UsageCard.tsx`
- Modify: `web/src/components/Sidebar.tsx` (renderiza acima do footer "Terminal Interaction")
- Modify: `web/src/api.ts` (`fetchUsage`)
- Modify: `web/src/i18n/{en,es,pt-BR}.ts` (bloco `usage`)
- Modify: `web/src/styles.css` (estilos do card/barras)
- Test: `web/src/test/usage-card.test.tsx`

**Interfaces:**
- Consumes: helpers da Task 2; `UsageLimit` (redeclarar o tipo em `web/src/api.ts` como `{ kind: string; group: string; label: string | null; percent: number; severity: string; resetsAt: string }`).
- Produces: `fetchUsage(): Promise<{ limits: UsageLimit[] }>`; componente `UsageCard()`.

- [ ] **Step 1: i18n** — novo bloco nas 3 línguas (membro raiz `usage`):
- en: `usage: { title: 'Usage', session: 'Current session', weeklyAll: 'All models', resets: 'resets {{when}}', pace: '{{percent}}% used · pace {{ratio}}× sustainable' },`
- es: `usage: { title: 'Uso', session: 'Sesión actual', weeklyAll: 'Todos los modelos', resets: 'reinicia {{when}}', pace: '{{percent}}% usado · ritmo {{ratio}}× sostenible' },`
- pt-BR: `usage: { title: 'Uso', session: 'Sessão atual', weeklyAll: 'Todos os modelos', resets: 'reseta {{when}}', pace: '{{percent}}% usado · ritmo {{ratio}}× do sustentável' },`

- [ ] **Step 2: teste falhando**

Create `web/src/test/usage-card.test.tsx`:
```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, waitFor } from '@testing-library/react'

const LIMITS = [
  { kind: 'session', group: 'session', label: null, percent: 10, severity: 'normal', resetsAt: new Date(Date.now() + 4 * 3_600_000).toISOString() },
  { kind: 'weekly_all', group: 'weekly', label: null, percent: 43, severity: 'normal', resetsAt: new Date(Date.now() + 36 * 3_600_000).toISOString() },
  { kind: 'weekly_scoped', group: 'weekly', label: 'Fable', percent: 48, severity: 'normal', resetsAt: new Date(Date.now() + 36 * 3_600_000).toISOString() },
]

vi.mock('../api', async (orig) => ({
  ...(await orig<typeof import('../api')>()),
  fetchUsage: vi.fn(async () => ({ limits: LIMITS })),
}))

import { UsageCard } from '../components/UsageCard'
import { fetchUsage } from '../api'

afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('UsageCard', () => {
  it('renderiza uma barra por limite com rótulos certos (i18n + label da API)', async () => {
    render(<UsageCard />)
    expect(await screen.findByText('Sessão atual')).toBeTruthy()
    expect(screen.getByText('Todos os modelos')).toBeTruthy()
    expect(screen.getByText('Fable')).toBeTruthy()
    expect(screen.getByText('10%')).toBeTruthy()
    expect(screen.getByText('48%')).toBeTruthy()
  })

  it('a barra tem width = percent e cor de ritmo', async () => {
    render(<UsageCard />)
    await screen.findByText('Sessão atual')
    const fills = document.querySelectorAll('.usage-bar__fill')
    expect(fills).toHaveLength(3)
    expect((fills[0] as HTMLElement).style.width).toBe('10%')
    // sessão: 10% usado, ~1h decorrida de 5h → razão < 1 → verde
    expect((fills[0] as HTMLElement).style.background).toContain('--ok')
  })

  it('sem limites → não renderiza nada', async () => {
    ;(fetchUsage as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ limits: [] })
    const { container } = render(<UsageCard />)
    await waitFor(() => expect(fetchUsage).toHaveBeenCalled())
    expect(container.firstChild).toBeNull()
  })
})
```

- [ ] **Step 3: rodar (falha)** e **implementar**

`web/src/api.ts`:
```ts
export interface UsageLimit {
  kind: string; group: string; label: string | null
  percent: number; severity: string; resetsAt: string
}
/** Barras do /usage via proxy local (o token OAuth fica no servidor). */
export const fetchUsage = () => req<{ limits: UsageLimit[] }>('/api/usage')
```
(Confira o helper `req` do arquivo e siga o padrão.)

Create `web/src/components/UsageCard.tsx`:
```tsx
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { fetchUsage, type UsageLimit } from '../api'
import { windowFor, expectedPercent, paceRatio, paceColor } from '../usage/pace'

const POLL_MS = 60_000

/** Rótulo: label da API (ex.: Fable) > i18n por kind > o próprio kind. */
function labelFor(l: UsageLimit, t: (k: string) => string): string {
  if (l.label) return l.label
  if (l.kind === 'session') return t('usage.session')
  if (l.kind === 'weekly_all') return t('usage.weeklyAll')
  return l.kind.replace(/_/g, ' ')
}

function resetText(resetsAt: string, locale: string): string {
  const d = new Date(resetsAt)
  return d.toLocaleString(locale, { weekday: 'short', hour: '2-digit', minute: '2-digit' })
}

export function UsageCard() {
  const { t, i18n } = useTranslation()
  const [limits, setLimits] = useState<UsageLimit[]>([])

  useEffect(() => {
    let alive = true
    const load = () => { fetchUsage().then((r) => { if (alive) setLimits(r.limits) }).catch(() => {}) }
    load()
    const timer = setInterval(load, POLL_MS)
    window.addEventListener('focus', load)
    return () => { alive = false; clearInterval(timer); window.removeEventListener('focus', load) }
  }, [])

  if (limits.length === 0) return null

  const now = Date.now()
  return (
    <div className="usage-card glass">
      <div className="eyebrow usage-card__title">{t('usage.title')}</div>
      {limits.map((l) => {
        const win = windowFor(l.group)
        const ratio = win ? paceRatio(l.percent, expectedPercent(l.resetsAt, win.windowMs, win.chunkMs, now)) : null
        const color = paceColor(ratio)
        const tip = ratio !== null
          ? t('usage.pace', { percent: l.percent, ratio: (Math.round(ratio * 10) / 10).toLocaleString(i18n.language) })
          : `${l.percent}%`
        return (
          <div key={l.kind + (l.label ?? '')} className="usage-row" title={tip}>
            <div className="usage-row__head">
              <span className="usage-row__label">{labelFor(l, t)}</span>
              <span className="usage-row__pct">{l.percent}%</span>
            </div>
            <div className="usage-bar">
              <div className="usage-bar__fill" style={{ width: `${Math.min(100, l.percent)}%`, background: color }} />
            </div>
            <div className="usage-row__reset">{t('usage.resets', { when: resetText(l.resetsAt, i18n.language) })}</div>
          </div>
        )
      })}
    </div>
  )
}
```

`web/src/components/Sidebar.tsx`: renderizar `<UsageCard />` imediatamente ANTES do bloco `.sidebar__footer` (LEIA o arquivo; import no topo).

`web/src/styles.css`:
```css
/* Card de uso (barras do /usage com cor de ritmo) */
.usage-card { border-radius: 12px; padding: 10px 12px; margin-top: auto; display: flex; flex-direction: column; gap: 8px; }
.usage-card__title { margin-bottom: 2px; }
.usage-row { display: flex; flex-direction: column; gap: 3px; }
.usage-row__head { display: flex; justify-content: space-between; font-size: 12px; }
.usage-row__label { color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.usage-row__pct { color: var(--text-dim); font-variant-numeric: tabular-nums; }
.usage-bar { height: 5px; border-radius: 999px; background: rgba(0,0,0,.3); overflow: hidden; }
.usage-bar__fill { height: 100%; border-radius: 999px; transition: width .4s ease, background .4s ease; }
.usage-row__reset { font-size: 10.5px; color: var(--text-dim); }
```
ATENÇÃO: o footer atual usa `margin-top: auto`? Se SIM, o `margin-top: auto` deve ficar no UsageCard (que agora é o primeiro elemento "de baixo") e o footer perde/mantém conforme o layout real — inspecione `.sidebar__footer` no CSS e ajuste para o card ficar colado ACIMA do footer sem quebrar o empurrão para o rodapé.

- [ ] **Step 4: rodar tudo (passa)** — `cd web && npm test` inteiro; `npx tsc --noEmit`; `npm run build` exit 0.

- [ ] **Step 5: Commit**

```bash
git add -A web
git commit -m "feat(usage): card de uso na sidebar com barras do /usage e cor de ritmo

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

## Smoke (controlador)

- `curl http://127.0.0.1:4832/api/usage` → limits reais (session/weekly_all/Fable).
- Browser: card na sidebar acima de "Terminal Interaction" com os números reais; cores coerentes com o ritmo real; tooltip; reset no fuso local.

## Self-Review (autor do plano)

- Spec coberto: proxy+cache+normalização+falha→[] (T1), ritmo com chunks e exemplos canônicos (T2), card dinâmico com rótulos i18n/API, poll+focus, oculto sem dados (T3). ✔
- Placeholders: nenhum; pontos dependentes de arquivo real (req do api.ts, footer da sidebar) têm instrução de leitura. ✔
- Tipos consistentes: `UsageLimit` idêntico em server/web; `windowFor/expectedPercent/paceRatio/paceColor` batem entre T2 e T3; `hsl(70 70% 55%)` na razão 1,5 consistente teste↔implementação. ✔
