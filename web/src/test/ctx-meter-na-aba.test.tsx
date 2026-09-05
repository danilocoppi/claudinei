import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { EngineTabs } from '../components/EngineTabs'
import { useStore } from '../store'
import type { EngineMeta, SessionInfo } from '../types'

// Mesmo motivo do engine-tabs-overflow.test.ts para resolver o caminho (jsdom + URL).
const here = dirname(fileURLToPath(import.meta.url))
const ler = (p: string) => readFileSync(join(here, '..', p), 'utf8')
const css = ler('styles.css')
/** Os comentários do arquivo citam as próprias propriedades que os testes negam
 *  ("sem `overflow: hidden` de propósito"), então as asserções olham só o CSS. */
const semComentarios = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '')

const CLAUDE: EngineMeta = {
  id: 'claude', label: 'Claude Code', icon: 'claude',
  models: [''], efforts: ['auto'], permissions: [], slashSource: 'protocol', slashCommands: [],
}
const KIMI: EngineMeta = {
  id: 'kimi', label: 'Kimi Code', icon: '🌙',
  models: [''], efforts: [], permissions: [], slashSource: 'none', slashCommands: [],
}

const sess = (localId: string, engine: string, contextTokens?: number): SessionInfo =>
  ({ localId, projectId: 1, status: 'idle', engineSessionId: 'c', updatedAt: 'x', engine, contextTokens })

/** A aba (o .engine-tab) que contém aquele texto de rótulo. */
const abaDe = (rotulo: string): HTMLElement => {
  const el = screen.getByText(rotulo).closest('.engine-tab')
  if (!el) throw new Error(`sem aba para ${rotulo}`)
  return el as HTMLElement
}

beforeEach(() => { useStore.setState({ projects: [], chat: {}, unread: {}, streaming: {}, historyLoadedFor: {} }) })
afterEach(cleanup)

describe('o medidor de contexto mora na aba da engine dona dele', () => {
  it('renderiza dentro da .engine-tab, não solto ao lado da barra', () => {
    useStore.setState({ engines: [CLAUDE], sessions: { c1: sess('c1', 'claude', 86_000) } })
    const { container } = render(<EngineTabs projectId={1} activeLocalId="c1" />)
    const medidor = screen.getByTestId('ctx-meter')
    expect(abaDe('Claude Code').contains(medidor)).toBe(true)
    // e nenhum medidor pendurado fora das abas
    expect(container.querySelectorAll('.engine-tabs > .ctx-meter').length).toBe(0)
  })

  it('cada engine mostra o SEU número — era isto que o medidor único escondia', () => {
    // 86k/200k = 43% na Claude; 180k/200k = 90% na Kimi. Com um medidor só no
    // header, as duas abas pareciam compartilhar o número da sessão ativa.
    useStore.setState({
      engines: [CLAUDE, KIMI],
      sessions: { c1: sess('c1', 'claude', 86_000), k1: sess('k1', 'kimi', 180_000) },
    })
    render(<EngineTabs projectId={1} activeLocalId="c1" />)
    expect(abaDe('Claude Code').querySelector('.ctx-meter__pct')?.textContent).toBe('43%')
    expect(abaDe('Kimi Code').querySelector('.ctx-meter__pct')?.textContent).toBe('90%')
    // e o tom é o de cada uma, não um só para as duas
    expect(abaDe('Claude Code').querySelector('.ctx-meter')?.className).toContain('ctx-meter--ok')
    expect(abaDe('Kimi Code').querySelector('.ctx-meter')?.className).toContain('ctx-meter--danger')
  })

  it('engine sem dado (parser que não reporta usage) fica com a aba limpa', () => {
    useStore.setState({
      engines: [CLAUDE, KIMI],
      sessions: { c1: sess('c1', 'claude', 86_000), k1: sess('k1', 'kimi', undefined) },
    })
    render(<EngineTabs projectId={1} activeLocalId="c1" />)
    expect(abaDe('Kimi Code').querySelector('.ctx-meter')).toBeNull()
    expect(screen.getAllByTestId('ctx-meter').length).toBe(1)
  })

  it('saiu do header do chat e entrou na barra de engines', () => {
    expect(ler('components/EngineTabs.tsx')).toContain('<ContextMeter session={tabSession} />')
    expect(ler('components/ChatView.tsx')).not.toContain('ContextMeter')
  })
})

describe('o desenho do medidor dentro da aba', () => {
  // São DUAS regras `.engine-tab {}` no arquivo (a de uma linha com o flex e o
  // bloco): a busca junta as duas em vez de parar na primeira.
  const regraAba = semComentarios((css.match(/^\.engine-tab \{[^}]*\}/gm) ?? []).join('\n'))
  const regraTrilho = semComentarios(css.match(/^\.ctx-meter__rail \{[^}]*\}/m)?.[0] ?? '')

  it('a aba ancora o trilho sem recortar o anel de foco dos botões', () => {
    expect(regraAba).toMatch(/position:\s*relative/)
    expect(regraAba).not.toMatch(/overflow:\s*hidden/)
  })

  it('o trilho ocupa o fio de baixo da aba, recuado pela curva do canto', () => {
    // Encostado em left:0 um preenchimento pequeno cabia dentro do raio e sumia:
    // a 2% não aparecia trilho nenhum.
    expect(regraTrilho).toMatch(/position:\s*absolute/)
    expect(regraTrilho).toMatch(/bottom:\s*0/)
    expect(regraTrilho).toMatch(/left:\s*var\(--radius-md\)/)
    expect(regraTrilho).toMatch(/right:\s*var\(--radius-md\)/)
    expect(regraTrilho).toMatch(/pointer-events:\s*none/)
  })

  it('o numeral usa tabular-nums para a aba não tremer a cada turno', () => {
    const pct = css.match(/^\.ctx-meter__pct \{[^}]*\}/m)?.[0] ?? ''
    expect(pct).toMatch(/font-variant-numeric:\s*tabular-nums/)
  })

  it('o trilho perde a transição no reduzir-movimento, no bloco canônico', () => {
    // O arquivo mantém UM @media de prefers-reduced-motion: três testes casam
    // com o primeiro que encontram, então uma regra nova entra nele, não num novo.
    expect(css.match(/@media \(prefers-reduced-motion: reduce\)/g)?.length).toBe(1)
    const bloco = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\n\}/)?.[0] ?? ''
    expect(bloco).toMatch(/\.ctx-meter__rail > span \{ transition: none; \}/)
  })

  it('no celular o número sobrevive ao sumiço do status por extenso', () => {
    const mobile = css.slice(css.indexOf('@media (max-width: 768px)'))
    const bloco = mobile.slice(0, mobile.indexOf('\n}\n'))
    expect(bloco).toMatch(/\.engine-tab__status \{ display: none; \}/)
    expect(bloco).not.toMatch(/\.ctx-meter/)
  })
})
