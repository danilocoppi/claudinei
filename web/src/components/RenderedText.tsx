import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import type { Components } from 'react-markdown'
import type { FileKind } from '../files'
import { langOfPath } from '../files'
import { useStore } from '../store'
import { MarkdownPre } from './MarkdownPre'

/**
 * Só a renderização de um texto JÁ carregado — quem busca o conteúdo (e trata
 * loading, erro e gravação) é o TextDocument. Ficam separados porque o editor
 * precisa renderizar o mesmo texto sem repetir a busca, e porque o
 * TextDocument não pode importar do FileViewerModal, que importa dele.
 */
export function RenderedText({ kind, text, name }: { kind: FileKind; text: string; name: string }) {
  const openExternalLink = useStore((s) => s.openExternalLink)
  // Links do markdown visualizado também passam pela confirmação de link externo.
  const mdComponents: Components = {
    pre: MarkdownPre,
    a: ({ href, children }) => (
      href && !href.startsWith('#')
        ? <a href={href} rel="noreferrer" onClick={(e) => { e.preventDefault(); openExternalLink(href) }}>{children}</a>
        : <a href={href}>{children}</a>
    ),
  }

  if (kind === 'markdown') {
    return (
      <div className="markdown" style={{ lineHeight: 1.6 }}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={mdComponents}>
          {text}
        </ReactMarkdown>
      </div>
    )
  }

  // Código: colore com o MESMO pipeline do chat (fence markdown → rehypeHighlight,
  // sem innerHTML). Fence maior que qualquer sequência de ``` do arquivo (não
  // quebra em arquivos que contêm markdown); cap de 300KB — acima disso o
  // highlight travaria a UI e cai no <pre> puro.
  const lang = kind === 'code' ? langOfPath(name) : null
  if (lang && text.length <= 300_000) {
    const runs = text.match(/`{3,}/g)
    const fence = '`'.repeat(Math.max(3, ...(runs?.map((r) => r.length + 1) ?? [0])))
    return (
      <div className="markdown code-preview" style={{ lineHeight: 1.55 }}>
        <ReactMarkdown rehypePlugins={[rehypeHighlight]} components={{ pre: MarkdownPre }}>
          {`${fence}${lang}\n${text}\n${fence}`}
        </ReactMarkdown>
      </div>
    )
  }

  return (
    <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0, fontFamily: 'monospace', fontSize: 13 }}>
      {text}
    </pre>
  )
}
