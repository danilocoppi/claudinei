import { describe, it, expect } from 'vitest'
import { declaredChanges } from '../undo/declared'
import type { ChatItem } from '../types'

const call = (name: string, input: unknown, id = name): ChatItem => ({ kind: 'tool_call', id, name, input })

describe('declaredChanges', () => {
  it('Write vira written sem diff', () => {
    expect(declaredChanges([call('Write', { file_path: '/p/a.ts', content: 'tudo novo' })]))
      .toEqual([{ path: '/p/a.ts', kind: 'written' }])
  })

  it('Edit e MultiEdit dão os pares, juntos no mesmo caminho', () => {
    expect(declaredChanges([
      call('Edit', { file_path: '/p/a.ts', old_string: 'a', new_string: 'b' }),
      call('MultiEdit', { file_path: '/p/a.ts', edits: [{ old_string: 'c', new_string: 'd' }, { old_string: 'e', new_string: 'f' }] }),
    ])).toEqual([{ path: '/p/a.ts', kind: 'edit', pairs: [{ old: 'a', new: 'b' }, { old: 'c', new: 'd' }, { old: 'e', new: 'f' }] }])
  })

  it('file_change traz o diff', () => {
    const item = { id: 'fc', type: 'fileChange', status: 'completed', changes: [
      { path: '/p/a.ts', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-a\n+b\n' },
      { path: '/p/b.ts', kind: { type: 'add' }, diff: '+novo\n' },
    ] }
    expect(declaredChanges([call('file_change', item)])).toEqual([
      { path: '/p/a.ts', kind: 'patch', diff: '@@ -1 +1 @@\n-a\n+b\n' },
      { path: '/p/b.ts', kind: 'patch', diff: '+novo\n' },
    ])
  })

  it('edit do OpenCode dá pares de oldString/newString', () => {
    expect(declaredChanges([call('edit', { filePath: '/p/a.ts', oldString: 'x', newString: 'y' })]))
      .toEqual([{ path: '/p/a.ts', kind: 'edit', pairs: [{ old: 'x', new: 'y' }] }])
  })

  it('o resto que escreve fica só com o caminho; input em string JSON (Kimi) também vale', () => {
    expect(declaredChanges([
      call('NotebookEdit', { notebook_path: '/p/n.ipynb', new_source: 'x' }),
      call('StrReplaceFile', JSON.stringify({ path: '/p/k.py', edit: { old: 'a', new: 'b' } })),
    ])).toEqual([{ path: '/p/n.ipynb', kind: 'path_only' }, { path: '/p/k.py', kind: 'path_only' }])
  })

  it('Write depois de Edit no mesmo caminho fica written, sem pares parciais', () => {
    expect(declaredChanges([
      call('Edit', { file_path: '/p/a.ts', old_string: 'a', new_string: 'b' }),
      call('Write', { file_path: '/p/a.ts', content: 'z' }),
    ])).toEqual([{ path: '/p/a.ts', kind: 'written' }])
  })

  it('Bash não entra', () => {
    expect(declaredChanges([
      call('Bash', { command: 'echo x > /p/a.ts' }),
      call('Read', { file_path: '/p/a.ts' }),
      { kind: 'assistant_text', text: 'pronto' },
    ])).toEqual([])
  })
})
