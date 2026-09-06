/** Decorative indicators keep their CSS artwork and timing, but do not need
 * the display's 60/120/144 Hz refresh rate. Sample the browser's own interpolation
 * once, then let native stepped keyframes play it. There is no per-frame JS loop.
 */
export const INDICATOR_FPS = 20

const names = /^(?:pulse|ping|sonar|typing-bounce|act-pulse|face-.+)$/
const properties = new Set(['opacity', 'transform', 'boxShadow'])
const rootSelector = '.agent-face, .status-dot, .typing, .compacting__spinner, .sonar, .subagent__spinner, .actrun__dot'
const metadata = new Set(['offset', 'computedOffset', 'easing', 'composite'])

interface Entry {
  animation: CSSAnimation
  effect: KeyframeEffect
  root: Element
  original: Keyframe[]
  visible: boolean
  pausedByUs: boolean
}

function keyframeRules(doc: Document): Map<string, CSSKeyframesRule> {
  const found = new Map<string, CSSKeyframesRule>()
  const visit = (rules: CSSRuleList) => {
    for (const rule of rules) {
      if (rule instanceof CSSKeyframesRule) found.set(rule.name, rule)
      else if ('cssRules' in rule) visit((rule as CSSGroupingRule).cssRules)
    }
  }
  for (const sheet of doc.styleSheets) {
    try { visit(sheet.cssRules) } catch { /* Cross-origin sheets cannot be read. */ }
  }
  return found
}

function sourceFrames(rule: CSSKeyframesRule | undefined, effect: KeyframeEffect): Keyframe[] {
  if (!rule || !effect.target) return effect.getKeyframes()
  const easing = getComputedStyle(effect.target, effect.pseudoElement).animationTimingFunction
  const frames: Keyframe[] = []
  for (const item of rule.cssRules) {
    const keyframe = item as CSSKeyframeRule
    for (const offset of keyframe.keyText.split(',')) {
      const frame: Keyframe = { offset: parseFloat(offset) / 100, easing: keyframe.style.animationTimingFunction || easing }
      for (const name of keyframe.style) {
        if (name === 'animation-timing-function') continue
        const key = name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())
        frame[key] = keyframe.style.getPropertyValue(name)
      }
      frames.push(frame)
    }
  }
  // Keep var()/percentages, rather than retaining getKeyframes()'s resolved
  // colors/pixels. Theme and size changes must be interpolated afresh.
  return frames.sort((a, b) => Number(a.offset) - Number(b.offset))
}

/** Reads intermediate poses while paused; restores the playhead before paint.
 * CSS keeps controlling colors, sizes, duration, delay and direction. Only the
 * animated properties become sampled poses (including the original easing).
 */
export function sampleIndicator(animation: Animation, fps = INDICATOR_FPS): boolean {
  const effect = animation.effect as KeyframeEffect | null
  if (!effect?.target) return false
  const timing = effect.getTiming()
  const duration = typeof timing.duration === 'number' ? timing.duration : NaN
  if (!Number.isFinite(duration) || duration <= 0 || timing.iterations !== Infinity || timing.direction !== 'normal' || timing.iterationStart !== 0) return false
  const original = effect.getKeyframes()
  const keys = [...new Set(original.flatMap(frame => Object.keys(frame)))].filter(key => !metadata.has(key))
  if (!keys.length || keys.some(key => !properties.has(key))) return false
  const time = animation.currentTime
  const running = animation.playState === 'running'
  const frames: Keyframe[] = []
  // Bound initial work even if a future indicator accidentally uses hours.
  const count = Math.min(240, Math.max(2, Math.ceil(duration * fps / 1000)))
  let sampled = false
  try {
    animation.pause()
    effect.updateTiming({ iterations: 1, fill: 'both' })
    for (let i = 0; i <= count; i++) {
      animation.currentTime = (timing.delay ?? 0) + duration * i / count
      const style = getComputedStyle(effect.target, effect.pseudoElement)
      const frame: Keyframe = { offset: i / count, easing: 'steps(1, end)' }
      for (const key of keys) frame[key] = (style as unknown as Record<string, string>)[key]
      frames.push(frame)
    }
    effect.setKeyframes(frames)
    sampled = true
  } finally {
    if (!sampled) effect.setKeyframes(original)
    effect.updateTiming({ ...timing, duration })
    animation.currentTime = time
    if (running) animation.play()
  }
  return sampled
}

