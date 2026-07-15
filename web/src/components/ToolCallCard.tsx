import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ChatItem } from '../types'
import { DiffView } from './DiffView'

type ToolCallItem = Extract<ChatItem, { kind: 'tool_call' }>

const TOOL_ICON: Record<string, string> = {
  Bash: '💻', Read: '📖', Edit: '✏️', Write: '📝', MultiEdit: '✏️',
  Grep: '🔍', Glob: '🔍', WebFetch: '🌐', WebSearch: '🌐', Task: '🤖',
}

function summarize(item: ToolCallItem): string {
  const input = (item.input ?? {}) as Record<string, unknown>
  const first = input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.description ?? ''
  const s = String(first)
  return s.length > 80 ? s.slice(0, 80) + '…' : s
}

export function ToolCallCard({ item }: { item: ToolCallItem }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const input = (item.input ?? {}) as Record<string, unknown>
  const isEdit = ['Edit', 'Write', 'MultiEdit'].includes(item.name)

  return (
    <div style={{ border: '1px solid var(--glass-border)', borderRadius: 8, margin: '6px 0', background: 'var(--glass-bg)', backdropFilter: 'blur(8px)' }}>
      <div onClick={() => setOpen(!open)}
           style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '8px 12px', cursor: 'pointer', fontSize: 13 }}>
        <span>{open ? '▾' : '▸'}</span>
        <span>{TOOL_ICON[item.name] ?? '🔧'}</span>
        <strong>{item.name}</strong>
        <span style={{ color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {summarize(item)}
        </span>
      </div>
      {open && (
        <div style={{ padding: '0 12px 12px' }}>
          {item.name === 'Edit' && (
            <DiffView oldText={String(input.old_string ?? '')} newText={String(input.new_string ?? '')} />
          )}
          {item.name === 'Write' && (
            <DiffView oldText="" newText={String(input.content ?? '')} />
          )}
          {item.name === 'MultiEdit' &&
            ((input.edits as { old_string?: unknown; new_string?: unknown }[] | undefined) ?? []).map((e, i) => (
              <DiffView key={i} oldText={String(e.old_string ?? '')} newText={String(e.new_string ?? '')} />
            ))}
          {!isEdit && (
            <pre style={{ fontSize: 12, overflow: 'auto', maxHeight: 200, background: 'rgba(0,0,0,.3)', padding: 8, borderRadius: 6 }}>
              {JSON.stringify(input, null, 2)}
            </pre>
          )}
          <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 6 }}>{t('toolcall.result')}</div>
          {item.result === undefined ? (
            <div style={{ color: 'var(--text-dim)', fontStyle: 'italic' }}>{t('toolcall.running')}</div>
          ) : (
            <pre style={{ fontSize: 12, overflow: 'auto', maxHeight: 300, background: 'rgba(0,0,0,.3)', padding: 8, borderRadius: 6 }}>
              {item.result}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}
