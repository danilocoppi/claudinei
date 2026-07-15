#!/usr/bin/env node
// Shim fino: a lógica real do MCP hermes mora em server/src/hermes/run-hermes.ts
// (Task 1 do binário único). Este arquivo é o alvo padrão do mcp-config em dev
// (config.hermesCommand=process.execPath, config.hermesArgs=[este arquivo]).
//
// Resolve `tsx/esm/api` e importa `run-hermes.ts` relativos à PRÓPRIA localização
// deste arquivo (via import.meta.url), NÃO ao cwd do processo — necessário porque
// o `claude` spawna este MCP com cwd = pasta do projeto do usuário (arbitrária),
// não server/. `--import tsx` na linha de comando resolveria `tsx` relativo ao
// cwd e quebraria fora do repo; `tsImport` não tem esse problema (confirmado
// empiricamente rodando este shim com cwd=/tmp).
import { tsImport } from 'tsx/esm/api'

const { runHermes } = await tsImport('../src/hermes/run-hermes.ts', import.meta.url)

await runHermes({
  api: process.env.CLAUDINEI_API || 'http://127.0.0.1:9105',
  projectId: Number(process.env.CLAUDINEI_PROJECT_ID || '0'),
  // Sem isto, com auth ligada as tools batem em /api/hermes|/api/orchestrator SEM
  // Authorization e tomam 401 — a colaboração falha calada. O modo `--hermes`
  // (binário empacotado, server/src/index.ts) já repassa; o shim de dev precisa igual.
  serviceToken: process.env.CLAUDINEI_SERVICE_TOKEN,
  engine: process.env.CLAUDINEI_ENGINE,
})
