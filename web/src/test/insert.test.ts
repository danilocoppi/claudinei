import { describe, it, expect } from 'vitest'
import { mergeTranscript } from '../speech/insert'

describe('mergeTranscript', () => {
  it('insere entre before e after com espaço quando before não termina em espaço', () => {
    expect(mergeTranscript('olá', ' fim', 'mundo')).toBe('olá mundo fim')
  })
  it('não duplica espaço quando before já termina em espaço', () => {
    expect(mergeTranscript('olá ', '', 'mundo')).toBe('olá mundo')
  })
  it('before vazio → sem espaço à esquerda', () => {
    expect(mergeTranscript('', '', 'mundo')).toBe('mundo')
  })
  it('before terminando em quebra de linha → sem espaço extra', () => {
    expect(mergeTranscript('linha\n', '', 'mundo')).toBe('linha\nmundo')
  })
})
