import type { ReactNode } from 'react'
import { render, type RenderOptions } from '@testing-library/react'
import { VirtuosoMockContext } from 'react-virtuoso'

/**
 * A conversa é uma lista virtual (react-virtuoso), que mede a janela e os itens
 * para saber o que montar. O jsdom não tem layout — tudo mede 0 e nada seria
 * montado —, então os testes que olham o conteúdo do ChatView fixam as medidas:
 * uma janela alta o bastante para a conversa inteira dos testes caber nela.
 */
export function ComJanela({ children }: { children: ReactNode }) {
  return <VirtuosoMockContext.Provider value={{ viewportHeight: 4000, itemHeight: 50 }}>{children}</VirtuosoMockContext.Provider>
}

/** `render` com a janela fixa (vale também para o `rerender`). */
export const renderComJanela = (ui: React.ReactElement, options?: Omit<RenderOptions, 'wrapper'>) =>
  render(ui, { wrapper: ComJanela, ...options })
