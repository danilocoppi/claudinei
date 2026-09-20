import { useEffect, useRef } from 'react'
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView, keymap, highlightActiveLine } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'
import { markdown } from '@codemirror/lang-markdown'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { livePreview } from '../editor/markdown-live-plugin'

export type EditorLang = 'markdown' | 'html' | 'javascript' | null

function extensoesDaLinguagem(lang: EditorLang): Extension[] {
  if (lang === 'markdown') return [markdown(), livePreview()]
  if (lang === 'html') return [html()]
  if (lang === 'javascript') return [javascript({ typescript: true })]
  return []
}

/**
 * Casca fina sobre o CodeMirror. Monta a view UMA vez: recriar a cada render
 * jogaria fora cursor, rolagem e histórico de desfazer. `value` só volta para
 * dentro quando difere do que está no editor — o caso real é o "recarregar"
 * depois de um conflito.
 */
export function CodeEditor({ value, lang, onChange, onSave }: {
  value: string
  lang: EditorLang
  onChange: (v: string) => void
  onSave: () => void
}) {
  const host = useRef<HTMLDivElement | null>(null)
  const view = useRef<EditorView | null>(null)
  const aoMudar = useRef(onChange)
  const aoSalvar = useRef(onSave)
  aoMudar.current = onChange
  aoSalvar.current = onSave

  useEffect(() => {
    if (!host.current) return
    const state = EditorState.create({
      doc: value,
      extensions: [
        history(),
        highlightActiveLine(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        keymap.of([
          { key: 'Mod-s', preventDefault: true, run: () => { aoSalvar.current(); return true } },
          ...historyKeymap,
          ...defaultKeymap,
        ]),
        EditorView.lineWrapping,
        EditorView.updateListener.of((u) => { if (u.docChanged) aoMudar.current(u.state.doc.toString()) }),
        ...extensoesDaLinguagem(lang),
      ],
    })
    const v = new EditorView({ state, parent: host.current })
    view.current = v
    v.focus()
    return () => { v.destroy(); view.current = null }
    // `value` de propósito fora das dependências: quem o reaplica é o efeito
    // seguinte, sem remontar o editor e sem perder cursor/rolagem.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang])

  useEffect(() => {
    const v = view.current
    if (!v) return
    const atual = v.state.doc.toString()
    if (atual === value) return
    v.dispatch({ changes: { from: 0, to: atual.length, insert: value } })
  }, [value])

  return <div className="code-editor" ref={host} data-testid="code-editor" />
}
