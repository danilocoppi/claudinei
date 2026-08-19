import Picker, { EmojiStyle, Theme, type EmojiClickData } from 'emoji-picker-react'

/** `inline`: já está dentro de um modal (o seletor com abas) e não deve criar outro. */
export function EmojiPicker({ onSelect, onClose, inline }: {
  onSelect: (emoji: string) => void
  onClose: () => void
  inline?: boolean
}) {
  const picker = (
    <Picker
      emojiStyle={EmojiStyle.NATIVE}
      theme={Theme.DARK}
      onEmojiClick={(data: EmojiClickData) => { onSelect(data.emoji); onClose() }}
    />
  )
  if (inline) return <div style={{ fontFamily: 'var(--emoji)' }}>{picker}</div>
  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div onClick={(e) => e.stopPropagation()} style={{ fontFamily: 'var(--emoji)' }}>{picker}</div>
    </div>
  )
}
