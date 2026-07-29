# Revisão de código — backlog de achados

Revisão adversarial feita em 2026-07-29 (5 revisores paralelos cobrindo: sessões/engines, segurança/auth, hermes/orquestrador/PTY, frontend, packaging/voz). Baseline na época: 526 testes server verdes, `tsc` limpo.

**Rodada de correção (2026-07-29, mesma data):** todos os itens foram re-verificados contra o código (4 verificadores independentes) e a grande maioria foi corrigida. Resultado da re-verificação: 28 confirmados, 3 parciais (M19, M20, M27 — impacto menor que o descrito), 1 inválido (M16). Baseline pós-correção: 531 testes server + 445 web verdes, `tsc` limpo nos dois pacotes.

**Como usar:** cada achado tem um ID, status e sugestão de correção. Ao decidir/corrigir, atualize o status (e risque/mova o item se quiser).

**Legenda de status:**
- ✅ **Corrigido** — correção aplicada e testada
- 🟡 **Aceito** — decidido não corrigir (risco assumido / limitação documentada)
- ⬜ **Pendente** — aguardando decisão ou correção
- ❌ **Inválido** — re-verificação mostrou que o achado não procede

---

## Critical

### C1 — Não-admin derruba o servidor com 1 frame WS malformado
- **Status:** ✅ Corrigido (2026-07-29)
- **Local:** `server/src/routes/ws.ts:64-70`
- **Problema:** `manager.get(msg.localId)` rodava fora do `try/catch`; um `localId` não-escalar (`true`, `{}`) fazia o better-sqlite3 lançar no bind → `uncaughtException` → processo morria. Reproduzido ponta a ponta.
- **Correção aplicada:** guard do não-admin movido para dentro do `try`; frame malformado vira `error` no socket do autor. Teste em `server/test/auth-ws.test.ts`.

### C2 — CSWSH no `/ws` no pré-setup → RCE via página maliciosa
- **Status:** ✅ Corrigido (2026-07-29)
- **Local:** `server/src/routes/ws.ts:51`
- **Problema:** o `/ws` não verificava `Origin`. Com 0 usuários (pré-setup), o hook libera loopback sem credencial: um site malicioso visitado pelo usuário abria `ws://127.0.0.1:9105/ws` e controlava as sessões (que rodam com `--dangerously-skip-permissions`).
- **Correção aplicada:** `isAllowedOrigin` (mesma regra do `/ws/terminal/:id`) na entrada do handler — Origin de terceiro → `close(1008)` sem snapshot. Testes em `server/test/ws.test.ts`.
- **Nuance (re-verificação):** `isAllowedOrigin` aceita requisições SEM header Origin — correto para CSWSH (browser sempre envia Origin), mas clientes não-browser passam; a barreira para eles continua sendo a auth do hook.

### C3 — RBAC por projeto não confina o não-admin (design)
- **Status:** 🟡 Aceito como está (decisão do usuário, 2026-07-29)
- **Local:** `server/src/claude/session.ts` + `server/src/auth/guards.ts:9`
- **Problema:** (a) sessões/terminal sempre rodam `--dangerously-skip-permissions` como o usuário do SO — um não-admin com 1 projeto lê/escreve fora do escopo via chat; (b) toda sessão recebe o mesmo service token onipotente do Hermes (bypass total de `requireProjectAccess`). O "per-terminal access" é cosmético contra um não-admin malicioso.
- **Observação:** se um dia for tratado, exige decisão de produto (sandboxing, tokens por projeto, ou documentar "não-admin não é confiável"). Itens relacionados: I3, M5, M6.

---

## Important

### I1 — I/O síncrono pesado no event loop (rotas de histórico/engines)
- **Status:** ✅ Corrigido (2026-07-29) — `readHistory` virou assíncrono nas 3 engines (transcript via `fs/promises`, `opencode export` via `execFile` async); `opencode models` agora atualiza em background (1ª chamada pós-cache devolve a lista anterior/[]); varredura de rollouts do Codex com 1 stat por arquivo (antes 2 por comparação no sort) e `latestThreadForCwd` lendo só a 1ª linha de cada rollout
- **Local:** `server/src/routes/sessions.ts:110-128`; `server/src/history.ts:32-41`; `server/src/engine/opencode/opencode-engine.ts:18-27,69`; `server/src/engine/codex/rollout.ts:11-29`
- **Problema:** histórico Claude lê o transcript inteiro com `readFileSync` (>30 MB possíveis); OpenCode usa `execFileSync('opencode export')` (até **8 s** de congelamento por request) e `opencode models` (5 s) no `GET /api/engines`; Codex varre `~/.codex/sessions` com `statSync` por arquivo a cada chamada. Um usuário martelando essas rotas congela WS/PTYs de todos.
- **Sugestão:** tornar async (`readFile` + parse em stream; `execFile` async), cachear resultados (o `latestConversationId` já tem o padrão de cache para copiar), e fatiar o transcript antes do parse quando possível.

