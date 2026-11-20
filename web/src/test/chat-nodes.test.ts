import { describe, it, expect } from 'vitest'
import { groupActions } from '../chat/grouping'
import { FIRST_INDEX, nodeIndexOfItem, nodeKey, prependedNodes } from '../chat/nodes'
import type { ChatItem } from '../types'

const fala = (key: string): ChatItem => ({ kind: 'assistant_text', text: key, key })
const pedido = (key: string): ChatItem => ({ kind: 'user_text', text: key, key })
const acao = (key: string): ChatItem => ({ kind: 'tool_call', id: key, name: 'Bash', input: {}, key })

describe('chave de nó da lista virtual', () => {
  it('mensagem usa a chave do item; grupo, g: + a chave do primeiro item', () => {
    const nodes = groupActions([pedido('p10'), acao('p20'), acao('p30'), acao('p40'), fala('p50')], false)
    expect(nodes.map(nodeKey)).toEqual(['p10', 'g:p20', 'p50'])
  })

  it('item sem chave cai no índice', () => {
    const nodes = groupActions([{ kind: 'assistant_text', text: 'x' }], false)
    expect(nodeKey(nodes[0])).toBe('i0')
  })

  it('FIRST_INDEX deixa espaço para muitas páginas acima', () => {
    expect(FIRST_INDEX).toBe(1_000_000)
  })
})

describe('nós acrescentados no topo', () => {
  it('conta nós, não itens: página antiga que termina em ações funde com o grupo do topo', () => {
    // Na tela: um grupo de ações no topo. A página antiga termina em ações, que
    // entram no MESMO grupo: entraram 3 itens, mas só 1 nó (o pedido).
    const atual = [acao('p40'), acao('p50'), acao('p60'), fala('p70')]
    const antes = groupActions(atual, false)
    const depois = groupActions([pedido('p10'), acao('p20'), acao('p30'), ...atual], false)
    expect(depois.map(nodeKey)).toEqual(['p10', 'g:p20', 'p70'])
    expect(prependedNodes(antes, depois)).toBe(1)
    // O item que estava no topo continua no nó de mesmo índice absoluto.
    expect(nodeIndexOfItem(depois, 'p40') - prependedNodes(antes, depois)).toBe(nodeIndexOfItem(antes, 'p40'))
  })

  it('sem fusão, conta os nós novos', () => {
    const atual = [pedido('p40'), fala('p50')]
    const depois = [pedido('p10'), fala('p20'), pedido('p30'), ...atual]
    expect(prependedNodes(groupActions(atual, false), groupActions(depois, false))).toBe(3)
  })

  it('mudança no fim não desloca', () => {
    const atual = [pedido('p10'), fala('p20')]
    expect(prependedNodes(groupActions(atual, false), groupActions([...atual, fala('p30')], false))).toBe(0)
  })

  it('lista trocada inteira (outra conversa) não desloca', () => {
    expect(prependedNodes(groupActions([pedido('p10')], false), groupActions([pedido('p99')], false))).toBe(0)
  })

  it('lista vazia antes ou depois não desloca', () => {
    expect(prependedNodes([], groupActions([pedido('p10')], false))).toBe(0)
    expect(prependedNodes(groupActions([pedido('p10')], false), [])).toBe(0)
  })
})
