/** The editable frame never runs document scripts. Its DOM is a temporary view;
 * only the edited body is copied back into the original document on change. */
export function visualHtml(source: string, baseUrl?: string) {
  const original = new DOMParser().parseFromString(source, 'text/html')
  const working = original.cloneNode(true) as Document
  // A refresh could navigate away before the parent installs editor handlers.
  // Keep a placeholder so a body-level refresh is restored when saving too.
  const replacements = new Map<string, Element>()
  for (const element of working.querySelectorAll('meta[http-equiv], base')) {
    // getRandomValues also works on HTTP LAN access (randomUUID requires HTTPS).
    const id = `claudinei-editor-${crypto.getRandomValues(new Uint32Array(4)).join('-')}`
    replacements.set(id, element.cloneNode(true) as Element)
    element.replaceWith(working.createComment(id))
  }
  const base = baseUrl ? new URL(baseUrl, window.location.href) : null
  const resourceRoot = base?.pathname.match(/^\/api\/files\/preview\/[^/]+\//)?.[0]
  const resources = base?.origin === window.location.origin && resourceRoot
    ? `${base.origin}${resourceRoot}` : "'none'"
  const policy = working.createElement('meta')
  policy.httpEquiv = 'Content-Security-Policy'
  policy.content = `default-src 'none'; script-src 'none'; style-src ${resources} 'unsafe-inline'; img-src ${resources} data:; font-src ${resources} data:; media-src ${resources} data:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'self'`
  working.head.prepend(policy)
  if (base && resourceRoot && base.origin === window.location.origin) {
    const relativeBase = working.createElement('base')
    relativeBase.href = base.href
    policy.after(relativeBase)
  }
  const serialize = (doc: Document) => Array.from(doc.childNodes).map((node) =>
    node === doc.documentElement ? doc.documentElement.outerHTML : new XMLSerializer().serializeToString(node),
  ).join('')
  const initialBody = working.body.innerHTML
  return {
    srcDoc: serialize(working),
    read(doc: Document) {
      if (doc.body.innerHTML === initialBody) return source
      const result = original.cloneNode(true) as Document
      result.body.innerHTML = doc.body.innerHTML
      const comments = result.createTreeWalker(result.body, NodeFilter.SHOW_COMMENT)
      const restore: Comment[] = []
      while (comments.nextNode()) restore.push(comments.currentNode as Comment)
      for (const comment of restore) {
        const element = replacements.get(comment.data)
        if (element) comment.replaceWith(element.cloneNode(true))
      }
      return serialize(result)
    },
  }
}
