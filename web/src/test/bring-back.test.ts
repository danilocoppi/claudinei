import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { BRING_BACK_QUESTION_MAX, bringBack, bringBackFileName, bringBackText, lastAnswer } from '../branch/bringBack'
import { useSideStore } from '../branch/sideStore'
import type { ChatItem } from '../types'

/**
 * Trazer de volta: a última resposta da conversa lateral vai para o fim do campo
 * da principal, com a pergunta que a originou. Grande demais para o campo (a
 * régua do colar, `paste.ts`), vira o anexo `lateral-HHMMSS.md`.
 */

const user = (text: string): ChatItem => ({ kind: 'user_text', text })
const agent = (text: string): ChatItem => ({ kind: 'assistant_text', text })
/** O jsdom não tem `Blob.text()`. */
const ler = (f: Blob) => new Promise<string>((ok) => { const fr = new FileReader(); fr.onload = () => ok(fr.result as string); fr.readAsText(f) })

beforeEach(() => { useSideStore.setState({ sides: {}, replaceAsk: null, appendRequest: null }) })
afterEach(() => { vi.restoreAllMocks() })

describe('lastAnswer', () => {
  it('o último texto do agente depois da última mensagem do operador', () => {
    const items: ChatItem[] = [
      user('primeira'), agent('resposta velha'),
      user('segunda'), agent('pensando alto'),
      { kind: 'tool_call', id: 't1', name: 'Read', input: { file_path: '/a' }, result: 'x' },
      agent('resposta final'),
    ]
    expect(lastAnswer(items)).toEqual({ question: 'segunda', answer: 'resposta final' })
  })

  it('sem resposta depois da última pergunta: null', () => {
    expect(lastAnswer([user('primeira'), agent('resposta'), user('segunda')])).toBeNull()
    expect(lastAnswer([])).toBeNull()
  })

  it('erro da API, texto de subagente e mensagem injetada pelo motor não contam', () => {
    const items: ChatItem[] = [
      user('pergunta'), agent('a resposta'),
      { kind: 'user_text', text: 'resumo', fromEngine: true },
      { kind: 'assistant_text', text: 'do subagente', fromSubagent: true, parentId: 'p' },
      { kind: 'assistant_text', text: 'API Error: 500', isApiError: true },
    ]
    expect(lastAnswer(items)).toEqual({ question: 'pergunta', answer: 'a resposta' })
  })

  it('lateral aberta sem pergunta (/btw sozinho): pergunta null', () => {
    expect(lastAnswer([agent('contexto recebido')])).toEqual({ question: null, answer: 'contexto recebido' })
  })
})

describe('bringBackText', () => {
  it('o formato: Da conversa lateral («pergunta»):\\ntexto', () => {
    expect(bringBackText('por que falhou?', 'faltou o import')).toBe('Da conversa lateral («por que falhou?»):\nfaltou o import')
  })

  it('pergunta acima de 80 caracteres termina em "…"', () => {
    const q = 'a'.repeat(100)
    const out = bringBackText(q, 'r')
    const dentro = /«(.*)»/u.exec(out)![1]
    expect(dentro.endsWith('…')).toBe(true)
    expect(Array.from(dentro)).toHaveLength(BRING_BACK_QUESTION_MAX)
    // Exatamente 80 cabe inteira.
    expect(bringBackText('b'.repeat(80), 'r')).toBe(`Da conversa lateral («${'b'.repeat(80)}»):\nr`)
  })

  it('a pergunta fica numa linha; sem pergunta, só o rótulo', () => {
    expect(bringBackText('linha 1\n  linha 2', 'r')).toBe('Da conversa lateral («linha 1 linha 2»):\nr')
    expect(bringBackText(null, 'r')).toBe('Da conversa lateral:\nr')
  })
})

describe('bringBackFileName', () => {
  it('lateral-HHMMSS.md, na hora local', () => {
    expect(bringBackFileName(new Date(2026, 10, 21, 9, 5, 7))).toBe('lateral-090507.md')
  })
})

describe('bringBack', () => {
  it('texto pequeno vai direto ao campo', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    await bringBack('c1', [user('pergunta'), agent('resposta')])
    expect(fetch).not.toHaveBeenCalled()
    expect(useSideStore.getState().appendRequest).toEqual(expect.objectContaining({
      localId: 'c1', text: 'Da conversa lateral («pergunta»):\nresposta', attachments: [],
    }))
  })

  it('resposta com 101 linhas vira anexo lateral-HHMMSS.md e o campo recebe o token', async () => {
    const answer = Array.from({ length: 101 }, (_, i) => `linha ${i + 1}`).join('\n')
    let enviado: File | null = null
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      enviado = (init!.body as FormData).get('file') as File
      return new Response(JSON.stringify({ path: `/ups/${enviado.name}`, name: enviado.name }), { status: 201, headers: { 'Content-Type': 'application/json' } })
    })
    await bringBack('c1', [user('pergunta'), agent(answer)])
    expect(enviado!.name).toMatch(/^lateral-\d{6}\.md$/)
    expect(await ler(enviado!)).toBe(`Da conversa lateral («pergunta»):\n${answer}`)
    const tok = `[📎 ${enviado!.name}]`
    expect(useSideStore.getState().appendRequest).toEqual(expect.objectContaining({
      localId: 'c1', text: tok, attachments: [[tok, `/ups/${enviado!.name}`]],
    }))
  })

  it('acima de 10 240 bytes também vira anexo', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ path: '/ups/x.md', name: 'x.md' }), { status: 201, headers: { 'Content-Type': 'application/json' } }))
    await bringBack('c1', [user('p'), agent('é'.repeat(6000))])
    expect(spy).toHaveBeenCalledWith('/api/uploads', expect.objectContaining({ method: 'POST' }))
    expect(useSideStore.getState().appendRequest?.text).toBe('[📎 x.md]')
  })

  it('falha no upload: rejeita e nada vai ao campo', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ error: 'disco cheio' }), { status: 500, headers: { 'Content-Type': 'application/json' } }))
    await expect(bringBack('c1', [user('p'), agent('x\n'.repeat(200))])).rejects.toThrow('disco cheio')
    expect(useSideStore.getState().appendRequest).toBeNull()
  })

  it('sem resposta: nada acontece', async () => {
    await bringBack('c1', [user('p')])
    expect(useSideStore.getState().appendRequest).toBeNull()
  })
})
