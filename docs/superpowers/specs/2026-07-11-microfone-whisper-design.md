# Microfone com transcrição local (Whisper, pseudo-streaming) — Design

**Data:** 2026-07-11
**Status:** Aprovado (brainstorming) → pronto para plano de implementação

## Objetivo

Um botão de microfone no campo de mensagem do chat que grava a voz e a
transcreve **100% localmente** (o áudio nunca sai da máquina), mostrando o
texto **ao vivo** (pseudo-streaming) no campo de digitar. O usuário revisa e
envia (preencher-e-confirmar).

## Decisões (brainstorming)

1. **Arquitetura: Whisper no navegador via `@huggingface/transformers`**
   (transformers.js v3), ONNX rodando em **WebGPU se disponível, WASM (CPU)
   como fallback**. O usuário rejeitou a Web Speech API por privacidade
   (envia áudio ao Google); aqui o áudio nunca deixa o browser.
2. **Modelo: `onnx-community/whisper-base`** (multilíngue, ~145MB ONNX).
   Baixado 1x do HuggingFace CDN e cacheado no navegador. `MODEL_ID` fica numa
   constante fácil de trocar (`tiny`/`base`/`small`).
3. **Modo: pseudo-streaming** — re-transcreve o buffer acumulado a cada ~1,5s
   e atualiza o campo ao vivo; o texto pode se ajustar conforme mais contexto
   chega (natural do Whisper).
4. **Carregamento sob demanda:** a lib e o modelo só carregam na 1ª vez que o
   microfone é usado (dynamic `import()`), sem pesar o load inicial do app.
5. **Idioma fixado no locale atual do app** (pt-BR/en/es) — mais preciso que
   auto-detect.
6. **Inserção: preencher-e-confirmar** — o texto entra no campo (substituindo
   a região transcrita ao vivo); ao parar, fica lá para revisar e enviar com
   Enter.

## Fatos do ambiente

- Máquina com **24 núcleos** → transcrição por CPU (WASM) é viável mesmo sem
  GPU.
- WebGPU: incerto no Chrome do usuário (o Chromium do playwright não tem
  adapter, mas é artefato do modo automatizado). O código usa WebGPU quando
  há adapter e cai para WASM caso contrário.
- App servido em `localhost` (contexto seguro) → `getUserMedia` permitido.

## Componentes

### `web/src/speech/transcriber.ts`
- `type Transcriber = (pcm: Float32Array, lang: string) => Promise<string>`
- `loadTranscriber(onProgress?: (p: number) => void): Promise<Transcriber>` —
  faz `import('@huggingface/transformers')` (dynamic), cria o
  `pipeline('automatic-speech-recognition', MODEL_ID, { device })` escolhendo
  `webgpu` se `navigator.gpu` tiver adapter, senão `wasm`; memoiza o pipeline
  (carrega 1x). Retorna a função `transcribe`.
- `transcribe(pcm, lang)` chama o pipeline com `{ language: lang, task:
  'transcribe', chunk_length_s: 30 }` e devolve `.text.trim()`.
- `MODEL_ID = 'onnx-community/whisper-base'` (constante exportada).
- `whisperLang(locale: string): 'portuguese'|'english'|'spanish'` — mapeia o
  locale do i18n (`pt-BR`/`en`/`es`) para o nome que o Whisper espera.

### `web/src/speech/recorder.ts`
- `micSupported(): boolean` — `!!navigator.mediaDevices?.getUserMedia`.
- `startMicCapture(onBuffer: (pcm: Float32Array) => void, intervalMs = 1500):
  Promise<() => Float32Array>` — pede o microfone, cria um `AudioContext`
  (16kHz), acumula PCM mono Float32; a cada `intervalMs` chama `onBuffer` com o
  **buffer acumulado**; retorna uma função `stop()` que encerra a captura e
  devolve o buffer final. (Camada fina sobre APIs do browser — coberta por
  smoke, não unit.)

### `web/src/components/MicButton.tsx`
- Props: `{ lang: string; disabled?: boolean; onText: (fullTranscript: string) => void; onDone: () => void }`
  e (para testes) `deps?: { loadTranscriber; startMicCapture }` injetáveis.
