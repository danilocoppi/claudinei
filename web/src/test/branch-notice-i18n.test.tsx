import { describe, it, expect, afterAll, afterEach } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'
import i18n from '../i18n'
import { applyEvent } from '../chat/applyEvent'
import { MessageBlock } from '../components/MessageBlock'

/**
 * Os avisos que o ramificar põe no chat (`message_error` com `i18nKey`) aparecem
 * na língua da interface; sem chave, o texto do servidor como veio.
 */
const evento = (raw: object) => ({ kind: 'system', subtype: 'message_error', raw }) as never

afterEach(() => cleanup())
afterAll(async () => { await i18n.changeLanguage('pt-BR') })

describe('aviso do ramificar no chat', () => {
  it('applyEvent leva a chave e os parâmetros ao item', () => {
    const [item] = applyEvent([], evento({ message: 'texto pt', i18nKey: 'branch.notice.requeued', i18nParams: { reasonCode: 'shutdown', reason: 'x', count: 2 } }))
    expect(item).toMatchObject({ kind: 'command_output', text: 'texto pt', isError: true, i18n: { key: 'branch.notice.requeued', params: { reasonCode: 'shutdown', count: 2 } } })
  })

  it('em inglês: a fila, o motivo fixo traduzido; o erro do motor como veio; sem chave, o texto do servidor', async () => {
    await i18n.changeLanguage('en')
    const [a] = applyEvent([], evento({ message: 'pt', i18nKey: 'branch.notice.requeued', i18nParams: { reasonCode: 'shutdown', reason: 'o Claudinei foi encerrado', count: 2 } }))
    const [b] = applyEvent([], evento({ message: 'pt', i18nKey: 'branch.notice.undelivered', i18nParams: { reason: 'engine said no', text: 'my question' } }))
    const [c] = applyEvent([], evento({ message: 'aviso antigo em português' }))
    render(<><MessageBlock item={a} /><MessageBlock item={b} /><MessageBlock item={c} /></>)
    expect(screen.getByText('2 messages were not delivered (Claudinei shut down) and went back to this terminal\'s queue, paused: check them and resume when you want.')).toBeTruthy()
    expect(screen.getByText(/Message not delivered \(engine said no\)\. Copy the text below/)).toBeTruthy()
    expect(screen.getByText(/my question/)).toBeTruthy()
    expect(screen.getByText('aviso antigo em português')).toBeTruthy()
  })
})
