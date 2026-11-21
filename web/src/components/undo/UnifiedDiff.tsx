import { memo, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { FileDiff } from '../../../../shared/undo'
import './undo.css'

type LineKind = 'add' | 'del' | 'ctx' | 'hunk' | 'meta'
interface Line { kind: LineKind; sign: string; text: string }

/**
 * As linhas de um `git diff` de um arquivo. O cabeçalho (`diff --git`,
 * `index`, `---`/`+++`, modos) vai até o primeiro `@@`; depois dele, o
 * primeiro caractere diz o que é a linha. `\ No newline…` fica como meta.
 */
function parse(text: string): Line[] {
  const raw = text.split('\n')
  if (raw.length > 0 && raw[raw.length - 1] === '') raw.pop()
  const out: Line[] = []
  let inHunk = false
  for (const l of raw) {
    if (l.startsWith('@@')) { inHunk = true; out.push({ kind: 'hunk', sign: '', text: l }); continue }
    if (!inHunk) { out.push({ kind: 'meta', sign: '', text: l }); continue }
    const c = l[0]
    if (c === '+') out.push({ kind: 'add', sign: '+', text: l.slice(1) })
    else if (c === '-') out.push({ kind: 'del', sign: '−', text: l.slice(1) })
    else if (c === '\\') out.push({ kind: 'meta', sign: '', text: l })
    else out.push({ kind: 'ctx', sign: '', text: l.slice(1) })
  }
  return out
}

/**
 * O diff unificado de um arquivo, sem realce de sintaxe: linhas `+`, `−` e de
 * contexto. Até 2.000 linhas (o servidor corta e avisa em `truncated`), cada
 * uma um elemento simples — nada de medida nem efeito.
 */
export const UnifiedDiff = memo(function UnifiedDiff({ diff }: { diff: FileDiff }) {
  const { t } = useTranslation()
  const lines = useMemo(() => (diff.binary ? [] : parse(diff.text)), [diff.binary, diff.text])
  if (diff.binary) return <div className="undo-diff__note">{t('undo.diff.binary', { kb: diff.sizeKb ?? 0 })}</div>
  return (
    <div className="undo-diff">
      {diff.truncated && <div className="undo-diff__warn">{t('undo.diff.truncated')}</div>}
      {lines.length === 0
        ? <div className="undo-diff__note">{t('undo.diff.empty')}</div>
        : (
          <div className="undo-diff__body">
            {lines.map((l, i) => (
              <div key={i} className={`undo-diff__line undo-diff__line--${l.kind}`}>
                <span className="undo-diff__sign" aria-hidden="true">{l.sign}</span>
                <span>{l.text}</span>
              </div>
            ))}
          </div>
        )}
    </div>
  )
})
