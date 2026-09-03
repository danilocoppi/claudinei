import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const src = (p: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', p), 'utf8')

/**
 * O bundle inicial não carrega o que a tela de login não usa.
 *
 * Um arquivo só de 1,38 MB tinha 45% em bibliotecas de uso eventual: o xterm
 * (terminal e Actions), o seletor de emoji, telas que só abrem por clique. Um
 * import estático de qualquer uma delas no App a devolve ao bundle inicial —
 * e o Vite não avisa. Este teste avisa.
 */
describe('code-splitting', () => {
  it('o App não importa estaticamente as telas e modais pesados', () => {
    const app = src('App.tsx')
    for (const comp of ['TerminalView', 'ActionRunModal', 'FileViewerModal', 'SchedulesView']) {
      expect(app, `${comp} voltou ao bundle inicial`).not.toMatch(new RegExp(`^import .*\\b${comp}\\b.* from`, 'm'))
      expect(app, `${comp} não é lazy`).toMatch(new RegExp(`lazy\\(\\(\\) => import\\('./components/${comp}'`))
    }
  })

  it('o seletor de emoji só baixa quando a aba abre', () => {
    const picker = src('components/IconPicker.tsx')
    expect(picker).not.toMatch(/^import \{ EmojiPicker \} from/m)
    expect(picker).toMatch(/lazy\(\(\) => import\('\.\/EmojiPicker'/)
  })

  /** Modal sempre renderizado + lazy = chunk baixa no mount, ganho zero. O portão
   *  é o que faz o lazy valer. */
  it('os modais lazy só montam quando há o que mostrar', () => {
    const app = src('App.tsx')
    expect(app).toMatch(/s\.actionRuns\.length > 0/)
    expect(app).toMatch(/!!s\.fileViewer/)
  })
})
