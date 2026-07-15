# STT ao vivo (parciais durante a gravação) — Design

**Data:** 2026-07-11
**Status:** Aprovado (usuário: "vamos trabalhar no modo ao vivo")

## Objetivo

Enquanto o usuário grava, o texto transcrito aparece **ao vivo** no campo de mensagem,
atualizando-se conforme mais fala chega; ao parar, a transcrição final (áudio completo)
substitui tudo e continua sendo a autoridade. Reintroduz a experiência "ver o texto
enquanto falo" — agora viável porque o Parakeet no servidor transcreve 5s de áudio em
~170ms (medido no smoke), fora da thread da UI.

## Por que agora é diferente do pseudo-streaming antigo (removido)

- Motor ~50× mais rápido e **no servidor** — a UI não congela, o timer anda.
- Qualidade Parakeet (pontuação, acerto) — o texto se estabiliza em vez de "dançar".
- Infra pronta: o `recorder.ts` já entrega o buffer ACUMULADO a cada `intervalMs`
  (1500ms default) via `onBuffer` — o MicButton atual passa um no-op; é religar.
  O `applyTranscript` do ChatInput já substitui a mesma região (base no `onStart`).
  O endpoint `/api/transcribe` já serializa requisições (fila no processo filho).

## Mecânica (tudo no `MicButton.tsx` — nenhuma mudança de servidor)

1. `startMicCapture(onBuffer)` volta a receber um handler real. A cada tick (~1,5s),
   o `onBuffer` recebe o PCM acumulado.
2. **Backpressure:** se já existe uma parcial em voo, o tick é ignorado (flag
   `liveBusyRef` booleana — sem fila no cliente; o próximo tick pega o buffer maior).
   Com áudio longo, o decode passa do intervalo e o ritmo se auto-regula.
3. Gate de RMS: buffer com `rmsOf < 0.005` é pulado em silêncio (não alucina ao vivo).
4. Parcial: `normalizePeak` → `pcmToWav` → `deps.transcribeAudio(...)` →
   se `genRef.current === gen` (gravação ainda é a atual) → `onText(text)`.
5. Falha de parcial é silenciosa (o próximo tick tenta de novo); só a FINAL mostra
   `mic.errTranscribe`.
6. Parar: fluxo atual intacto — `genRef.current++` invalida parciais em voo
   (uma parcial que resolva depois do stop é descartada), estado `transcribing`,
   POST final com o áudio completo, `onText(final)` gateado por `gen + 1`, `onDone()`.

## Interfaces (mudanças)

- `MicButton.tsx`: substitui o `() => {}` do `startMicCapture` por `onLiveBuffer`
  (função interna). Nenhuma prop nova; `MicDeps` inalterado.
- Sem mudanças em: recorder, wav, audio, api, ChatInput, servidor, i18n.

## Erros / bordas

| Situação | Comportamento |
|---|---|
| Parcial em voo quando chega novo tick | tick ignorado (backpressure) |
| Parcial resolve após o stop | descartada (`genRef` — a final vence) |
| Parcial resolve após regravação rápida | descartada (gen antigo) |
| Parcial falha (servidor caiu etc.) | silêncio; próximo tick tenta; a final reporta se persistir |
| Buffer do tick quase mudo | pulado sem aviso (o aviso de sinal baixo continua só no stop) |
| Unmount durante parcial em voo | `genRef++` do cleanup suprime o onText tardio |

## Testes (web/src/test/mic-button.test.tsx)

- Tick com fala → POST parcial (WAV) → `onText(parcial)` durante recording.
- Backpressure: 2 ticks com a 1ª parcial pendente → só 1 POST.
- Parcial pendente + stop → final aplica; parcial tardia descartada (não sobrescreve).
- Tick quase mudo → nenhum POST.
- Falha da parcial → sem `onError`; gravação segue; stop normal funciona.
- Os testes existentes (stop→final, low-signal, unmount, regravação, errCapture)
  continuam passando.

## Fora de escopo (YAGNI)

- Streaming word-a-word verdadeiro (Parakeet TDT é offline; exigiria outro modelo).
- Mudanças de servidor/protocolo (a fila existente já serializa).
- Janela deslizante para gravações muito longas (backpressure basta; revisitar se
  o usuário gravar minutos e sentir lag).
