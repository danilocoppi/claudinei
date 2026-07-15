import { describe, it, expect } from 'vitest'
import { lastUserTexts, historyStep } from '../chat/history'
import type { ChatItem } from '../types'

const u = (text: string, fromSubagent = false): ChatItem => ({ kind: 'user_text', text, fromSubagent })
const a = (text: string): ChatItem => ({ kind: 'assistant_text', text })

describe('lastUserTexts', () => {
  it('pega as últimas n mensagens do usuário, da mais antiga p/ a mais recente', () => {
    const items = [u('1'), a('x'), u('2'), u('3'), a('y'), u('4'), u('5'), u('6')]
    expect(lastUserTexts(items, 5)).toEqual(['2', '3', '4', '5', '6'])
  })
  it('ignora mensagens de subagente', () => {
    expect(lastUserTexts([u('a'), u('sub', true), u('b')], 5)).toEqual(['a', 'b'])
  })
  it('ignora o marcador de interrupção do CLI', () => {
    expect(lastUserTexts([u('real'), u('[Request interrupted by user]'), u('[Request interrupted by user for tool use]')], 5)).toEqual(['real'])
  })
  it('menos que n → devolve as que houver', () => {
    expect(lastUserTexts([u('só')], 5)).toEqual(['só'])
  })
  it('vazio → []', () => {
    expect(lastUserTexts([], 5)).toEqual([])
  })
})

describe('historyStep', () => {
  const list = ['a', 'b', 'c']
  it('up a partir de fora do modo (null) vai para a mais recente', () => {
    expect(historyStep(list, null, 'up')).toEqual({ index: 2, text: 'c' })
  })
  it('up sobe até a mais antiga e trava lá', () => {
    expect(historyStep(list, 1, 'up')).toEqual({ index: 0, text: 'a' })
    expect(historyStep(list, 0, 'up')).toEqual({ index: 0, text: 'a' })
  })
  it('down desce e além da mais recente sai do modo com texto vazio', () => {
    expect(historyStep(list, 0, 'down')).toEqual({ index: 1, text: 'b' })
    expect(historyStep(list, 2, 'down')).toEqual({ index: null, text: '' })
  })
  it('lista vazia → permanece fora do modo', () => {
    expect(historyStep([], null, 'up')).toEqual({ index: null, text: '' })
  })
})