### I2 — OpenCode: mensagem >~128 KB mata a sessão (E2BIG)
- **Status:** ✅ Corrigido (2026-07-29) — validação de 120 KB antes do spawn; acima disso emite um result de erro claro no chat e a sessão continua viva
- **Local:** `server/src/engine/opencode/opencode-args.ts:44,48`
- **Problema:** o prompt vai como argumento do argv; Linux limita um argumento a 131.071 bytes (`MAX_ARG_STRLEN`). Acima disso o `spawn` falha → sessão `dead`, mensagem perdida. Claude/Codex enviam por stdin e não têm o problema.
- **Sugestão:** validar o tamanho antes do spawn e rejeitar com erro claro, ou passar o prompt por stdin/arquivo temporário.

### I3 — Service token do Hermes no argv, sem revogação, TTL 30 dias
- **Status:** ✅ Corrigido (2026-07-29) — o token agora vive num arquivo 0600 (`<dataDir>/service-token`) e as engines recebem só o CAMINHO (nada de segredo em `ps`/cmdline); o hermes relê o arquivo a cada chamada; token de serviço ganhou `ver` (persistido no kv settings) e o revoke-all o incrementa + reescreve o arquivo — sessões vivas continuam funcionando com o token novo. TTL 30d mantido (aceitável agora que é revogável). Pendência: smoke test em runtime com claude/codex reais (o repasse do env ao MCP foi validado só pelos testes de args)
- **Local:** `server/src/claude/session.ts:71-86`; `server/src/engine/codex/codex-args.ts:32`; `server/src/auth/tokens.ts:10`
- **Problema:** o token vai no `--mcp-config`/`-c` da linha de comando → visível em `ps`/`/proc/*/cmdline` para qualquer usuário local do SO. TTL de 30 dias e `revokeAll()` não o invalida (payload de serviço não tem `ver`).
- **Sugestão:** passar o token por env var do spawn em vez de argv; adicionar `ver`/rotação ao token de serviço. Nota: mesmo assim, o token continua acessível ao próprio agente (ver C3).

### I4 — Orquestrador escolhe a 1ª sessão ativa, mesmo ocupada
- **Status:** ✅ Corrigido (2026-07-29) — `askAgent`/`dispatchTask` pulam sessões `working` e só falham com "busy" quando TODAS as ativas estão ocupadas (nota da re-verificação: o guard existente nunca ENTREGAVA à ocupada — ele falhava a task indevidamente, como o item descreve; combinado com o I6, a fila parava de vez)
- **Local:** `server/src/claude/manager.ts:429-435` e `486-492` (vs. `hasFreeSession` em `416-421`)
- **Problema:** com 2 engines no mesmo projeto (Claude working + Codex idle, cenário suportado), `askAgent`/`dispatchTask` pegam a primeira sessão ACTIVE e falham com "busy" mesmo havendo sessão livre. Tasks falham deterministicamente.
- **Sugestão:** filtrar por `status !== 'working'` na seleção do target, como `hasFreeSession` já faz.

### I5 — Waiters de ask/dispatch ignoram o status `stopped`
- **Status:** ✅ Corrigido (2026-07-29) — waiters resolvem/rejeitam também em `stopped`; isso cobre o `openInTerminal` (que passa por `session.stop()` e emite `stopped` no emitter da sessão — `in_terminal` só existe no nível do manager)
- **Local:** `server/src/claude/manager.ts:451-456,507-512`; `server/src/claude/session.ts:153`
- **Problema:** `onStatus` só resolve em `'dead'`. Se o operador para a sessão ou a abre no terminal com um ask (120 s) ou task (600 s) pendente, o waiter fica pendurado até o timeout — task `in_progress` por até 10 min depois do agente morto.
- **Sugestão:** resolver/rejeitar o waiter também em `stopped`/`in_terminal`.

