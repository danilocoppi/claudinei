import Picker, { EmojiStyle, Theme, type EmojiClickData } from 'emoji-picker-react'

export function EmojiPicker({ onSelect, onClose }: { onSelect: (emoji: string) => void; onClose: () => void }) {
  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div onClick={(e) => e.stopPropagation()} style={{ fontFamily: 'var(--emoji)' }}>
        <Picker
          emojiStyle={EmojiStyle.NATIVE}
          theme={Theme.DARK}
          onEmojiClick={(data: EmojiClickData) => { onSelect(data.emoji); onClose() }}
        />
      </div>
    </div>
  )
}
