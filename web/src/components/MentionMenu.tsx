import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { filterTerminals } from '../mentions'
import { Icon } from './Icon'
import type { Project } from '../types'

/**
 * A lista que o `@@` abre: com quem este terminal vai falar.
 *
 * Existe porque o alvo era subjetivo. As ferramentas de colaboração recebem o
 * NOME do projeto e o servidor compara exato — então escrever o nome de memória
 * é errar por um hífen e receber `project "..." does not exist`. Escolher da
 * lista transforma isso em impossível.
 *
 * O campo de busca é próprio, e não o que se digita depois do `@@` no textarea:
 * nome de terminal tem espaço, e espaço no meio de um autocomplete de texto
 * corrido é o fim da palavra para qualquer heurística razoável.
 */
export function MentionMenu({ projects, onPick, onClose }: {
  projects: Project[]
  onPick: (name: string) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [busca, setBusca] = useState('')
  const [ativo, setAtivo] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const achados = filterTerminals(projects, busca)
  const indice = Math.min(ativo, Math.max(0, achados.length - 1))

  useEffect(() => { inputRef.current?.focus() }, [])
  // Digitar filtra: manter o cursor onde estava deixaria a seleção apontando para
  // um item que a busca acabou de tirar da lista.
  useEffect(() => { setAtivo(0) }, [busca])

  const teclado = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
    if (achados.length === 0) return
    if (e.key === 'ArrowDown') { e.preventDefault(); setAtivo((i) => (i + 1) % achados.length); return }
    if (e.key === 'ArrowUp') { e.preventDefault(); setAtivo((i) => (i - 1 + achados.length) % achados.length); return }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); onPick(achados[indice].name) }
  }

  return (
    <div className="mention-menu glass" data-testid="mention-menu">
      <input
        ref={inputRef}
        className="mention-menu__search"
        data-testid="mention-search"
        value={busca}
        placeholder={t('chat.mentionSearch')}
        onChange={(e) => setBusca(e.target.value)}
        onKeyDown={teclado}
        // Fechar ao perder o foco, mas não quando o clique é num item da própria
        // lista — o `onMouseDown` deles corre antes e já resolve a escolha.
        onBlur={onClose}
      />
      <div className="mention-menu__list">
        {achados.length === 0 && <div className="mention-menu__empty">{t('chat.mentionEmpty')}</div>}
        {achados.map((p, i) => (
          <div
            key={p.id}
            data-testid="mention-item"
            className={`mention-item ${i === indice ? 'active' : ''}`}
            onMouseDown={(e) => { e.preventDefault(); onPick(p.name) }}
          >
            <Icon value={p.icon ?? '📁'} size={14} />
            <span className="mention-item__name">{p.name}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