export function installIndicatorMotion(doc: Document = document): () => void {
  if (typeof CSSAnimation === 'undefined' || !doc.getAnimations || typeof IntersectionObserver === 'undefined') return () => {}
  const entries = new Map<CSSAnimation, Entry>()
  const roots = new Map<Element, { visible: boolean; width: number; height: number }>()
  const reduced = matchMedia('(prefers-reduced-motion: reduce)')
  let frame = 0
  let disposed = false
  let rebuild = false
  let sources = keyframeRules(doc)

  const activity = () => {
    const allowed = !doc.hidden && !reduced.matches && doc.documentElement.dataset.motion !== 'reduced'
    for (const entry of entries.values()) {
      if (!allowed || !entry.visible) {
        if (entry.animation.playState === 'running') {
          entry.animation.pause()
          entry.pausedByUs = true
        }
      } else if (entry.pausedByUs && entry.animation.playState !== 'idle') {
        entry.animation.play()
        entry.pausedByUs = false
      }
    }
  }

  const intersection = new IntersectionObserver(changes => {
    for (const change of changes) {
      const state = roots.get(change.target)
      if (!state) continue
      state.visible = change.isIntersecting
      for (const entry of entries.values()) if (entry.root === change.target) entry.visible = state.visible
    }
    activity()
  }, { rootMargin: '24px' })

  const queue = (resample = false) => {
    if (disposed) return
    rebuild ||= resample
    if (!frame) frame = requestAnimationFrame(refresh)
  }

  const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(changes => {
    for (const change of changes) {
      const state = roots.get(change.target)
      if (!state) continue
      const { width, height } = change.contentRect
      if (state.width !== width || state.height !== height) {
        state.width = width
        state.height = height
        queue(true)
      }
    }
  })

  function refresh() {
    frame = 0
    if (disposed) return
    const all = new Set(doc.getAnimations())
    if (rebuild) sources = keyframeRules(doc)
    for (const [animation] of entries) if (!all.has(animation)) entries.delete(animation)
    for (const animation of all) {
      if (!(animation instanceof CSSAnimation) || !names.test(animation.animationName)) continue
      const effect = animation.effect as KeyframeEffect | null
      const target = effect?.target
      if (!effect || !(target instanceof Element)) continue
      const root = target.closest(rootSelector) ?? target
      if (!root.isConnected) continue
      let entry = entries.get(animation)
      if (entry && !rebuild) continue
      const original = sourceFrames(sources.get(animation.animationName), effect)
      try {
        effect.setKeyframes(original)
        if (!sampleIndicator(animation)) continue
      } catch {
        // Unsupported browser effects retain native CSS; no broken indicators.
        continue
      }
      if (entry) entry.original = original
      if (!entry) {
        let state = roots.get(root)
        if (!state) {
          state = { visible: false, width: -1, height: -1 }
          roots.set(root, state)
          intersection.observe(root)
          resize?.observe(root)
        }
        entry = { animation, effect, original, root, visible: state.visible, pausedByUs: false }
        entries.set(animation, entry)
      }
    }
    rebuild = false
    for (const root of roots.keys()) {
      if (![...entries.values()].some(entry => entry.root === root)) {
        intersection.unobserve(root)
        resize?.unobserve(root)
        roots.delete(root)
      }
    }
    activity()
  }

  const started = () => queue()
  const appearanceChanged = () => { activity(); queue(true) }
  const visibilityChanged = () => { activity(); if (!doc.hidden) queue() }
  // CSS starts on newly inserted/status-changed indicators. Text streaming does
  // not trigger rescans. Removals only queue a scan when a managed root left DOM.
  const removal = new MutationObserver(() => {
    if ([...roots.keys()].some(root => !root.isConnected)) queue()
  })
  const appearance = new MutationObserver(appearanceChanged)
  removal.observe(doc.documentElement, { childList: true, subtree: true })
  appearance.observe(doc.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-motion', 'style'] })
  doc.addEventListener('animationstart', started, true)
  doc.addEventListener('animationcancel', started, true)
  doc.addEventListener('visibilitychange', visibilityChanged)
  reduced.addEventListener('change', appearanceChanged)
  queue()

  return () => {
    disposed = true
    cancelAnimationFrame(frame)
    removal.disconnect()
    appearance.disconnect()
    intersection.disconnect()
    resize?.disconnect()
    doc.removeEventListener('animationstart', started, true)
    doc.removeEventListener('animationcancel', started, true)
    doc.removeEventListener('visibilitychange', visibilityChanged)
    reduced.removeEventListener('change', appearanceChanged)
    for (const entry of entries.values()) {
      entry.effect.setKeyframes(entry.original)
      if (entry.pausedByUs && entry.animation.playState !== 'idle') entry.animation.play()
    }
    entries.clear()
    roots.clear()
  }
}
