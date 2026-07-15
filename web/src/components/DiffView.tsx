export function DiffView({ oldText, newText }: { oldText: string; newText: string }) {
  const line = (prefix: string, text: string, color: string, bg: string, key: string) => (
    <div key={key} style={{ color, background: bg, padding: '1px 8px', whiteSpace: 'pre-wrap', fontFamily: 'monospace, "Noto Color Emoji", "Apple Color Emoji", "Segoe UI Emoji"', fontSize: 13 }}>
      {prefix} {text}
    </div>
  )
  return (
    <div style={{ borderRadius: 6, overflow: 'hidden', border: '1px solid var(--glass-border)', margin: '6px 0' }}>
      {oldText !== '' && oldText.split('\n').map((l, i) => line('-', l, '#ff8589', '#3d1418', `o${i}`))}
      {newText !== '' && newText.split('\n').map((l, i) => line('+', l, '#7ee2a8', '#12351f', `n${i}`))}
    </div>
  )
}
