import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

const SWATCHES: Array<{ key: 'green' | 'gradient' | 'red' | 'purple'; style: React.CSSProperties }> = [
  { key: 'green', style: { background: 'var(--ok)' } },
  // amostra do MEIO do degradê (ritmo ~1.5×): matiz 70 — mesmo cálculo do paceColor
  { key: 'gradient', style: { background: 'linear-gradient(90deg, hsl(140 70% 55%), hsl(70 70% 55%), hsl(0 70% 55%))' } },
  { key: 'red', style: { background: 'var(--err)' } },
  { key: 'purple', style: { background: 'var(--accent)' } },
]

/** Modal ⓘ do card de Usage: explica o que a barra mede e o que as CORES do
 * ritmo significam (verde→vermelho = uso rápido demais pro tempo que resta). */
export function UsageInfo({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  return createPortal(
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="glass interaction-info" onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>{t('usageInfo.title')}</h3>
        <p className="interaction-info__intro">{t('usageInfo.intro')}</p>

        <div className="interaction-info__section">
          <h4>📊 {t('usageInfo.barTitle')}</h4>
          <p>{t('usageInfo.barWhat')}</p>
        </div>

        <div className="interaction-info__section">
          <h4>🎨 {t('usageInfo.colorTitle')}</h4>
          <p>{t('usageInfo.colorWhat')}</p>
          <ul className="usage-info__colors">
            {SWATCHES.map(({ key, style }) => (
              <li key={key}>
                <span className="usage-info__swatch" style={style} aria-hidden="true" />
                <span>{t(`usageInfo.${key}` as const)}</span>
              </li>
            ))}
          </ul>
          <p className="interaction-info__example">{t('usageInfo.tip')}</p>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
          <button onClick={onClose}>{t('common.ok')}</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
