import { formRestoreScript, htmlFormTools, validHtmlFields, type HtmlFieldValue } from '../../../shared/html-form'

/** Persist defaults in the original HTML, not a snapshot of a running app.
 * Generated controls also get a small self-contained restore script. */
export function saveHtmlFields(source: string, fields: HtmlFieldValue[]): string {
  const doc = new DOMParser().parseFromString(source, 'text/html')
  // File writes use UTF-8; keep a downloaded/standalone report readable too.
  const charset = doc.querySelector('meta[charset]') ?? doc.createElement('meta')
  charset.setAttribute('charset', 'utf-8')
  if (!charset.parentNode) doc.head.prepend(charset)
  htmlFormTools(doc).apply(fields, true)
  // Reports may mount only their active section. Preserve saved values for
  // controls that are temporarily absent, and replace the ones currently shown.
  let previous: HtmlFieldValue[] = []
  try {
    const stored: unknown = JSON.parse(doc.getElementById('claudinei-form-values')?.textContent ?? '[]')
    if (validHtmlFields(stored)) previous = stored
  } catch { /* malformed legacy state is replaced by the current fields */ }
  const retained = new Map(previous.map(field => [field.key, field]))
  for (const field of fields) retained.set(field.key, field)
  doc.getElementById('claudinei-form-values')?.remove()
  doc.getElementById('claudinei-form-restore')?.remove()
  const state = doc.createElement('script')
  state.id = 'claudinei-form-values'
  state.type = 'application/json'
  state.textContent = JSON.stringify([...retained.values()]).replace(/</g, '\\u003c')
  const restore = doc.createElement('script')
  restore.id = 'claudinei-form-restore'
  restore.textContent = formRestoreScript()
  doc.body.append(state, restore)
  return Array.from(doc.childNodes).map(node => node === doc.documentElement
    ? doc.documentElement.outerHTML : new XMLSerializer().serializeToString(node)).join('')
}
