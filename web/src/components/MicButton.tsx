import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { startMicCapture as defaultCapture, micSupported, type MicHandle } from '../speech/recorder'
import { rmsOf, normalizePeak } from '../speech/audio'
import { pcmToWav } from '../speech/wav'
import { transcribeAudio as defaultTranscribe } from '../api'
import { useMicShortcut } from '../speech/shortcut'

export interface MicDeps {
  startMicCapture: (onBuffer: (pcm: Float32Array) => void, intervalMs?: number) => Promise<MicHandle>
  transcribeAudio: (wav: Blob) => Promise<{ text: string }>
  /** Relógio do atalho (toque × segurar). Injetável nos testes. */
  now?: () => number
}

const realDeps: MicDeps = { startMicCapture: defaultCapture, transcribeAudio: defaultTranscribe }

/** Abaixo deste RMS a gravação é ruído de fundo (mic mudo/ganho zerado): fala normal
 *  fica em 0.02–0.15; um mic surdo mede ~0.001. Transcrever isso só gera alucinação. */
const LOW_SIGNAL_RMS = 0.005

function fmt(s: number): string {
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

/**
 * Botão de microfone: grava → parar → transcreve NO SERVIDOR (Parakeet) → preenche
 * o campo via `onText` com o texto completo. Só edita texto; o envio é do ChatInput.
 */
export function MicButton({
  disabled,
  onText,
  onDone,
  onError,
  onStart,
  field,
  deps = realDeps,
}: {
  disabled?: boolean
  onText: (t: string) => void
  onDone: () => void
  onError: (msg: string) => void
  onStart?: () => void
  /** Campo do chat: o Ctrl+Espaço funciona com o foco nele (ou fora de campos) e o leva até lá. */
  field?: { readonly current: HTMLElement | null }
  deps?: MicDeps
}): JSX.Element | null {
  const { t } = useTranslation()
  const [state, setState] = useState<'idle' | 'recording' | 'transcribing'>('idle')
  const [secs, setSecs] = useState(0)
  const handleRef = useRef<MicHandle | null>(null)
  const genRef = useRef(0) // id da sessão de gravação; invalida resultados de sessões antigas
  const startingRef = useRef(false) // microfone abrindo (getUserMedia em curso)

  useEffect(() => {
    if (state !== 'recording') return
    setSecs(0)
    const id = setInterval(() => setSecs((s) => s + 1), 1000)
    return () => clearInterval(id)
  }, [state])

  // Ao desmontar: invalida a sessão em voo e libera o microfone.
  useEffect(() => () => {
    genRef.current++
    handleRef.current?.stop()
    handleRef.current = null
  }, [])

  // Antes do `return null`: hook não pode ser condicional.
  useMicShortcut({
    enabled: !disabled && micSupported(),
    active: () => !!handleRef.current || startingRef.current,
    start: () => { field?.current?.focus(); void startRecording() },
    stop: () => {
      if (handleRef.current) void stopRecording()
      // Soltou antes de o microfone abrir: invalida a abertura, que libera o
      // microfone assim que chegar em vez de começar a gravar sozinha.
      else if (startingRef.current) { genRef.current++; startingRef.current = false }
    },
    field: () => field?.current ?? null,
    now: deps.now,
  })

  if (!micSupported()) return null

  async function startRecording() {
    const gen = ++genRef.current
    startingRef.current = true
    try {
      // Ao vivo: a cada tick do recorder (buffer ACUMULADO), transcreve e atualiza o
      // campo. Backpressure: com uma parcial em voo, o tick é ignorado — o próximo
      // pega o buffer maior. Falha de parcial é silenciosa (a FINAL do stop reporta).
      let liveBusy = false
      const onLiveBuffer = async (pcm: Float32Array) => {
        if (genRef.current !== gen || liveBusy || pcm.length === 0) return
        if (rmsOf(pcm) < LOW_SIGNAL_RMS) return // só ruído até aqui — não alucinar ao vivo
        liveBusy = true
        try {
          const { text } = await deps.transcribeAudio(pcmToWav(normalizePeak(pcm)))
          if (genRef.current === gen) onText(text) // só aplica se a gravação ainda é a atual
        } catch {
          /* parcial falhou — silêncio; o próximo tick tenta e a final reporta se persistir */
        } finally {
          liveBusy = false
        }
      }
      const handle = await deps.startMicCapture(onLiveBuffer)
      if (genRef.current === gen) startingRef.current = false
      if (genRef.current !== gen) {
        handle.stop() // sessão abandonada durante o start → libera o microfone
        return
      }
      handleRef.current = handle
      setState('recording')
      onStart?.()
    } catch (err) {
      if (genRef.current !== gen) return
      startingRef.current = false
      const name = (err as { name?: string })?.name
      onError(name === 'NotAllowedError' || name === 'SecurityError' ? t('mic.errPermission') : t('mic.errCapture'))
    }
  }

  async function stopRecording() {
    const handle = handleRef.current
    if (!handle) return
    handleRef.current = null
    const gen = genRef.current
    genRef.current++
    const pcm = handle.stop()
    if (pcm.length === 0) { setState('idle'); onDone(); return }
    if (rmsOf(pcm) < LOW_SIGNAL_RMS) {
      setState('idle')
      onError(t('mic.errLowSignal'))
      onDone()
      return
    }
    setState('transcribing')
    try {
      const { text } = await deps.transcribeAudio(pcmToWav(normalizePeak(pcm)))
      if (genRef.current === gen + 1) onText(text)
    } catch {
      if (genRef.current === gen + 1) onError(t('mic.errTranscribe'))
    } finally {
      if (genRef.current === gen + 1) {
        setState('idle')
        onDone()
      }
    }
  }

  const onClick = () => {
    if (state === 'recording') void stopRecording()
    else void startRecording() // idle OU transcribing: começar nova gravação invalida a anterior
  }

  const label = state === 'recording' ? t('mic.stop') : state === 'transcribing' ? t('mic.transcribing') : t('mic.start')
  return (
    <button
      type="button"
      aria-label={label}
      title={`${label} — ${t('mic.shortcut')}`}
      disabled={disabled}
      className={state === 'recording' ? 'input-action mic-btn--rec' : 'input-action'}
      onClick={onClick}
    >
      {state === 'transcribing' ? '…' : state === 'recording' ? `⏺ ${fmt(secs)}` : '🎤'}
    </button>
  )
}