### I6 — Fila do orquestrador não re-drena após falha
- **Status:** ✅ Corrigido (2026-07-29) — `drain(toProjectId)` via `setImmediate` no caminho de falha do `setResult` (o adiamento quebra a reentrância quando o `onComplete` é chamado sincronamente pelo `dispatchTask`)
- **Local:** `server/src/routes/orchestrator.ts:32-35` + `server/src/claude/manager.ts:94-96`
- **Problema:** `drain` só roda no POST `/dispatch` e em `onSessionAvailable` (idle/needs_attention). Timeout/dead de uma task não gera nenhum dos dois → próxima task `queued` para aquele projeto não é entregue até intervenção manual. No fluxo agente→agente a fila para.
- **Sugestão:** chamar `drain(toProjectId)` após `setResult` também no caminho de falha.

### I7 — Heurística de atividade do TUI nunca liga em produção
- **Status:** ✅ Corrigido (2026-07-29) — `terminalLauncher` do index.ts repassa `onActivity` ao `terminalManager.open` (a correção de 1 linha prevista)
- **Local:** `server/src/index.ts:163-168` vs. `server/src/claude/manager.ts:339-350` e `server/src/terminal/manager.ts:54`
- **Problema:** `openInTerminal` monta o callback `onActivity`, mas o `terminalLauncher` o descarta ao chamar `terminalManager.open` — o `createActivityTracker` nunca é criado. Feature inteira (working/waiting na sidebar) silenciosamente inativa.
- **Sugestão:** repassar `onActivity: opts.onActivity` no launcher (1 linha).

### I8 — Frontend: reconexão do WS não ressincroniza o chat
- **Status:** ✅ Corrigido (2026-07-29) — `connectWs` ganhou callback `onReconnect` (só dispara em RE-conexão); o store invalida `historyLoadedFor` e limpa `streaming` órfão, e o guard do ChatView rebusca pelo mesmo mecanismo da invalidação `working → idle`
- **Local:** `web/src/ws.ts:20-22`; `web/src/store.ts:157-176,225-237`; `web/src/components/ChatView.tsx:40-67,163-173`
- **Problema:** eventos do turno perdidos durante uma queda nunca são recuperados — o snapshot não invalida `historyLoadedFor`, então a resposta final some da tela até reload manual, e o preview de streaming fica congelado para sempre (cursor piscando fantasma).
- **Sugestão:** no `sessions_snapshot`, invalidar o histórico de sessões `working`/mudadas e limpar `streaming[localId]` órfãos (ou re-fetch do histórico quando o snapshot indica turno encerrado).

### I9 — Frontend: rascunho do ChatInput vaza entre sessões
- **Status:** ✅ Corrigido (2026-07-29) — `key={session.localId}` no `<ChatInput>` (decisão: zerar o rascunho ao trocar de sessão)
- **Local:** `web/src/components/ChatView.tsx:191`; `web/src/components/ChatInput.tsx:30-40`
- **Problema:** `<ChatInput>` sem `key`: ao trocar de sessão pela sidebar, texto e anexos digitados para o projeto A persistem e podem ser enviados ao projeto B (inclusive paths de upload de A).
- **Sugestão:** `key={session.localId}` no `<ChatInput>` (remonta e zera o rascunho por sessão). Decidir se o desejado é zerar ou manter rascunho por sessão (mapa de rascunhos).

### I10 — `--insecure` contraditório: hook barra LAN mesmo com a flag
- **Status:** ✅ Corrigido (2026-07-29) — a flag chega ao hook de auth via `buildApp` e libera IP não-loopback no pré-setup; mensagem desatualizada do expose-guard reescrita
- **Local:** `server/src/expose-guard.ts:10` vs. `server/src/auth/plugin.ts:69-75`
- **Problema:** com 0 usuários, o hook devolve `403 setup_required_localhost_only` para qualquer IP não-loopback **independentemente de `--insecure`** — a flag não faz o que o README promete nesse caso. A mensagem do guard também está desatualizada ("A autenticação chega no próximo incremento").
- **Sugestão:** alinhar os dois lados — ou o hook respeita `--insecure`, ou a flag/doc mudam. Atualizar a mensagem do guard.

