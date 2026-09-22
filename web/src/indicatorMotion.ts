/** Decorative indicators keep their CSS artwork and timing, but do not need
 * the display's 60/120/144 Hz refresh rate. Sample the browser's own interpolation
 * once, then let native stepped keyframes play it. There is no per-frame JS
 * playback loop; preparation alone is split into small batches.
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
  original?: Keyframe[]
  needsSampling: boolean
  sampling?: Sampling
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

interface Sampling {
  animation: Animation
  effect: KeyframeEffect
  timing: EffectTiming
  duration: number
  original: Keyframe[]
  keys: string[]
  frames: Keyframe[]
  count: number
}

function prepareSampling(animation: Animation, fps: number): Sampling | undefined {
  const effect = animation.effect as KeyframeEffect | null
  if (!effect?.target) return
  const timing = effect.getTiming()
  const duration = typeof timing.duration === 'number' ? timing.duration : NaN
  if (!Number.isFinite(duration) || duration <= 0 || timing.iterations !== Infinity || timing.direction !== 'normal' || timing.iterationStart !== 0) return
  const original = effect.getKeyframes()
  const keys = [...new Set(original.flatMap(frame => Object.keys(frame)))].filter(key => !metadata.has(key))
  if (!keys.length || keys.some(key => !properties.has(key))) return
  // Bound initial work even if a future indicator accidentally uses hours.
  const count = Math.min(240, Math.max(2, Math.ceil(duration * fps / 1000)))
  return { animation, effect, timing, duration, original, keys, frames: [], count }
}

/** Reads a batch of poses, always restoring native playback before the next
 * paint. Even one long animation can be expensive to sample in WebKit: yielding
 * between animations alone is not enough. Only publish the completed sequence.
 */
function advanceSampling(sampling: Sampling, deadline = Infinity): boolean {
  const { animation, effect, timing, duration, original, keys, frames, count } = sampling
  const time = animation.currentTime
  const running = animation.playState === 'running'
  try {
    animation.pause()
    effect.updateTiming({ iterations: 1, fill: 'both' })
    do {
      const i = frames.length
      animation.currentTime = (timing.delay ?? 0) + duration * i / count
      const style = getComputedStyle(effect.target!, effect.pseudoElement)
      const frame: Keyframe = { offset: i / count, easing: 'steps(1, end)' }
      for (const key of keys) frame[key] = (style as unknown as Record<string, string>)[key]
      frames.push(frame)
    } while (frames.length <= count && performance.now() < deadline)
    const complete = frames.length > count
    if (complete) effect.setKeyframes(frames)
    return complete
  } catch (err) {
    effect.setKeyframes(original)
    throw err
  } finally {
    effect.updateTiming({ ...timing, duration })
    animation.currentTime = time
    if (running) animation.play()
  }
}

/** Synchronous variant for isolated callers. The installed controller below
 * batches the same native interpolation across frames during preparation only.
 */
export function sampleIndicator(animation: Animation, fps = INDICATOR_FPS): boolean {
  const sampling = prepareSampling(animation, fps)
  return sampling ? advanceSampling(sampling) : false
}

