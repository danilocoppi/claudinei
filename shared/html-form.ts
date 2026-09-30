export interface HtmlFieldValue {
  key: string
  tag: string
  type: string
  value: string
  checked?: boolean
  selected?: string[]
}

/** Self-contained: also embedded in saved HTML and sandboxed previews. */
export function htmlFormTools(doc: Document) {
  const controls = () => {
    const count = new Map<string, number>()
    return Array.from(doc.querySelectorAll<HTMLElement>('input, textarea, select, [contenteditable]')).flatMap(el => {
      const tag = el.tagName.toLowerCase()
      const type = tag === 'input' ? (el as HTMLInputElement).type : ''
      if (['password', 'file', 'button', 'submit', 'reset', 'image'].includes(type)) return []
      if (!['input', 'textarea', 'select'].includes(tag)
        && (el.getAttribute('contenteditable') === 'false' || el.parentElement?.closest('[contenteditable]'))) return []
      const name = el.getAttribute('name')
      const identity = el.id ? `id:${el.id}` : name ? `name:${name}` : `unnamed`
      const choice = ['radio', 'checkbox'].includes(type) ? (el as HTMLInputElement).value : ''
      const group = JSON.stringify([identity, tag, type, choice])
      const occurrence = count.get(group) ?? 0
      count.set(group, occurrence + 1)
      return [{ el, key: `${group}:${occurrence}`, tag, type }]
    })
  }
  const read = (): HtmlFieldValue[] => controls().map(({ el, key, tag, type }) => {
    const field: HtmlFieldValue = { key, tag, type, value: '' }
    if (tag === 'input') {
      field.value = (el as HTMLInputElement).value
      if (type === 'checkbox' || type === 'radio') field.checked = (el as HTMLInputElement).checked
    } else if (tag === 'textarea') field.value = (el as HTMLTextAreaElement).value
    else if (tag === 'select') field.selected = Array.from((el as HTMLSelectElement).selectedOptions).map(o => o.value)
    else field.value = el.innerHTML
    return field
  })
  const apply = (values: HtmlFieldValue[], persist = false, visited?: WeakSet<Element>, includeUnchanged = false) => {
    const lookup = new Map(values.map(value => [value.key, value]))
    const changed: HTMLElement[] = []
    for (const { el, key, tag, type } of controls()) {
      const field = lookup.get(key)
      if (!field || field.tag !== tag || field.type !== type || visited?.has(el)) continue
      visited?.add(el)
      let different = false
      if (tag === 'input') {
        const input = el as HTMLInputElement
        if (type === 'checkbox' || type === 'radio') {
          different = input.checked !== !!field.checked
          input.checked = !!field.checked
          if (persist) input.toggleAttribute('checked', !!field.checked)
        } else {
          different = input.value !== field.value
          input.value = field.value
          if (persist) input.setAttribute('value', field.value)
        }
      } else if (tag === 'textarea') {
        different = (el as HTMLTextAreaElement).value !== field.value
        ;(el as HTMLTextAreaElement).value = field.value
        if (persist) el.textContent = field.value
      } else if (tag === 'select') {
        for (const option of Array.from((el as HTMLSelectElement).options)) {
          const selected = field.selected?.includes(option.value) ?? false
          different ||= option.selected !== selected
          option.selected = selected
          if (persist) option.toggleAttribute('selected', option.selected)
        }
      } else {
        different = el.innerHTML !== field.value
        if (different) el.innerHTML = field.value
      }
      if (different || includeUnchanged) changed.push(el)
    }
    return changed
  }
  return { read, apply }
}

/** Restore dynamic controls as well as native HTML defaults. There is no I/O.
 * The same helper works when a filled report is opened outside Claudinei. */
export function restoreHtmlForm(tools: ReturnType<typeof htmlFormTools>, doc: Document) {
  let values: HtmlFieldValue[] = []
  try { values = JSON.parse(doc.getElementById('claudinei-form-values')?.textContent ?? '[]') } catch { return }
  if (!Array.isArray(values)) return
  const visited = new WeakSet<Element>()
  let initial = true
  const restore = () => {
    const changed = tools.apply(values, false, visited, initial)
    initial = false
    // Let a report update totals/classes dependent on the restored fields.
    // These synthetic events do not mark the Claudinei preview dirty.
    for (const field of changed) {
      field.dispatchEvent(new Event('input', { bubbles: true }))
      field.dispatchEvent(new Event('change', { bubbles: true }))
    }
  }
  const start = () => {
    restore()
    new MutationObserver(restore).observe(doc.body, { childList: true, subtree: true })
    // If a report rebuilds its fields after a user action, retain the live values.
    const changed = () => {
      const retained = new Map(values.map(field => [field.key, field]))
      for (const field of tools.read()) retained.set(field.key, field)
      values = [...retained.values()]
    }
    doc.addEventListener('input', changed)
    doc.addEventListener('change', changed)
    doc.addEventListener('reset', () => setTimeout(changed, 0))
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start, { once: true })
  else start()
}

/** Read-only bridge: never receives a path, token or permission to write files. */
export function observeHtmlForm(tools: ReturnType<typeof htmlFormTools>, config: { channel: string; hash: string }) {
  const start = () => {
    let last = JSON.stringify(tools.read())
    const send = (kind: 'ready' | 'change', fields: HtmlFieldValue[]) => {
      window.parent.postMessage({ type: 'claudinei:html-form', kind, ...config, fields }, '*')
    }
    send('ready', JSON.parse(last))
    let pending = false
    const changed = (event: Event) => {
      if (!event.isTrusted || ('isComposing' in event && event.isComposing) || pending) return
      pending = true
      setTimeout(() => {
        pending = false
        const fields = tools.read()
        const next = JSON.stringify(fields)
        if (next !== last) { last = next; send('change', fields) }
      }, 0)
    }
    for (const name of ['input', 'change', 'click', 'keyup', 'reset', 'compositionend']) {
      document.addEventListener(name, changed, true)
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(start, 0), { once: true })
  else setTimeout(start, 0)
}

export function formRestoreScript(): string {
  return `(${restoreHtmlForm.toString()})((${htmlFormTools.toString()})(document),document);`
}

export function formBridgeScript(channel: string, hash: string): string {
  const config = JSON.stringify({ channel, hash }).replace(/</g, '\\u003c')
  return `(${observeHtmlForm.toString()})((${htmlFormTools.toString()})(document),${config});`
}

export function validHtmlFields(value: unknown): value is HtmlFieldValue[] {
  if (!Array.isArray(value) || value.length > 5000) return false
  return value.every(field => field && typeof field === 'object'
    && ['key', 'tag', 'type', 'value'].every(key => typeof field[key] === 'string' && field[key].length <= 2 * 1024 * 1024)
    && (field.checked === undefined || typeof field.checked === 'boolean')
    && (field.selected === undefined || (Array.isArray(field.selected) && field.selected.length <= 5000
      && field.selected.every((item: unknown) => typeof item === 'string'))))
    && JSON.stringify(value).length <= 2 * 1024 * 1024
}
