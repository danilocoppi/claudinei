import { describe, it, expect } from 'vitest'
import { expandQuery, normalizeTerm, VOCABULARY } from '../src/icons/vocabulary.js'

/**
 * O buraco que este dicionário tapa foi MEDIDO: entre os 250 mil ícones do
 * Iconify, "cliente", "financeiro", "pagamento", "relatório" e "produção" devolvem
 * ZERO — ninguém no mundo batiza um ícone em português, e "backend" não é desenho
 * de nada. Quantidade de acervo não resolve isso; vocabulário resolve.
 */
describe('normalização do termo', () => {
  it('tira acento, caixa e espaço de sobra', () => {
    expect(normalizeTerm('  Segurança ')).toBe('seguranca')
    expect(normalizeTerm('RELATÓRIO')).toBe('relatorio')
    expect(normalizeTerm('Produção')).toBe('producao')
  })

  /** Quem digita acentuado e quem digita sem acento procuram a mesma coisa. */
  it('acentuado e sem acento caem na mesma entrada', () => {
    expect(expandQuery('segurança')).toEqual(expandQuery('seguranca'))
  })
})

describe('expansão de busca', () => {
  it('a palavra digitada continua sendo a primeira tentativa', () => {
    expect(expandQuery('backend')[0]).toBe('backend')
  })

  /** As palavras exatas que ele reclamou — cada uma tem que virar desenho. */
  it('traduz o vocabulário de quem trabalha para o de quem desenha', () => {
    expect(expandQuery('backend')).toContain('server')
    expect(expandQuery('frontend')).toContain('browser')
    expect(expandQuery('admin')).toContain('shield')
    expect(expandQuery('master')).toContain('crown')
    expect(expandQuery('site')).toContain('globe')
    expect(expandQuery('financeiro')).toContain('wallet')
    expect(expandQuery('cliente')).toContain('users')
    expect(expandQuery('pagamento')).toContain('credit-card')
    expect(expandQuery('relatorio')).toContain('chart-bar')
    expect(expandQuery('loja')).toContain('store')
  })

  /**
   * "banco" é banco de dados E banco financeiro, e não dá para adivinhar qual.
   * O dicionário devolve os dois: quem procura reconhece o seu num relance.
   */
  it('palavra ambígua devolve os dois sentidos', () => {
    const banco = expandQuery('banco')
    expect(banco).toContain('database')
    expect(banco).toContain('building-bank')
  })

  it('plural cai no singular (ninguém cadastra as duas formas)', () => {
    expect(expandQuery('clientes')).toContain('users')
    expect(expandQuery('relatorios')).toContain('chart-bar')
  })

  it('palavra que não está no dicionário passa intacta', () => {
    expect(expandQuery('xyzzy')).toEqual(['xyzzy'])
  })

  it('busca vazia não vira busca por nada', () => {
    expect(expandQuery('   ')).toEqual([])
  })

  /** Cada consulta extra é uma ida à API: o leque tem que ter fundo. */
  it('o leque é limitado — não são 20 requisições por letra digitada', () => {
    for (const term of Object.keys(VOCABULARY)) {
      expect(expandQuery(term).length, term).toBeLessThanOrEqual(5)
    }
  })
})

describe('o dicionário em si', () => {
  it('cobre as duas línguas que ele digita', () => {
    for (const w of ['deploy', 'backend', 'security', 'payment', 'seguranca', 'pagamento', 'financeiro']) {
      expect(VOCABULARY[w], w).toBeTruthy()
    }
  })

  /** Sinônimo que não é nome de ícone em lugar nenhum é ida à API desperdiçada. */
  it('os sinônimos são palavras de desenho, não frases', () => {
    for (const [term, list] of Object.entries(VOCABULARY)) {
      expect(list.length, term).toBeGreaterThan(0)
      for (const s of list) expect(s, `${term} → ${s}`).toMatch(/^[a-z0-9-]+$/)
    }
  })

  it('nenhuma entrada aponta para si mesma (consulta repetida)', () => {
    for (const [term, list] of Object.entries(VOCABULARY)) {
      expect(list, term).not.toContain(term)
    }
  })
})
