import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { AssistantMarkdown } from '../components/MessageBlock'
import { useStore } from '../store'

const PATH = 'docs/superpowers/plans/2026-08-13-pre-requisitos-sessao.md'

/** O path já resolvido (existe e no escopo) — é o que libera o link. */
const resolved = () => ({
  [PATH]: { path: PATH, exists: true, inScope: true, kind: 'text' as const },
})

beforeEach(() => {
  useStore.setState({
    sessions: {}, projects: [], chat: {}, unread: {}, streaming: {}, historyLoadedFor: {},
    fileResolved: resolved() as never,
  })
})
afterEach(() => cleanup())

describe('link de arquivo em TÍTULO', () => {
  it('vira link em parágrafo com código inline (referência)', () => {
    const { container } = render(<AssistantMarkdown text={`Pronto: \`${PATH}\``} />)
    expect(container.querySelector('a.file-link')).toBeTruthy()
  })

  it('vira link também dentro de um título', () => {
    const { container } = render(<AssistantMarkdown text={`## O Plano 0 está pronto: \`${PATH}\``} />)
    expect(container.querySelector('h2')).toBeTruthy()
    expect(container.querySelector('a.file-link')).toBeTruthy()
  })

  it('vira link em título sem código inline', () => {
    const { container } = render(<AssistantMarkdown text={`## Plano: ${PATH}`} />)
    expect(container.querySelector('a.file-link')).toBeTruthy()
  })
})