### I11 — Binário empacotado: cache de nativos cai em `/tmp`
- **Status:** ✅ Corrigido (2026-07-29) — fallback `~/.cache/claudinei` (spec XDG), `tmpdir()` só como último recurso sem home. Nota da re-verificação: a chave do cache hoje é primariamente o build-id do empacotamento; o `'v1'` previsível era só fallback
- **Local:** `server/src/pkg-runtime.ts:13-16`
- **Problema:** `cacheRoot` usa `env.XDG_CACHE_HOME || tmpdir()`. Sem `XDG_CACHE_HOME` (comum; o default XDG seria `~/.cache`), os `.node`/`.so` vão para `/tmp/claudinei/...`: quebra com `/tmp noexec` e é plantável em máquina multiusuário (extração pula arquivos existentes; `CLAUDINEI_VERSION ?? 'v1'` é previsível).
- **Sugestão:** fallback para `~/.cache/claudinei` (spec XDG) em vez de `tmpdir()`; endurecer a extração (ver M17).

### I12 — Downloads do setup de voz sem verificação de integridade
- **Status:** 🟡 Parcial (2026-07-29) — endurecimento estrutural feito: download+extração em tmp com rename atômico, `tar --no-same-owner --no-same-permissions`, validação dos `.onnx`/`tokens.txt`/`libstdc++.so.6` antes do rename, idempotência checando todos os arquivos. **Pendente:** pin de SHA-256 (exige hashes confiáveis mantidos junto do projeto — o local está marcado com comentário no script)
- **Local:** `server/scripts/setup-speech.mjs:16,20-22,31-32`
- **Problema:** modelo (~630 MB) e o `libstdc++.so.6` portátil (carregado no processo do servidor!) são baixados sem checksum/assinatura; `tar xjf` sem flags defensivas; o cheque de idempotência (`tokens.txt`) aprova extração interrompida.
- **Sugestão:** checksums SHA-256 fixos no script; extrair em dir temporário + rename; validar presença dos `.onnx` além do `tokens.txt`.

### I13 — Timeout de transcrição (30 s) incompatível com áudio de até ~15 min
- **Status:** ✅ Corrigido (2026-07-29) — timeout proporcional ao tamanho do WAV (base 30 s + ~2× a duração, teto de +10 min) e, no timeout, o worker leva SIGKILL e é respawnado no próximo pedido (mata a cascata da fila serial)
- **Local:** `server/src/speech/transcriber.ts:37,172-190`; `server/src/routes/transcribe.ts:11`
- **Problema:** a rota aceita WAV de 30 MB (~15 min), mas o timeout é 30 s — decode do Parakeet de 15 min leva bem mais. Pior: no timeout o worker segue preso no `decode()` síncrono e **todas** as transcrições enfileiradas estouram em cascata (fila serial).
- **Sugestão:** matar/reiniciar o worker no timeout, e/ou dimensionar o timeout pelo tamanho do áudio; opcionalmente limitar duração do áudio na rota.

---

## Minor

### Backend — sessões/engines/WS

### M1 — Broadcast WS sem backpressure
- **Status:** ✅ Corrigido (2026-07-29) — cliente com `bufferedAmount` > 4 MB é fechado com 1013 (reconecta e ressincroniza pelo snapshot — casa com o I8)
- **Local:** `server/src/routes/ws.ts:32-37`
- **Problema:** `send()` sem olhar `bufferedAmount`; cliente que para de ler (laptop suspenso) acumula buffer no servidor durante streaming intenso → crescimento de memória.
- **Sugestão:** fechar/marcar clientes com `bufferedAmount` acima de um teto.

### M2 — DELETE de projeto com sessão `in_terminal` deixa PTY órfão
- **Status:** ✅ Corrigido (2026-07-29) — o guard do DELETE também conta sessões `in_terminal` no banco (409)
- **Local:** `server/src/routes/projects.ts:51-59`
- **Problema:** o guard só barra sessão ativa no mapa `live`; sessão `in_terminal` é apagada em cascata enquanto o `claude --resume` segue rodando — `onExit` vira no-op e o canal fica órfão no `terminalManager`.
- **Sugestão:** barrar o delete (ou fechar o PTY) quando houver sessão `in_terminal`.

### M3 — Codex: exit 0 sem nenhum evento `result` some em silêncio
- **Status:** ✅ Corrigido (2026-07-29) — result de erro sintetizado no close sem result, espelhando o OpenCode
- **Local:** `server/src/engine/codex/codex-session.ts:53-60`
- **Problema:** turno que sai com código 0 e sem `result` vira `idle` sem emitir nada — `askAgent`/`dispatchTask` ficam pendurados até o timeout. O OpenCode sintetiza um result no `close`; o Codex não.
- **Sugestão:** espelhar o comportamento do OpenCode (sintetizar result no close sem result).

