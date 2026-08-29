import { describe, it, expect } from 'vitest'
import { applyMention, filterTerminals, marcaDe, mentionAt } from '../mentions'

/**
 * `@@` referencia outro terminal pelo NOME — e tem de ser o nome EXATO.
 *
 * Não é escolha estética: `dispatch_task` e `ask_agent` recebem `project: string`,
 * e o servidor resolve por comparação exata (ignorando maiúsculas) contra a lista
 * de projetos. Qualquer outra coisa vira `project "..." does not exist` na mão do
 * agente — que era justamente a subjetividade que esta tela veio remover.
 */
describe('o gatilho @@', () => {
  it('abre quando os dois arrobas acabam de ser digitados', () => {
    expect(mentionAt('peça para @@', 12)).toBe(10)
    expect(mentionAt('@@', 2)).toBe(0)
  })

  it('não abre com um arroba só', () => {
    expect(mentionAt('peça para @', 11)).toBeNull()
  })

  /** Colar um e-mail ou digitar no meio de uma palavra não convoca a lista. */
  it('não abre grudado numa palavra', () => {
    expect(mentionAt('fulano@@dominio', 8)).toBeNull()
    expect(mentionAt('x@@', 3)).toBeNull()
  })

  it('abre depois de abre-parênteses e colchete', () => {
    expect(mentionAt('(@@', 3)).toBe(1)
    expect(mentionAt('[@@', 3)).toBe(1)
  })

  /** O cursor manda: `@@` mais atrás no texto não abre nada. */
  it('só vale imediatamente antes do cursor', () => {
    expect(mentionAt('a @@ b', 6)).toBeNull()
    expect(mentionAt('a @@ b', 4)).toBe(2)
  })
})

describe('a referência escrita no texto', () => {
  /** Delimitada porque nome de terminal tem espaço: sem os colchetes, "peça para
   *  @Vaexa - Admin revisar" não diz onde o nome acaba. */
  it('vem entre colchetes, com o nome exato', () => {
    expect(marcaDe('Vaexa - Admin')).toBe('@[Vaexa - Admin]')
  })

  it('troca o gatilho pela referência e deixa o cursor depois dela', () => {
    const r = applyMention('peça para @@', 12, 'Vaexa - Admin')
    expect(r.text).toBe('peça para @[Vaexa - Admin] ')
    expect(r.cursor).toBe(r.text.length)
  })

  it('preserva o que vinha depois do cursor', () => {
    const r = applyMention('peça para @@ revisar', 12, 'API')
    expect(r.text).toBe('peça para @[API]  revisar')
    expect(r.text.slice(r.cursor)).toBe(' revisar')
  })

  it('sem gatilho, não mexe em nada', () => {
    expect(applyMention('texto solto', 11, 'API')).toEqual({ text: 'texto solto', cursor: 11 })
  })
})

describe('a busca da lista', () => {
  const terminais = [
    { name: 'Vaexa - Admin' }, { name: 'Vaexa - Frontend' },
    { name: 'Sessão de Testes' }, { name: 'API' },
  ]

  it('sem busca, devolve tudo', () => {
    expect(filterTerminals(terminais, '  ')).toHaveLength(4)
  })

  it('acha por pedaço do nome, sem ligar para a caixa', () => {
    expect(filterTerminals(terminais, 'vaexa').map((t) => t.name))
      .toEqual(['Vaexa - Admin', 'Vaexa - Frontend'])
  })

  /** Sem isto, o campo só serviria para quem já sabe escrever o nome com acento. */
  it('acha sem acento', () => {
    expect(filterTerminals(terminais, 'sessao')).toMatchObject([{ name: 'Sessão de Testes' }])
  })

  /** Quem lembra as duas palavras não deveria precisar lembrar a ordem delas. */
  it('aceita os pedaços em qualquer ordem', () => {
    expect(filterTerminals(terminais, 'admin vaexa')).toMatchObject([{ name: 'Vaexa - Admin' }])
  })

  it('sem acerto, devolve vazio', () => {
    expect(filterTerminals(terminais, 'inexistente')).toEqual([])
  })
})
