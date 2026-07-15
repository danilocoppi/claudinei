export function ColorField({ value, onChange }: { value: string; onChange: (hex: string) => void }) {
  return (
    <label style={{ display: 'flex', gap: 10, alignItems: 'center', cursor: 'pointer' }}>
      <span style={{ color: 'var(--text-dim)', fontSize: 13 }}>Cor</span>
      <input aria-label="cor" type="color" value={value} onChange={(e) => onChange(e.target.value)}
             style={{ width: 40, height: 32, padding: 0, border: 'none', background: 'transparent', cursor: 'pointer' }} />
      <span style={{ fontFamily: 'ui-monospace, monospace, "Noto Color Emoji", "Apple Color Emoji", "Segoe UI Emoji"', fontSize: 13 }}>{value}</span>
    </label>
  )
}