### Backend — segurança/arquivos

### M4 — Oráculo de existência de arquivos para não-admin
- **Status:** ✅ Corrigido (2026-07-29) — para não-admin, fora-de-escopo responde `exists:false` no `resolveInScope` (fonte única) → `/resolve` e `/content` (404) ficam indistinguíveis de "não existe". Nota da re-verificação: o vazamento também existia via `POST /api/files/resolve`, coberto pela mesma correção
- **Local:** `server/src/files/scope.ts:45-61`; `server/src/routes/files.ts`
- **Problema:** `resolveInScope` retorna `exists: true, inScope: false` para caminhos fora do escopo (e 404-vs-403 em `/api/files/content`) → não-admin enumera existência de arquivos arbitrários do SO.
- **Sugestão:** resposta uniforme para fora-de-escopo (indistinguível de "não existe").

### M5 — TOCTOU entre `resolveInScope` e a leitura
- **Status:** 🟡 Aceito por ora (2026-07-29) — não corrigido nesta rodada: a leitura já usa o realpath resolvido no check (o ataque exige trocar um componente do caminho na janela) e o risco é redundante com o C3 aceito (o mesmo usuário já tem shell). Revisitar se o C3 mudar
- **Local:** `server/src/files/scope.ts:45`; `server/src/routes/files.ts:68-81`
- **Problema:** check com `realpathSync`, leitura depois — symlink race na janela entre os dois. Redundante com o C3 aceito (o mesmo usuário já tem shell), mas o padrão check-then-use é frágil.
- **Sugestão:** abrir com `O_NOFOLLOW` / ler pelo fd já validado.

### M6 — Cookie/sessão em claro na LAN (sem TLS)
- **Status:** 🟡 Aceito (2026-07-29) — limitação inerente à falta de HTTPS; o README já documenta ("⚠️ No TLS") e reverse proxy está fora de escopo por decisão
- **Local:** `server/src/auth/plugin.ts:23`
- **Problema:** cookie `httpOnly`+`SameSite=strict` (bom), mas sem `secure` e sem TLS tudo trafega em claro no modo `--host 0.0.0.0` — sniffável. O README já tem a seção "⚠️ No TLS"; o item é garantir que a limitação esteja documentada onde o modo LAN é explicado.
- **Sugestão:** apenas documentação (reverse proxy com HTTPS está fora de escopo por decisão).

### M7 — Lockout vira DoS de conta
- **Status:** ✅ Corrigido (2026-07-29) — rate limit por IP no login (20 falhas / 15 min → 429 `rate_limited`), complementando o lockout por conta
- **Local:** `server/src/auth/users.ts:22-23,117-126`
- **Problema:** 5 falhas com um username conhecido travam o usuário legítimo por 15 min, renovável indefinidamente; não há rate limit por IP.
- **Sugestão:** rate limit por IP além do lockout por conta (ou aceitar como trade-off documentado).

### M8 — Senha mínima de 4 caracteres
- **Status:** ✅ Corrigido (2026-07-29) — mínimo 8 para senhas novas (create/update; hashes existentes intactos)
- **Local:** `server/src/auth/users.ts:24`
- **Problema:** fraco para o modo LAN, onde a senha é a única barreira contra a rede.
- **Sugestão:** subir o mínimo (8+) ao menos para novas senhas.

### M9 — Upload sem quota por usuário nem restrição de tipo
- **Status:** 🟡 Aceito por ora (2026-07-29) — exige login e a rotação global (KEEP=100) limita o total a ~10 GB; quota por usuário/filtro de MIME fica como decisão de produto se o multiusuário crescer
- **Local:** `server/src/routes/uploads.ts:15-27`
- **Problema:** qualquer autenticado sobe 100 MB por vez; rotação (KEEP=100) limita a ~10 GB no total, mas sem quota individual nem filtro de tipo.
- **Sugestão:** quota por usuário e/ou allowlist de MIME (ou aceitar, já que exige login).

### Backend — hermes/orquestrador/terminal

### M10 — Sem limite de tamanho em board/tasks/ask
- **Status:** ✅ Corrigido (2026-07-29) — tetos: título 500 chars; content/question/description 50 k chars (400 com erro claro). Nota da re-verificação: o `bodyLimit` default de 1 MB do Fastify já era um teto implícito por request
- **Local:** `server/src/routes/hermes.ts:32-50`; `server/src/routes/orchestrator.ts:49-69`
- **Problema:** `title`/`content`/`description`/`question` sem teto vão direto ao SQLite e ao broadcast WS; um agente em loop incha o banco de todos.
- **Sugestão:** teto de tamanho (ex.: 10–50 KB) com erro claro.

