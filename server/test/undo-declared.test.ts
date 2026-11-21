import { describe, it, expect } from 'vitest'
import { declaredPaths } from '../src/undo/declared.js'
import type { AgentEvent } from '../src/engine/types.js'

const toolUse = (name: string, input: unknown): AgentEvent => ({
  kind: 'assistant', raw: {}, message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name, input }] },
})

describe('declaredPaths', () => {
  it('Edit/Write/MultiEdit/NotebookEdit do Claude', () => {
    expect(declaredPaths(toolUse('Edit', { file_path: '/repo/a.ts', old_string: 'x', new_string: 'y' }), '/repo')).toEqual(['/repo/a.ts'])
    expect(declaredPaths(toolUse('Write', { file_path: 'src/b.ts', content: '' }), '/repo')).toEqual(['/repo/src/b.ts'])
    expect(declaredPaths(toolUse('MultiEdit', { file_path: '/repo/c.ts', edits: [] }), '/repo')).toEqual(['/repo/c.ts'])
    expect(declaredPaths(toolUse('NotebookEdit', { notebook_path: '/repo/n.ipynb' }), '/repo')).toEqual(['/repo/n.ipynb'])
  })

  it('file_change do Codex com changes[].path', () => {
    const item = { id: 'i1', type: 'fileChange', changes: [{ path: '/repo/x.ts', kind: 'update' }, { path: 'y.ts', kind: 'add' }] }
    expect(declaredPaths(toolUse('file_change', item), '/repo')).toEqual(['/repo/x.ts', '/repo/y.ts'])
  })

  it('edit do OpenCode com filePath', () => {
    expect(declaredPaths(toolUse('edit', { filePath: '/repo/o.ts', oldString: 'a', newString: 'b' }), '/repo')).toEqual(['/repo/o.ts'])
  })

  it('ferramenta do Kimi com input em string JSON', () => {
    expect(declaredPaths(toolUse('WriteFile', JSON.stringify({ path: 'k.txt', content: 'oi' })), '/repo')).toEqual(['/repo/k.txt'])
    expect(declaredPaths(toolUse('StrReplaceFile', '{não é json'), '/repo')).toEqual([])
  })

  it('Bash não declara', () => {
    expect(declaredPaths(toolUse('Bash', { command: 'rm -rf x', path: '/repo/x' }), '/repo')).toEqual([])
    expect(declaredPaths(toolUse('Read', { file_path: '/repo/a.ts' }), '/repo')).toEqual([])
  })

  it('só assistant; repetidos saem uma vez; vários tool_use na mesma mensagem', () => {
    expect(declaredPaths({ kind: 'user', raw: {}, message: { role: 'user', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/a' } }] } }, '/')).toEqual([])
    const ev: AgentEvent = {
      kind: 'assistant', raw: {}, message: { role: 'assistant', content: [
        { type: 'text', text: 'oi' },
        { type: 'tool_use', name: 'Edit', input: { file_path: 'a.ts' } },
        { type: 'tool_use', name: 'Write', input: { file_path: '/repo/a.ts' } },
        { type: 'tool_use', name: 'Write', input: { file_path: 'b.ts' } },
      ] },
    }
    expect(declaredPaths(ev, '/repo')).toEqual(['/repo/a.ts', '/repo/b.ts'])
  })
})