export function installIndicatorMotion(doc: Document = document): () => void {
  if (typeof CSSAnimation === 'undefined' || !doc.getAnimations || typeof IntersectionObserver === 'undefined') return () => {}
  const entries = new Map<CSSAnimation, Entry>()
  const roots = new Map<Element, { visible: boolean; width: number; height: number }>()
  const reduced = matchMedia('(prefers-reduced-motion: reduce)')
  let frame = 0
  let samplingFrame = 0
  let discoveryPending = false
  let interactionTimer: ReturnType<typeof setTimeout> | undefined
  const pointers = new Set<number>()
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
      for (const entry of entries.values()) if (entry.root === change.target) {
        entry.visible = state.visible
        if (entry.visible && entry.needsSampling) queueSampling()
      }
    }
    activity()
  }, { rootMargin: '24px' })

  const queue = (resample = false) => {
    if (disposed) return
    rebuild ||= resample
    discoveryPending = true
    if (pointers.size || interactionTimer !== undefined) return
    if (!frame) frame = requestAnimationFrame(refresh)
  }

  const queueSampling = () => {
    if (!disposed && !pointers.size && interactionTimer === undefined && !samplingFrame) {
      samplingFrame = requestAnimationFrame(sampleVisible)
    }
  }

  // Native playback keeps its artwork and timing during a gesture. Only the
  // preparation work waits: even short style-reading batches compete with touch
  // navigation and momentum scrolling, especially in WebKit.
  const deferPreparation = () => {
    if (disposed) return
    if (frame) {
      cancelAnimationFrame(frame)
      frame = 0
    }
    cancelAnimationFrame(samplingFrame)
    samplingFrame = 0
    clearTimeout(interactionTimer)
    interactionTimer = setTimeout(() => {
      interactionTimer = undefined
      if (disposed || pointers.size) return
      if (discoveryPending) queue()
      if ([...entries.values()].some(entry => entry.visible && entry.needsSampling)) queueSampling()
    }, 180)
  }
  const pointerDown = (event: PointerEvent) => { pointers.add(event.pointerId); deferPreparation() }
  const pointerUp = (event: PointerEvent) => { pointers.delete(event.pointerId); deferPreparation() }
  const releasePointers = () => { pointers.clear(); deferPreparation() }

  const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(changes => {
    for (const change of changes) {
      const state = roots.get(change.target)
      if (!state) continue
      const { width, height } = change.contentRect
      if (state.width !== width || state.height !== height) {
        // The first notification records the size, not a resize. Resampling
        // every indicator here used to repeat the entire startup cost.
        const changed = state.width >= 0 && state.height >= 0
        state.width = width
        state.height = height
        if (changed) {
          for (const entry of entries.values()) if (entry.root === change.target) {
            entry.needsSampling = true
            entry.sampling = undefined
          }
          queue()
        }
      }
    }
  })

  function refresh() {
    frame = 0
    if (disposed) return
    discoveryPending = false
    const all = new Set(doc.getAnimations())
    if (rebuild) {
      sources = keyframeRules(doc)
      for (const entry of entries.values()) {
        entry.needsSampling = true
        entry.sampling = undefined
      }
    }
    for (const [animation] of entries) if (!all.has(animation)) entries.delete(animation)
    for (const animation of all) {
      if (!(animation instanceof CSSAnimation) || !names.test(animation.animationName)) continue
      const effect = animation.effect as KeyframeEffect | null
      const target = effect?.target
      if (!effect || !(target instanceof Element)) continue
      const root = target.closest(rootSelector) ?? target
      if (!root.isConnected) continue
      let entry = entries.get(animation)
      if (!entry) {
        let state = roots.get(root)
        if (!state) {
          state = { visible: false, width: -1, height: -1 }
          roots.set(root, state)
          intersection.observe(root)
          resize?.observe(root)
        }
        entry = { animation, effect, root, needsSampling: true, visible: state.visible, pausedByUs: false }
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
    if ([...entries.values()].some(entry => entry.visible && entry.needsSampling)) queueSampling()
  }

  function sampleVisible() {
    samplingFrame = 0
    if (disposed || rebuild) return
    // Measuring each intermediate pose forces style work. Hidden mobile drawers
    // and offscreen rows need no samples. Spread visible work across frames so a
    // large list cannot monopolize the main thread on slower devices. Native CSS
    // keeps playing until that animation has its sampled frames ready.
    if (doc.hidden || reduced.matches || doc.documentElement.dataset.motion === 'reduced') return
    const deadline = performance.now() + 8
    for (const entry of entries.values()) {
      if (!entry.visible || !entry.needsSampling) continue
      // Discovery is event-driven. Do not call document.getAnimations() for
      // every preparation batch: that can itself force a document-wide update.
      if (!entry.root.isConnected || entry.animation.playState === 'idle') { queue(); continue }
      if (performance.now() >= deadline) { queueSampling(); break }
      try {
        if (!entry.sampling) {
          const original = sourceFrames(sources.get(entry.animation.animationName), entry.effect)
          entry.effect.setKeyframes(original)
          entry.original = original
          entry.sampling = prepareSampling(entry.animation, INDICATOR_FPS)
        }
        if (!entry.sampling || advanceSampling(entry.sampling, deadline)) {
          entry.needsSampling = false
          entry.sampling = undefined
        }
      } catch {
        // Unsupported effects keep their native CSS artwork and timing.
        entry.needsSampling = false
        entry.sampling = undefined
      }
      if (entry.needsSampling) { queueSampling(); break }
    }
  }

  const started = () => queue()
  const appearanceChanged = () => { activity(); queue(true) }
  const visibilityChanged = () => {
    // A browser/app switch can consume pointerup. Do not leave preparation
    // permanently suspended when the page returns.
    pointers.clear()
    clearTimeout(interactionTimer)
    interactionTimer = undefined
    activity()
    if (!doc.hidden) queue()
  }
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
  const passiveCapture = { passive: true, capture: true }
  doc.addEventListener('pointerdown', pointerDown, passiveCapture)
  doc.addEventListener('pointerup', pointerUp, passiveCapture)
  doc.addEventListener('pointercancel', pointerUp, passiveCapture)
  doc.addEventListener('scroll', deferPreparation, passiveCapture)
  doc.addEventListener('wheel', deferPreparation, passiveCapture)
  doc.defaultView?.addEventListener('blur', releasePointers)
  reduced.addEventListener('change', appearanceChanged)
  queue()

  return () => {
    disposed = true
    cancelAnimationFrame(frame)
    cancelAnimationFrame(samplingFrame)
    clearTimeout(interactionTimer)
    pointers.clear()
    removal.disconnect()
    appearance.disconnect()
    intersection.disconnect()
    resize?.disconnect()
    doc.removeEventListener('animationstart', started, true)
    doc.removeEventListener('animationcancel', started, true)
    doc.removeEventListener('visibilitychange', visibilityChanged)
    doc.removeEventListener('pointerdown', pointerDown, true)
    doc.removeEventListener('pointerup', pointerUp, true)
    doc.removeEventListener('pointercancel', pointerUp, true)
    doc.removeEventListener('scroll', deferPreparation, true)
    doc.removeEventListener('wheel', deferPreparation, true)
    doc.defaultView?.removeEventListener('blur', releasePointers)
    reduced.removeEventListener('change', appearanceChanged)
    for (const entry of entries.values()) {
      if (entry.original) entry.effect.setKeyframes(entry.original)
      if (entry.pausedByUs && entry.animation.playState !== 'idle') entry.animation.play()
    }
    entries.clear()
    roots.clear()
  }
}