### M11 — `fromProjectId` auto-declarado e não verificado
- **Status:** 🟡 Aceito por ora (2026-07-29) — só cosmético (rótulo de exibição); o token de serviço não carrega projeto, então derivar a origem exigiria tokens por projeto (ver C3 aceito)
- **Local:** `server/src/routes/hermes.ts:61-62`; `server/src/routes/orchestrator.ts:58`
- **Problema:** o chamador atribui a origem que quiser (rótulo exibido no mural/tasks). Só cosmético.
- **Sugestão:** derivar a origem do token/sessão autenticada quando possível.

### M12 — Entrada do mapa do terminal pode vazar se o PTY não morrer
- **Status:** ✅ Corrigido (2026-07-29) — kill com escalonamento (SIGKILL após 3 s) e limpeza forçada da entry + aviso aos clients se nem assim o exit chegar (+2 s); timers cancelados pelo exit real
- **Local:** `server/src/terminal/manager.ts:90-96`
- **Problema:** `close()` mata, mas a entry só sai do Map no `onExit`; se o processo ignorar o kill, a entry (buffer 256 KB + clients) fica para sempre e os clients nunca recebem "sessão encerrada".
- **Sugestão:** limpar a entry no timeout do `closeAndWait` (com SIGKILL de escalonamento).

### Frontend

### M13 — `connectWs` hardcoded em `ws://` (quebra sob HTTPS)
- **Status:** ✅ Corrigido (2026-07-29) — `wss://` sob https, como o TerminalView
- **Local:** `web/src/ws.ts:8` (o `TerminalView.tsx:62` já faz certo)
- **Problema:** atrás de proxy TLS, o navegador bloqueia `ws://` (mixed content) → loop de reconexão sem feedback; o terminal funcionaria e o chat não.
- **Sugestão:** `location.protocol === 'https:' ? 'wss://' : 'ws://'`, como no TerminalView.

### M14 — Fila offline do WS reenvia ações fora de contexto
- **Status:** ✅ Corrigido (2026-07-29) — mensagens enfileiradas ganham timestamp e as com mais de 15 s são descartadas no flush
- **Local:** `web/src/ws.ts:16-19,27-30`
- **Problema:** mensagens enfileiradas com socket fechado são despejadas no `onopen` sem limite de idade — um `interrupt`/`send_message` clicado durante a queda é entregue minutos depois (pode interromper um turno novo ou duplicar mensagem).
- **Sugestão:** descartar/expirar a fila (TTL curto) ou só reenviar `send_message` com confirmação.

### M15 — `fetchHistory` no ChatView sem `.catch`
- **Status:** ✅ Corrigido (2026-07-29) — `.catch` com log; não marca como carregado, então o próximo disparo do efeito (troca de sessão/status/reconexão) retenta
- **Local:** `web/src/components/ChatView.tsx:45-66`
- **Problema:** falha de rede vira unhandled rejection e a sessão fica sem histórico e sem retry.
- **Sugestão:** catch com retry/backoff ou estado de erro visível.

### M16 — Colisão de tokens de anexo com nomes iguais
- **Status:** ❌ Inválido (re-verificação 2026-07-29) — o token usa o nome DEVOLVIDO PELO SERVIDOR, que prefixa cada upload com contador único e reserva atômica (`001-a.png`, `002-a.png` — `server/src/uploads.ts:40,44`). Dois arquivos de mesmo nome geram tokens distintos; não há colisão
- **Local:** `web/src/components/ChatInput.tsx:14,74,99-100`
- **Problema:** dois arquivos com o mesmo nome geram o mesmo token `[📎 nome]`; o segundo sobrescreve o Map e **ambas** as ocorrências apontam para o path do segundo — o primeiro anexo some em silêncio.
- **Sugestão:** token único (sufixo/id) por anexo.

### M17 — Gravação de microfone sem teto e com custo O(n²)
- **Status:** ✅ Corrigido (2026-07-29) — buffer cumulativo com capacidade dobrada (copia só o chunk novo; ticks entregam `subarray`) e teto de ~10 min que encerra a captura com teardown completo
- **Local:** `web/src/speech/recorder.ts:43-49`
- **Problema:** chunks PCM acumulam para sempre e o `concatFloat32` a cada 1,5 s copia o buffer inteiro (~1,9 MB/min por cópia, crescente). Gravação esquecida degrada a aba.
- **Sugestão:** limite de duração (com aviso) e concatenação incremental.

