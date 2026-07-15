#!/usr/bin/env node
// Shim fino: a lógica real do worker de transcrição mora em
// server/src/speech/run-worker.ts (Task 3 do binário único — mesmo padrão do
// shim server/hermes/hermes-mcp.mjs pro hermes, Task 1). Este arquivo é o alvo
// padrão do transcriber.ts em dev (nodeBin=process.execPath/node,
// workerPath=este arquivo). Empacotado, o transcriber.ts usa o modo
// `--speech-worker` do entry (server/src/index.ts) em vez deste shim — mais
// simples que extrair e spawnar este arquivo como script real (ver
// run-worker.ts pro porquê).
//
// Resolve `tsx/esm/api` relativo à PRÓPRIA localização (import.meta.url), não
// ao cwd do processo — mesmo motivo do shim do hermes (o processo que spawna
// este worker pode ter cwd arbitrário).
import { tsImport } from 'tsx/esm/api'

const { runSpeechWorker } = await tsImport('./run-worker.ts', import.meta.url)

runSpeechWorker()
