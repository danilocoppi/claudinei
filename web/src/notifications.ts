import type { SessionStatus } from './types'
import i18n from './i18n'

export function shouldNotify(status: SessionStatus, prev: SessionStatus | undefined): { notify: boolean; title?: string } {
  if (!prev) return { notify: false }
  if (status === 'needs_attention' && prev === 'working') return { notify: true, title: i18n.t('notify.needsAttention') }
  if (status === 'dead') return { notify: true, title: i18n.t('notify.died') }
  return { notify: false }
}

export function initNotifications(): void {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission()
  }
}

let audioCtx: AudioContext | undefined
function beep(): void {
  try {
    audioCtx ??= new AudioContext()
    const osc = audioCtx.createOscillator()
    const gain = audioCtx.createGain()
    osc.connect(gain); gain.connect(audioCtx.destination)
    osc.frequency.value = 880
    gain.gain.setValueAtTime(0.08, audioCtx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.35)
    osc.start(); osc.stop(audioCtx.currentTime + 0.35)
  } catch { /* som é best-effort */ }
}

export function notifySessionChange(projectName: string, status: SessionStatus, prev: SessionStatus | undefined): void {
  const { notify, title } = shouldNotify(status, prev)
  if (!notify) return
  beep()
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification(`Claudinei · ${projectName}`, { body: title })
  }
}