### M18 — `transcribeAudio` e `uploadFile` não redirecionam em 401
- **Status:** ✅ Corrigido (2026-07-29) — ambos despacham `claudinei:unauthorized` no 401 antes de lançar
- **Local:** `web/src/api.ts:107-112,126-135`
- **Problema:** fetchs crus fora do `req()` — sessão expirada mostra "transcrição falhou (401)" em vez de levar ao login.
- **Sugestão:** despachar `claudinei:unauthorized` como o `req()` faz.

### M19 — `terminalActivity` stale ao reentrar em `in_terminal`
- **Status:** ✅ Corrigido (2026-07-29) — a transição de ENTRADA em `in_terminal` zera a atividade; permanência preserva. Nota da re-verificação: o impacto era menor que o descrito (sair do terminal já zerava via status não-terminal)
- **Local:** `web/src/store.ts:191`
- **Problema:** ao reentrar em `in_terminal`, o valor antigo é preservado até o próximo evento — dot/label pode mostrar "esperando você" de uma sessão de terminal anterior. (Ver também I7: a feature hoje nem emite eventos.)
- **Sugestão:** zerar ao entrar em `in_terminal` também.

### M20 — Crescimento não limitado de registros no store
- **Status:** ✅ Corrigido (2026-07-29) — `streaming` deleta a chave em vez de gravar `''`; `board` podado em 200; `sessions_snapshot` remove entradas órfãs de `chat`/`unread`/`historyLoadedFor`/`streaming`. Desvio consciente: `fileResolved` não é podado (chaveado por path, sem vínculo com sessão). Nota da re-verificação: `historyLoadedFor` já tinha remoção pontual — a lacuna real era a poda na remoção de sessões
- **Local:** `web/src/store.ts` (`streaming`, `historyLoadedFor`, `fileResolved`, `board`)
- **Problema:** `streaming` é "limpo" escrevendo `''` sem deletar a chave; os demais mapas só crescem na vida da aba. Trivial em uso normal.
- **Sugestão:** deletar chaves em vez de esvaziar; podar `board` (manter últimos N).

### M21 — `refetchAll` sem proteção no catch de `applyOrder`
- **Status:** ✅ Corrigido (2026-07-29) — try/catch próprio com log no refetch de recuperação
- **Local:** `web/src/components/Sidebar.tsx:100-117`
- **Problema:** `catch { await refetchAll() }` — se o refetch falhar (backend fora), unhandled rejection e a sidebar fica divergente sem aviso.
- **Sugestão:** catch interno no refetch (log/toast).

### Packaging / scripts / voz / métricas

### M22 — `reexecIfNeeded` faz substring match em `LD_LIBRARY_PATH`
- **Status:** ✅ Corrigido (2026-07-29) — comparação por entradas exatas do `split(':')`, exigindo TODAS as entradas do ldPath. Nota da re-verificação: o bug era pior que o descrito — só a 2ª entrada era checada, ignorando o dir do stdcxx
- **Local:** `server/src/pkg-runtime.ts:76`
- **Problema:** `includes(ldPath.split(':')[1])` pode dar falso positivo/negativo por substring — o re-exec é pulado e os nativos falham no `dlopen`.
- **Sugestão:** comparar por entradas (`split(':')` + igualdade).

### M23 — `extractTree` não é atômica nem segura contra execuções concorrentes
- **Status:** ✅ Corrigido (2026-07-29) — escrita em `.tmp-<pid>` + `renameSync` atômico
- **Local:** `server/src/pkg-runtime.ts:20-28`
- **Problema:** duas instâncias do mesmo build no primeiro run: a 2ª pode ver um `.node` parcialmente escrito e usá-lo (crash no `dlopen`). Relacionado ao I11.
- **Sugestão:** escrever em tmp + rename; lock por diretório.

### M24 — Poda de caches antigos quebra instância antiga ainda rodando
- **Status:** ✅ Corrigido (2026-07-29) — só poda `native-*` com mtime > 7 dias
- **Local:** `server/src/pkg-runtime.ts:58-64`
- **Problema:** `rmSync` dos `native-*` não-atuais: o binário antigo em execução que spawnar o speech worker depois da poda tem `NODE_PATH` apontando para dir deletado — voz quebra na instância antiga. Cenário raro.
- **Sugestão:** podar só caches mais velhos que N dias, ou ignorar (documentado).

