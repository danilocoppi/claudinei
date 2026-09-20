import { EditorView, Decoration, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { RangeSetBuilder, type Extension } from '@codemirror/state'
import { markdownDecorations } from './markdown-live'

/**
 * A ponte entre a regra (markdown-live.ts, testada) e o CodeMirror.
 *
 * Recalcula quando o texto ou o cursor mudam — o cursor entra na conta porque
 * a linha em que ele está mostra a marcação crua, que é como se edita o que
 * está escondido no resto do documento.
 */
function construir(view: EditorView): DecorationSet {
  const texto = view.state.doc.toString()
  const linhaDoCursor = view.state.doc.lineAt(view.state.selection.main.head).number - 1
  const builder = new RangeSetBuilder<Decoration>()
  const decs = markdownDecorations(texto, linhaDoCursor)
    .slice()
    .sort((a, b) => a.from - b.from || a.to - b.to)
  for (const d of decs) {
    if (d.hide) builder.add(d.from, d.to, Decoration.replace({}))
    else if (d.class) builder.add(d.from, d.to, Decoration.mark({ class: d.class }))
  }
  return builder.finish()
}

export function livePreview(): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) { this.decorations = construir(view) }
      update(u: ViewUpdate) {
        if (u.docChanged || u.selectionSet || u.viewportChanged) this.decorations = construir(u.view)
      }
    },
    { decorations: (v) => v.decorations },
  )
}
