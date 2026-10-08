import { describe, expect, it } from 'vitest'
import { folderSlug } from '../folderName'

describe('folderSlug — o nome de pasta sugerido a partir do nome do terminal', () => {
  it('minúsculas, sem acento, palavras ligadas por hífen', () => {
    expect(folderSlug('Meu App')).toBe('meu-app')
    expect(folderSlug('AlFinex - Backend')).toBe('alfinex-backend')
    expect(folderSlug('Ação Crítica!')).toBe('acao-critica')
  })
  it('mantém ponto e sublinhado do meio, mas nada que suba de pasta', () => {
    expect(folderSlug('api_v2.1')).toBe('api_v2.1')
    expect(folderSlug('../fora')).toBe('fora')
    expect(folderSlug('   ')).toBe('')
  })
})