### M25 — `bin/claudinei.mjs`: spawn sem handler de `error`, exit code mascarado, sem forward de sinais
- **Status:** ✅ Corrigido (2026-07-29) — handler de `error` amigável, morte por sinal re-levanta o mesmo sinal (status correto), SIGINT/SIGTERM repassados ao filho
- **Local:** `bin/claudinei.mjs:26-28`
- **Problema:** se `npx`/`tsx` não existir, stack crua em vez de mensagem amigável; morte por sinal vira exit 0; `kill <pid do launcher>` órfã o servidor (que segura a porta).
- **Sugestão:** handler de `error`, propagar sinal/código corretamente, forward de SIGINT/SIGTERM ao filho.

### M26 — `fetch` do usage sem timeout explícito
- **Status:** ✅ Corrigido (2026-07-29) — `AbortSignal.timeout(10_000)`
- **Local:** `server/src/usage.ts:50`
- **Problema:** stall da API da Anthropic deixa `/api/usage` pendurado por ~300 s (default do undici).
- **Sugestão:** `AbortSignal.timeout(...)` (ex.: 10 s).

### M27 — `install-emoji-font.sh` escreve direto no destino final
- **Status:** ✅ Corrigido (2026-07-29) — download em `.tmp` + cheque de tamanho no tmp + `mv`, com `trap` de limpeza. Nota da re-verificação: o script já tinha cheque de tamanho (<1 MB); o caso real era truncamento acima de 1 MB e o arquivo ruim ficar no disco
- **Local:** `scripts/install-emoji-font.sh:25`
- **Problema:** `curl` interrompido deixa `.ttf` truncado instalado (o cheque de tamanho não roda por causa do `set -e`).
- **Sugestão:** baixar para tmp + `mv` após o cheque.

### M28 — `capture-fixtures.mjs` sobrescreve fixture boa em caso de falha
- **Status:** ✅ Corrigido (2026-07-29) — grava só com exit 0 e stdout não-vazio; timeout de 120 s e handler de `error`
- **Local:** `server/scripts/capture-fixtures.mjs:28-31`
- **Problema:** grava o fixture incondicionalmente no `exit` — se o `claude` falhar, o fixture real vira lixo/vazio; sem timeout, processo travado pendura o script. Dev-only.
- **Sugestão:** gravar só com exit 0 e stdout não-vazio; adicionar timeout.

### M29 — `engineUsage.record` pode derrubar o servidor
- **Status:** ✅ Corrigido (2026-07-29) — try/catch no call site do manager (métrica nunca derruba o processo)
- **Local:** `server/src/claude/manager.ts:116` → `server/src/engine-usage.ts:95-105`
- **Problema:** chamado sincronamente dentro do listener de evento da engine; se o `upsert.run` lançar (DB fechado/corrompido/disco cheio), vira `uncaughtException` → servidor inteiro cai por causa de métrica. Baixa probabilidade, blast radius alto.
- **Sugestão:** `try/catch` no call site ou em `record` (métrica nunca deve derrubar o processo).

---

## Verificado e limpo (sem ação necessária)

Resumo do que os revisores conferiram e **não** acharam problema:

- SQL 100% parametrizado; migrações idempotentes; FKs com CASCADE.
- Hash de senhas scrypt + `timingSafeEqual` + equalização de timing no login; JWT com segredo de 32 B, `token_version` revoga corretamente; hook global "rota nova nasce fechada"; regra do último admin protegida.
- Injeção em argv/TOML/shell: spawns sem shell, allowlists nas rotas, regex no `resumeId`, escaping TOML correto no Codex.
- Races de lifecycle de sessão (start/stop/revive/openInTerminal concorrentes) e normalização de órfãos no boot.
- Frontend: sem `dangerouslySetInnerHTML`, markdown sem HTML cru, `urlTransform` neutraliza `javascript:`/`data:`, sem vazamento de listeners/timers/MediaRecorder, sem object URLs.
- Auth do WS do terminal (token 192 bits + Origin check), lifecycle do PTY (buffer circular, kill/exit correto).
- `package.mjs` (prebuilts obrigatórios falham alto; build-id invalida cache), `dirname.ts`, lifecycle do worker de voz (exceto o timeout do I13), parsing defensivo do usage.
