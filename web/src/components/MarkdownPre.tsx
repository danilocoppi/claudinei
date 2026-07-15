import type { ComponentProps, ReactNode } from 'react'
import { CopyButton } from './CopyButton'

// Texto cru de um nó hast (bloco de código já processado pelo rehype-highlight:
// o conteúdo vira spans — concatena os nós de texto recursivamente).
type HastNode = { type?: string; value?: string; children?: HastNode[] }
export function hastText(node: HastNode | undefined): string {
  if (!node) return ''
  if (node.type === 'text') return node.value ?? ''
  return (node.children ?? []).map(hastText).join('')
}

/**
 * `<pre>` do markdown (chat e visualizador) com botão de copiar: sugestões de
 * comandos/códigos em bloco são copiáveis com 1 clique (o texto vem do nó hast,
 * cru, sem os spans de highlight).
 */
export function MarkdownPre({ node, children, ...props }: ComponentProps<'pre'> & { node?: unknown; children?: ReactNode }) {
  const text = hastText(node as HastNode).replace(/\n$/, '')
  return (
    <div className="copy-wrap">
      <pre {...props}>{children}</pre>
      {text && <CopyButton text={text} />}
    </div>
  )
}
