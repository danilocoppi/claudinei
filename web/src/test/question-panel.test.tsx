import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import { QuestionPanel, answerOf } from '../components/QuestionPanel'
import { WsContext } from '../wsContext'
import type { PendingQuestion } from '../types'

const DUAS: PendingQuestion = { toolUseId: 'toolu_q_1', questions: [
  { question: 'Qual cor você prefere?', header: 'Cor', multiSelect: false,
    options: [{ label: 'Azul', description: 'Cor azul' }, { label: 'Verde', description: 'Cor verde' }] },
  { question: 'Quais frutas você gosta?', header: 'Frutas', multiSelect: true,
    options: [{ label: 'Maçã', description: 'Fruta vermelha' }, { label: 'Banana', description: 'Fruta amarela' }] },
] }
const UMA: PendingQuestion = { toolUseId: 'toolu_q_2', questions: [DUAS.questions[0]] }

const mount = (pending: PendingQuestion) => {
  const send = vi.fn()
  render(<WsContext.Provider value={{ send }}><QuestionPanel localId="s1" pending={pending} /></WsContext.Provider>)
  return send
}
const enviar = () => screen.getByRole('button', { name: /enviar respostas/i }) as HTMLButtonElement
afterEach(cleanup)

describe('QuestionPanel', () => {
  it('uma pergunta: sem abas, Enviar travado até escolher, e a escolha vai como answer_question', () => {
    const send = mount(UMA)
    expect(screen.queryByRole('tab')).toBeNull()
    expect(enviar().disabled).toBe(true)
    fireEvent.click(screen.getByLabelText(/Azul/))
    expect(enviar().disabled).toBe(false)
    fireEvent.click(enviar())
    expect(send).toHaveBeenCalledWith({ type: 'answer_question', localId: 's1', answers: { 'Qual cor você prefere?': 'Azul' } })
  })

  it('várias perguntas: abas com o header, ✓ na respondida, Enviar só com todas', () => {
    const send = mount(DUAS)
    const abas = screen.getAllByRole('tab')
    expect(abas.map((a) => a.textContent)).toEqual(['Cor', 'Frutas'])
    fireEvent.click(screen.getByLabelText(/Verde/))
    expect(abas[0].className).toContain('done')
    expect(enviar().disabled).toBe(true)
    fireEvent.click(abas[1])
    fireEvent.click(screen.getByLabelText(/Maçã/))
    fireEvent.click(screen.getByLabelText(/Banana/))
    expect(enviar().disabled).toBe(false)
    fireEvent.click(enviar())
    // múltipla escolha: rótulos separados por ", " — como a CLI faz
    expect(send).toHaveBeenCalledWith({ type: 'answer_question', localId: 's1',
      answers: { 'Qual cor você prefere?': 'Verde', 'Quais frutas você gosta?': 'Maçã, Banana' } })
  })

  it('"Outra resposta…" abre o campo e o texto digitado vira a resposta', () => {
    const send = mount(UMA)
    fireEvent.click(screen.getByLabelText(/outra resposta/i))
    const campo = screen.getByPlaceholderText(/escreva sua resposta/i)
    fireEvent.change(campo, { target: { value: 'Roxo, na verdade' } })
    fireEvent.keyDown(campo, { key: 'Enter' })
    expect(send).toHaveBeenCalledWith({ type: 'answer_question', localId: 's1', answers: { 'Qual cor você prefere?': 'Roxo, na verdade' } })
  })

  it('"Responder pelo chat" manda dismiss_question', () => {
    const send = mount(UMA)
    fireEvent.click(screen.getByRole('button', { name: /responder pelo chat/i }))
    expect(send).toHaveBeenCalledWith({ type: 'dismiss_question', localId: 's1' })
  })

  // Minor 5 do review final: `pending.questions` vem da engine — um array vazio
  // não pode derrubar o componente (guarda defensiva).
  it('questions vazio não quebra: o painel não renderiza nada', () => {
    const send = vi.fn()
    const { container } = render(
      <WsContext.Provider value={{ send }}>
        <QuestionPanel localId="s1" pending={{ toolUseId: 'vazio', questions: [] }} />
      </WsContext.Provider>,
    )
    expect(container.firstChild).toBeNull()
  })

  // Minor 6 do review final: a key das opções usava o rótulo — dois rótulos
  // iguais colidiam na reconciliação do React (aviso de key duplicada).
  it('opções com rótulos repetidos não geram aviso de key duplicada no React', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const repetido: PendingQuestion = { toolUseId: 'toolu_dup', questions: [
      { question: 'Qual?', header: 'Q', multiSelect: false,
        options: [{ label: 'Repetido', description: 'primeira' }, { label: 'Repetido', description: 'segunda' }] },
    ] }
    mount(repetido)
    const avisoDeKeyDuplicada = spy.mock.calls.some((args) => String(args[0]).includes('same key'))
    expect(avisoDeKeyDuplicada).toBe(false)
    spy.mockRestore()
  })

  it('answerOf: livre substitui na simples e soma na múltipla; vazio não conta', () => {
    expect(answerOf(undefined, false)).toBe('')
    expect(answerOf({ picked: new Set(['Azul']), other: '' }, false)).toBe('Azul')
    expect(answerOf({ picked: new Set(['__other__']), other: '  Roxo ' }, false)).toBe('Roxo')
    expect(answerOf({ picked: new Set(['__other__']), other: '   ' }, false)).toBe('')
    expect(answerOf({ picked: new Set(['Maçã', '__other__']), other: 'Uva' }, true)).toBe('Maçã, Uva')
    expect(answerOf({ picked: new Set(['Maçã', 'Banana']), other: '' }, true)).toBe('Maçã, Banana')
  })
})