- Estados: `idle` | `loading` (baixando/carregando modelo) | `recording`.
- Fluxo ao clicar (idle→): garante o transcriber (`loading` na 1ª vez, com
  progresso), inicia a captura; a cada buffer, transcreve e chama
  `onText(texto)`; mostra timer (mm:ss) e "transcrevendo…". Clicar de novo
  (recording→idle): `stop()`, transcrição final, `onText(final)` + `onDone()`.
- Se `!micSupported()`, não renderiza (botão escondido).
- Erros: permissão negada / falha de modelo → estado idle + `onError` (aviso
  no ChatInput). 

### `web/src/components/ChatInput.tsx`
- Renderiza `<MicButton lang={i18n.language} onText={applyTranscript} onDone={endMic} onError={setMicError} />`
  ao lado do 🎤 (antes do SessionControls/Enviar).
- Ao começar a gravar, guarda uma base: texto + posição do cursor. Cada
  `applyTranscript(t)` faz `setText(before + t + after)` — a região transcrita
  cresce ao vivo; `endMic` fixa o resultado. Reaproveita o padrão de inserção
  no cursor já usado no upload/slash.
- `micError` exibido na linha de aviso existente (mesma do uploadError).

## Fluxo

```
clica 🎤 (1ª vez)
  → import('@huggingface/transformers') + pipeline(whisper-base)  [loading + progresso]
  → getUserMedia → captura PCM 16kHz
  → a cada 1,5s: transcribe(buffer, 'portuguese') → onText(texto)  [campo cresce ao vivo]
clica 🎤 de novo
  → stop() → transcrição final → texto fica no campo
usuário revisa/edita → Enter → envia (fluxo normal)
```

## Tratamento de erros / bordas

| Situação | Comportamento |
|---|---|
| Sem suporte a getUserMedia (browser antigo) | botão do microfone escondido |
| Permissão de microfone negada | volta a idle; aviso "permita o microfone" |
| Falha ao baixar/carregar o modelo (1ª vez, offline) | idle; aviso "não foi possível carregar o modelo de transcrição" |
| Sem WebGPU | usa WASM (CPU) automaticamente |
| Gravação muito longa | re-transcreve o buffer acumulado; documentado que acima de ~30s pode desacelerar (uso de chunk_length_s=30) |
| Sessão em qualquer status | o microfone só edita o campo local; o envio segue as regras atuais (permitido inclusive em working) |

## Testes

- **`transcriber.ts`:** `whisperLang` mapeia pt-BR/en/es corretamente; a
  seleção de device (webgpu quando `navigator.gpu`, senão wasm) é testável com
  stub de `navigator.gpu`. O pipeline real (WASM) é smoke manual.
- **`MicButton.tsx`** (com `deps` mockados): clicar carrega e inicia (estado
  recording, timer visível); um `onBuffer` do recorder-mock chama `onText`
  com o texto transcrito-mock; clicar de novo para e chama `onDone`; sem
  suporte → não renderiza; erro de permissão → idle + `onError`.
- **`ChatInput`:** `onText('ola mundo')` coloca o texto no campo na posição do
  cursor; `onError` mostra o aviso.
- **i18n:** chaves `mic.*` nas 3 línguas.
- O motor Whisper real (transformers.js/WASM) é validado por **smoke manual**
  no navegador (falar → ver o texto aparecer).

## Dependências

- `@huggingface/transformers` (^3.x), **dynamic import** (chunk separado
  carregado sob demanda — não infla o bundle inicial). O modelo e o runtime
  ONNX WASM vêm do HF CDN/jsdelivr na 1ª vez, cacheados no navegador.

## Fora de escopo (YAGNI)

- Backend whisper.cpp (decidido: navegador).
- Streaming word-a-word verdadeiro (Whisper é batch; pseudo-streaming é o
  máximo viável localmente).
- Bundlar o modelo no app (baixa do HF CDN 1x, cacheado).
- Comandos de voz / pontuação automática além do que o Whisper já faz.
- Transcrição de arquivos de áudio enviados (só microfone ao vivo).
