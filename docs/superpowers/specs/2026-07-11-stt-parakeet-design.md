# STT no servidor com NVIDIA Parakeet v3 — Design

**Data:** 2026-07-11
**Status:** Aprovado (decisão do usuário após o Whisper-no-navegador se mostrar insuficiente)

## Objetivo

Substituir a transcrição do microfone no navegador (Whisper base/WASM, pseudo-streaming)
por transcrição **no backend** com **NVIDIA Parakeet v3** (via sherpa-onnx): gravar →
parar → enviar o áudio ao servidor local → receber o texto completo, pontuado e com
maiúsculas, no campo de mensagem. Áudio continua 100% na máquina (servidor é 127.0.0.1).

## Por que trocar (evidência)

- Whisper `base` q8/WASM alucinava com o sinal fraco do mic do usuário ("Distance of a",
  "[Música]", loops "speak language") e o pseudo-streaming re-transcrevia texto que se
  apagava/reescrevia — experiência ruim.
- Inferência WASM na thread principal congelava a UI (timer preso em 0:01).
- **Spike validado na máquina do usuário (2026-07-11):** sherpa-onnx-node 1.13.4 +
  `sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8` transcreveu os WAVs de teste
  perfeitamente, com pontuação: es 5,3s→193ms, en 11s→379ms (~30× tempo real, CPU).
  25 línguas (incl. português), detecção automática de idioma, resampler embutido.

## Fatos do ambiente (do spike)

- Zorin 16.3 (Ubuntu 20.04), glibc 2.31, GLIBCXX máx 3.4.28. O prebuilt do sherpa-onnx
  exige GLIBCXX_3.4.29 → **carregar um `libstdc++.so.6.0.30` portátil**
  (conda-forge `libstdcxx-ng-12.2.0-h46fd767_19`, compilado p/ glibc 2.17) via
  `LD_LIBRARY_PATH`, **sem tocar no sistema**.
- `LD_LIBRARY_PATH` é lido no arranque do processo → a transcrição roda num
  **processo filho** spawnado com o env certo (funciona independente de como o servidor
  foi iniciado).
- URLs validadas:
  - modelo: `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2` (~630MB)
  - libstdc++: `https://conda.anaconda.org/conda-forge/linux-64/libstdcxx-ng-12.2.0-h46fd767_19.tar.bz2` (~11KB)
- API sherpa-onnx-node (validada): `new OfflineRecognizer({ featConfig: {sampleRate:16000, featureDim:80}, modelConfig: { transducer: {encoder,decoder,joiner}, tokens, numThreads:8, provider:'cpu', modelType:'nemo_transducer' } })`; `createStream()` → `stream.acceptWaveform({samples,sampleRate})` → `recognizer.decode(stream)` → `recognizer.getResult(stream).text`. `sherpa.readWave(path)` lê WAV.
- O addon nativo precisa de `LD_LIBRARY_PATH` incluindo `node_modules/sherpa-onnx-linux-x64` (libs .so do pacote) **e** o dir do libstdc++ portátil.

## Componentes

### Setup (1×): `server/scripts/setup-speech.mjs` + `npm run setup:speech`
- Baixa e extrai modelo + libstdc++ para `config.speechDir` (`~/.termaster/speech`,
  override `CLAUDINEI_SPEECH`). Idempotente: se os arquivos finais existem, pula.
- Usa `curl -L` + `tar xjf` (spike validou ambos na máquina alvo).
- Estrutura final:
  - `~/.termaster/speech/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/{encoder,decoder,joiner}.int8.onnx`, `tokens.txt`
  - `~/.termaster/speech/stdcxx/lib/libstdc++.so.6*`

### `server/src/speech/paths.ts`
- `speechPaths(speechDir)` → caminhos do modelo/tokens/stdcxx (pura).
- `speechInstalled(speechDir)` → boolean (todos os arquivos presentes).

### `server/src/speech/worker.mjs` (roda no processo filho)
- Carrega `sherpa-onnx-node`, cria o `OfflineRecognizer` (paths via env `SPEECH_DIR`),
  imprime `{"type":"ready"}` e então lê JSON-lines do stdin:
  `{"id":1,"wav":"/tmp/x.wav"}` → responde no stdout `{"id":1,"text":"..."}` ou
  `{"id":1,"error":"..."}`. Uma requisição por vez (decode é ~centenas de ms).

### `server/src/speech/transcriber.ts`
- `createSpeechService(opts: { speechDir, serverDir, workerPath?, nodeBin? })`:
  - `installed()` → `speechInstalled(speechDir)`.
  - `transcribe(wavPath): Promise<string>` — lazy-spawna o filho
    (`node worker.mjs`, cwd=serverDir, env com `LD_LIBRARY_PATH` =
    `speech/stdcxx/lib:node_modules/sherpa-onnx-linux-x64` e `SPEECH_DIR`), espera o
    `ready`, correlaciona por id, timeout 30s por requisição, serializa (fila).
  - Filho morre → rejeita pendentes e re-spawna na próxima chamada.
  - `stop()` para o filho (shutdown do servidor).
