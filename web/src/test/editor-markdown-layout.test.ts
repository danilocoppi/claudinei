import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EditorState } from '@codemirror/state'
import { rangesAtomicos } from '../editor/markdown-live-plugin'

const folha = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'styles.css'), 'utf8')

/**
 * As classes que o live preview aplica à LINHA inteira. Margem vertical em
 * qualquer uma delas desalinha o clique: o CodeMirror mede a altura da linha
 * pelo bloco, e margem não entra nessa conta — o mapa de alturas fica menor
 * que a tela e clicar numa linha põe o cursor na linha de baixo.
 */
const CLASSES_DE_LINHA = [
  'cm-md-h1', 'cm-md-h2', 'cm-md-h3', 'cm-md-h4', 'cm-md-h5', 'cm-md-h6',
  'cm-md-list', 'cm-md-ol', 'cm-md-quote', 'cm-md-codeblock', 'cm-md-fence', 'cm-md-rule',
]

/** Os corpos de regra em que a classe aparece no seletor. */
function corposDaClasse(classe: string): string[] {
  const out: string[] = []
  const re = new RegExp(`(^|[},])([^{}]*\\.${classe}\\b[^{}]*)\\{([^}]*)\\}`, 'g')
  for (let m = re.exec(folha); m; m = re.exec(folha)) out.push(m[3])
  return out
}

describe('estilo de linha do editor markdown', () => {
  it('nenhuma classe de linha usa margem vertical (o clique cairia na linha errada)', () => {
    const infratores = CLASSES_DE_LINHA.flatMap((c) =>
      corposDaClasse(c)
        .filter((corpo) => /(^|[;\s])margin(-top|-bottom)?\s*:/.test(corpo))
        .map((corpo) => `${c} → ${corpo.trim()}`),
    )
    expect(infratores, 'use padding: o CodeMirror não conta margem na altura da linha').toEqual([])
  })

  it('as classes de linha existem na folha (o teste acima não passa por engano)', () => {
    for (const c of CLASSES_DE_LINHA) expect(corposDaClasse(c).length, c).toBeGreaterThan(0)
  })
})

const DOC = [
  '# Titulo',
  '',
  'Texto com **negrito** e `codigo`.',
  '',
  '| a | b |',
  '| --- | --- |',
  '| 1 | 2 |',
].join('\n')

/** Os ranges atômicos como pares [from,to). */
function atomicos(doc: string, cursorEm = 0): [number, number][] {
  const state = EditorState.create({ doc, selection: { anchor: cursorEm } })
  const out: [number, number][] = []
  rangesAtomicos(state).between(0, doc.length, (from, to) => { out.push([from, to]) })
  return out
}

describe('ranges atômicos do editor markdown', () => {
  it('só a tabela é atômica — negrito e código continuam clicáveis por dentro', () => {
    const inicioDaTabela = DOC.indexOf('| a | b |')
    expect(atomicos(DOC)).toEqual([[inicioDaTabela, DOC.length]])
  })

  it('sem tabela, nada é atômico', () => {
    expect(atomicos('Texto com **negrito** e `codigo`.')).toEqual([])
  })

  it('com o cursor dentro da tabela, ela deixa de ser atômica (está sendo editada)', () => {
    expect(atomicos(DOC, DOC.indexOf('| 1 | 2 |') + 3)).toEqual([])
  })
})
