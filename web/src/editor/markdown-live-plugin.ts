import { EditorView, Decoration, WidgetType, type DecorationSet } from '@codemirror/view'
import { RangeSetBuilder, StateField, type EditorState, type Extension } from '@codemirror/state'
import { markdownDecorations } from './markdown-live'

/** A tabela desenhada que ocupa o lugar do bloco de pipes. */
class TabelaWidget extends WidgetType {
  constructor(readonly celulas: string[][]) { super() }

  // Sem isto o CodeMirror recria a tabela a cada tecla digitada em qualquer
  // lugar do documento, e a rolagem pula.
  eq(outro: TabelaWidget): boolean {
    return JSON.stringify(this.celulas) === JSON.stringify(outro.celulas)
  }

  toDOM(): HTMLElement {
    const tabela = document.createElement('table')
    tabela.className = 'cm-md-table'
    const [cabecalho, ...corpo] = this.celulas
    const thead = tabela.createTHead().insertRow()
    for (const c of cabecalho ?? []) {
      const th = document.createElement('th')
      th.textContent = c
      thead.appendChild(th)
    }
    const tbody = tabela.createTBody()
    for (const linha of corpo) {
      const tr = tbody.insertRow()
      for (const c of linha) tr.insertCell().textContent = c
    }
    return tabela
  }

  // Clicar na tabela põe o cursor no texto por baixo dela, que é como se edita.
  ignoreEvent(): boolean { return false }
}

/**
 * A ponte entre a regra (markdown-live.ts, testada) e o CodeMirror.
 *
 * Recalcula quando o texto ou o cursor mudam — o cursor entra na conta porque
 * a linha em que ele está mostra a marcação crua, que é como se edita o que
 * está escondido no resto do documento.
 *
 * Vive num StateField, e não num ViewPlugin: a tabela é uma decoração de
 * BLOCO, e o CodeMirror recusa block decorations vindas de plugin
 * ("Block decorations may not be specified via plugins").
 */
function construir(state: EditorState): DecorationSet {
  const texto = state.doc.toString()
  const linhaDoCursor = state.doc.lineAt(state.selection.main.head).number - 1
  const builder = new RangeSetBuilder<Decoration>()
  // Ordem exigida pelo RangeSetBuilder: por posição e, na mesma posição, a
  // decoração de linha antes das de trecho.
  const decs = markdownDecorations(texto, linhaDoCursor)
    .slice()
    .sort((a, b) => a.from - b.from || Number(!!b.line) - Number(!!a.line) || a.to - b.to)
  for (const d of decs) {
    if (d.table) builder.add(d.from, d.to, Decoration.replace({ widget: new TabelaWidget(d.table), block: true }))
    else if (d.line) builder.add(d.from, d.from, Decoration.line({ class: d.class }))
    else if (d.hide) builder.add(d.from, d.to, Decoration.replace({}))
    else if (d.class) builder.add(d.from, d.to, Decoration.mark({ class: d.class }))
  }
  return builder.finish()
}

const campo = StateField.define<DecorationSet>({
  create: (state) => construir(state),
  update(valor, tr) {
    // Mover o cursor muda o que fica cru, então a seleção também recalcula.
    return tr.docChanged || tr.selection ? construir(tr.state) : valor
  },
  provide: (f) => EditorView.decorations.from(f),
})

/**
 * O que o cursor não pode atravessar: SÓ a tabela desenhada, que na tela não
 * tem posições intermediárias.
 *
 * Nunca o conjunto inteiro de decorações. Marcar negrito, código ou link como
 * atômico empurra o cursor para a borda do trecho, e clicar no meio de uma
 * palavra em negrito passa a cair antes dela.
 */
export function rangesAtomicos(state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const texto = state.doc.toString()
  const linhaDoCursor = state.doc.lineAt(state.selection.main.head).number - 1
  for (const d of markdownDecorations(texto, linhaDoCursor)) {
    if (d.table) builder.add(d.from, d.to, Decoration.replace({}))
  }
  return builder.finish()
}

export function livePreview(): Extension {
  return [campo, EditorView.atomicRanges.of((view) => rangesAtomicos(view.state))]
}