- `workerPath`/`nodeBin` injetáveis p/ teste (fake worker, mesmo padrão do fake-claude).

### Rota `POST /api/transcribe` (`server/src/routes/transcribe.ts`)
- Body: WAV cru (`Content-Type: audio/wav`, contentTypeParser → Buffer, limite 30MB).
- Sem setup → **503** `{ error: 'modelo de transcrição não instalado — rode npm run setup:speech' }`.
- Grava o buffer num tmp (dentro de `uploadsDir`), chama `transcribe(tmp)`, apaga o tmp
  (finally), responde `{ text }`. Erro do engine → 500; timeout → 504.
- Deps injetáveis (`{ speech }`) no padrão das outras rotas.

### Web: `web/src/speech/wav.ts`
- `pcmToWav(pcm: Float32Array, sampleRate = 16000): Blob` — WAV PCM16 mono
  (header RIFF 44 bytes + amostras com clamp [-1,1]). Pura e testável.

### Web: `web/src/speech/audio.ts`
- Recebe `rmsOf` e `normalizePeak` (movidos do transcriber.ts, que será apagado).

### Web: `MicButton.tsx` (rework)
- Estados: `idle | recording | transcribing` (o `loading` de modelo morre — não há
  mais download no navegador; a chave i18n `mic.transcribing` passa a ser usada).
- Gravar: `startMicCapture` como hoje (PCM 16kHz), timer, ⏺ vermelho pulsando.
  **Sem transcrição parcial** (o onBuffer vira no-op) → sai a trava `busyRef`.
- Parar: `pcm = stop()`; RMS < 0.005 → aviso `mic.errLowSignal` (mantido); senão
  estado `transcribing` (botão mostra `…`), `normalizePeak(pcm)` → `pcmToWav` →
  `transcribeAudio(blob)` → `onText(texto)` → `onDone()`. Falha do POST →
  `mic.errTranscribe` (chave nova nas 3 línguas).
- `genRef` (geração) continua: unmount/regravação rápida não aplicam resultado velho.
- Prop `lang` sai (Parakeet auto-detecta o idioma).
- `api.ts`: `transcribeAudio(blob: Blob): Promise<{ text: string }>`.

### Remoções
- `web/src/speech/transcriber.ts` inteiro (loadTranscriber/pickDevice/serialized/
  MODEL_ID/whisperLang) e seus testes.
- Dependência `@huggingface/transformers` do `web/package.json` (bundle web emagrece).

## Fluxo

```
🎤 → grava (timer ⏺ m:ss) → 🎤 de novo
  → RMS baixo? → aviso "sinal muito baixo" (não envia)
  → senão: normaliza → WAV → POST /api/transcribe (127.0.0.1)
      → filho sherpa/Parakeet (quente após a 1ª) → { text }
  → texto completo (pontuado) entra no campo na posição do cursor
  → usuário revisa → Enter
```

## Erros / bordas

| Situação | Comportamento |
|---|---|
| Modelo não baixado | 503 + aviso no campo com instrução do setup |
| Filho morre / engine falha | 500 → `mic.errTranscribe`; filho re-spawna na próxima |
| Timeout (>30s) | 504 → `mic.errTranscribe` |
| Sinal quase mudo | aviso local, não envia ao servidor |
| Servidor fora | fetch falha → `mic.errTranscribe` |
| 2 gravações rápidas | `genRef` descarta o resultado da sessão superada |

## Testes

- **paths.ts:** speechPaths/speechInstalled com dirs temporários.
- **transcriber.ts (server):** com **fake worker** (script .mjs que responde canned):
  ready→transcribe→texto; erro do worker → rejeição; morte do filho → pendentes
  rejeitadas + re-spawn; serialização (2 chamadas concorrentes → em ordem).
- **rota:** inject com speech fake — 200 {text}, 503 sem setup, 500 erro, tmp apagado.
- **wav.ts:** header RIFF correto (magic, tamanhos, canais, rate), PCM16 com clamp.
- **MicButton:** gravar→parar→fetch mock→onText(texto completo)+onDone; sinal baixo →
  errLowSignal sem fetch; falha do fetch → errTranscribe; estado transcribing visível.
- **i18n:** paridade incluindo `mic.errTranscribe` (e `mic.loading` sai das 3 línguas
  junto com o estado — manter paridade).
- **Smoke (controlador):** rota real com o modelo do spike (pré-copiado p/
  `~/.termaster/speech`) + `curl` com WAV real → texto correto. Smoke de microfone de
  ponta a ponta: usuário.

## Fora de escopo (YAGNI)

- TTS Edge (feature seguinte, separada).
- Streaming ao vivo (decisão: transcrição completa no parar).
- GPU/CUDA no sherpa (CPU já é 30× tempo real).
- Configuração de modelo pela UI.
