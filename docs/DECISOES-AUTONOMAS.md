# Decisões autônomas — Claudinei

Registro das decisões tomadas durante a execução autônoma (meta: completar Fase 2a → item 24 + revisão geral). Cada entrada: contexto, opções consideradas, escolha e porquê. O usuário autorizou decidir por ele para não parar, exigindo este registro.

Formato: `[data] Feature — Decisão`.

---

## Fase 2a — Handoff para o terminal

### D1 — Qual terminal usar para abrir a sessão
- **Contexto:** o botão "abrir no terminal" precisa lançar `claude --resume` num terminal real (tty). No sistema: X11 ativo (DISPLAY=:1), `gnome-terminal` instalado, **tmux NÃO instalado**.
- **Opções:**
  - (A) Instalar tmux (via apt, requer sudo) + sessão tmux + o usuário faz `tmux attach` num terminal.
  - (B) `gnome-terminal --wait` — já instalado, abre uma janela gráfica direto com o claude, e `--wait` bloqueia até a janela fechar (permite detectar o retorno).
  - (C) `x-terminal-emulator` genérico (aponta para o gnome-terminal no sistema).
- **Escolha: (B) gnome-terminal --wait.**
- **Porquê:** já está instalado (sem `sudo`/apt, sem tocar no sistema), abre uma janela gráfica de imediato (fluxo mais natural no desktop do que attach manual de tmux), e o `--wait` dá ao backend um sinal claro de quando o usuário terminou (janela fechada → retoma). tmux ficaria como fallback futuro se o usuário quiser multiplexação/acesso remoto.
- **Config:** o binário do terminal é configurável por env (`CLAUDINEI_TERMINAL`, default `gnome-terminal`) para não travar em uma única escolha.

### D2 — Estado da sessão durante o handoff
- **Contexto:** enquanto a sessão está aberta no terminal, o processo headless não pode existir (trava: nunca viva em dois lugares). Preciso distinguir "aberta no terminal" de "parada".
- **Opções:** (A) reusar `stopped`; (B) novo estado `in_terminal`.
- **Escolha: (B) novo estado `in_terminal`.** Permite a UI mostrar "aberta no terminal" com botão "retomar na web" e travar o input, distinto de uma sessão finalizada.

### D3 — Retomada na web
- **Contexto:** ao voltar do terminal, a web precisa continuar a mesma conversa.
- **Escolha:** o `claude --resume` no terminal grava no MESMO arquivo JSONL de transcript (mesmo `claude_session_id`, mesmo cwd). Quando a janela do terminal fecha (`--wait` retorna), a sessão volta para `stopped`. O usuário então clica **"Reviver"** (fluxo já existente) para retomar na web via `--resume` headless — trazendo o histórico atualizado com o que foi feito no terminal. Evita respawn automático (que gastaria tokens sem o operador pedir) e reusa o fluxo de reviver, que já carrega o transcript. Simples e sem estado extra.

## Item extra do usuário — Conversa parcial ao reviver

### D4 — Mostrar parte da conversa anterior ao reviver/resume
- **Contexto:** ao reviver uma sessão (ou retomar do terminal), o operador deve ver parte da conversa anterior na web para se contextualizar. Hoje o ChatView carrega o histórico via `fetchHistory` só quando abre e o chat está vazio.
- **Escolha:** garantir que, ao reviver/retomar, a UI carregue o histórico do transcript imediatamente (não só ao abrir manualmente). Como o transcript nativo já tem toda a conversa, basta disparar o carregamento quando a sessão volta a ter `claudeSessionId`. Exibir o histórico completo disponível no transcript (é "parcial" no sentido de que é o que o Claude Code guardou, que pode ter sido compactado).

### D5 — Segurança do launcher de terminal (command injection)
- **Contexto:** revisão automática de segurança sinalizou HIGH (command injection) no `defaultLauncher`, que montava `bash -lc "cd ... && claude ..."` com interpolação.
- **Opções:** (A) manter com escaping via shell-quote; (B) não usar shell — passar `cwd` pela opção do `spawn` e invocar `claude` direto como argv, sem `bash -lc`.
- **Escolha: (B).** Elimina a superfície de injeção (cwd e sessionId não entram numa string de shell). O `exec bash` pós-claude foi removido (ao sair do claude a janela fecha, que é o sinal de retorno desejado). Adicionada validação do `claude_session_id` (regex hex/UUID) para evitar argv-smuggling de flags.

### D6 — broadcast do claudeSessionId efetivo (bug do D4 no revive, achado no smoke)
- **Contexto:** no smoke, reviver uma sessão deixava o chat vazio — o D4 não carregava. Causa: o broadcast de `session_status` mandava `session.sessionId` (só existe após o init, que no `--resume` só vem com a 1ª msg), então a UI ficava sem `claudeSessionId` e o D4 não disparava.
- **Escolha:** broadcast passa a emitir o id efetivo: `session.sessionId ?? claude_session_id do banco`. Assim a UI conhece o id imediatamente ao reviver e carrega o histórico (validado no smoke: conversa anterior aparece completa).

## Fase 2b — Servidor MCP Hermes (comunicação entre agentes)

### D7 — Arquitetura do Hermes
- **Opções:** (A) servidor MCP embutido no backend via HTTP/SSE; (B) script MCP stdio separado que fala HTTP com o backend REST.
- **Escolha: (B).** Cada sessão do claude spawna o script `hermes-mcp.mjs` (via `--mcp-config`), que expõe as ferramentas MCP e faz `fetch` aos endpoints `/api/hermes/*` do backend. Desacopla (backend só expõe REST, testável isoladamente), o script é fino, e a identidade do chamador vai por env (`CLAUDINEI_PROJECT_ID`) na injeção.

### D8 — perguntar_agente: alvo ocupado/inativo
- **Escolha:** se o projeto alvo não tem sessão ativa → erro claro; se está `working` (ocupado) → erro "agente ocupado, tente depois" (não enfileira, para simplicidade). Timeout de 120s aguardando a resposta (o próximo `result`).

### D9 — Identidade do chamador
- **Escolha:** ao injetar o Hermes numa sessão, passar `env: { CLAUDINEI_API, CLAUDINEI_PROJECT_ID }`. Assim `perguntar_agente`/`publicar_no_mural` sabem de qual projeto partem.

### D10 — Mural
- **Escolha:** tabela `mural(id, project_id, titulo, conteudo, created_at)`. `ler_mural(limite?)` retorna os últimos N posts com o nome do projeto autor. Visível também na UI.

### D11 — Ferramentas expostas
- `listar_projetos()` — nomes dos projetos e se têm sessão ativa.
- `perguntar_agente(projeto, pergunta)` — pergunta à sessão ativa de outro projeto, retorna a resposta.
- `publicar_no_mural(titulo, conteudo)` / `ler_mural(limite?)`.
Smoke Hermes: A perguntou a B via perguntar_agente (B respondeu 42), A publicou no mural, B leu, painel na UI ok. Validado ao vivo.

## Fase 3 — Orquestrador central + painel de tarefas

### D12 — Orquestrador construído sobre o Hermes
- **Escolha:** não há um "processo maestro" especial. Qualquer sessão pode orquestrar via ferramentas de despacho (injetadas junto do Hermes). O operador usa uma sessão qualquer (ex.: um projeto "Orquestrador" apontando para ~/Projects) para dar objetivos. Simplifica e reusa a infra do Hermes.

### D13 — despachar_tarefa é assíncrono
- **Escolha:** `despachar_tarefa(projeto, tarefa)` envia a tarefa ao agente alvo e registra a tarefa como `em_andamento` (não bloqueia o maestro, ao contrário de perguntar_agente). Quando o agente alvo produz o próximo `result`, o backend marca a tarefa `concluida` com o resultado (reusa a captura do askAgent, sem bloquear). O maestro consulta `listar_tarefas` para cobrar.

### D14 — Painel de tarefas
- **Escolha:** tabela `tasks(id, from_project_id, to_project_id, descricao, status, resultado, created_at, updated_at)`; status ∈ em_andamento/concluida/falhou. Painel na UI (como o mural) mostrando de→para, descrição, status e resultado, com auto-update via WS.

## Itens de melhoria (20-24)

### D15 — Streaming token-a-token (item 20): abordagem de baixo risco
- **Contexto:** `--include-partial-messages` faz o claude emitir `stream_event` com `text_delta`. Processar isso no pipeline principal (parser→applyEvent→chat[]) arriscaria duplicar mensagens ou quebrar o histórico já estável.
- **Escolha:** os deltas alimentam um estado EFÊMERO separado (`streaming[localId]`), exibido como uma bolha "digitando…" abaixo das mensagens confirmadas, e LIMPO quando o evento `assistant`/`result` completo chega (a mensagem real assume). O `chat[]` continua só com mensagens completas — zero risco de duplicação. `--include-partial-messages` ligado por padrão.

### D16 — Seletor de modelo por sessão (item 21)
- **Escolha:** dropdown no StartSessionModal com "Padrão" (não passa --model, usa o do Claude Code), "Opus", "Sonnet", "Haiku" — usando os aliases simples do CLI (`opus`/`sonnet`/`haiku`), mais robustos que IDs versionados. O modelo é persistido na sessão (coluna `model`) para o revive respeitar a escolha.

### D17 — Visualização de subagentes (item 22)
- **Contexto:** eventos gerados por subagentes (ferramenta Task) vêm com `parent_tool_use_id` preenchido no evento bruto.
- **Escolha:** marcar os ChatItems cujo evento tem `parent_tool_use_id` como "de subagente" (`fromSubagent`) e renderizá-los com recuo + barra lateral + rótulo "↳ subagente" — sem aninhamento estrutural completo (arriscado). Frontend-only: o `applyEvent` lê `parent_tool_use_id` do `raw`, sem tocar o parser do backend. Baixo risco.

### D18 — Aprovação de permissões pela web (item 23, parte 2): NÃO VIÁVEL com o CLI headless
- **Investigação empírica (claude 2.1.206):** no modo headless `-p --input-format stream-json`, com `--permission-mode default` OU `manual`, o claude NÃO emite prompt/control_request de permissão — ele auto-nega a ação (tool_result de erro + `permission_denials` no result). A flag `--permission-prompt-tool` não existe nesta versão. A aprovação interativa só existe na TUI interativa ou via o Agent SDK (`canUseTool`).
- **Decisão:** não implementar aprovação de permissões pela web — exigiria migrar do binário CLI para o Agent SDK (mudança arquitetural grande, e o Claudinei foi projetado sobre o binário para paridade total). **Alternativa já pronta:** o operador que desliga o bypass e precisa aprovar algo usa o **handoff para o terminal** (feature 2a), onde o claude interativo pede permissão normalmente, aprova, e volta pra web. Cobre o caso de uso sem depender de protocolo indisponível.

### D19 — Prune de sessões antigas (item 23, parte 1)
- **Escolha:** na construção do SessionManager (após a varredura de órfãs), podar sessões terminais (`dead`/`stopped`) antigas, mantendo as N mais recentes por projeto (default N=5, config `CLAUDINEI_KEEP_SESSIONS`). Não apaga transcripts (são do Claude Code); só limpa as rows do banco para não crescer indefinidamente. A mais recente por projeto sempre fica (revive/histórico).

## Revisão geral final (garantir 100%)

### D20 — Correções da revisão geral final (Opus)
- **Contexto:** revisão adversarial de todo o branch antes de declarar 100%. Três achados aplicados no branch `feature/final-fixes`.
- **Important — sessão `in_terminal` sobrevivia a restart:** se o backend reiniciava enquanto uma sessão estava em handoff no terminal, a row ficava `in_terminal` para sempre e travava o projeto (start/revive bloqueados). **Correção:** o boot do SessionManager normaliza toda row `in_terminal` órfã para `stopped` (junto da varredura de órfãs existente). Ao reviver, o histórico volta pelo `effectiveClaudeId`. Teste de normalização adicionado; os dois testes que simulavam sessão viva passaram a inserir a row `in_terminal` DEPOIS de `makeManager()` (o boot só normaliza órfãs de execuções anteriores, não a sessão da execução atual).
- **Minor — `task_update` sem `task`:** `broadcastTask(id)` no orchestrator agora consulta `tasks.get(id)` e só emite se existir; o store no front ignora `task_update` sem `task` (`if (!task) return`). Evita quebrar o painel de tarefas com mensagem malformada.
- **Minor — `ws.onmessage` sem try/catch:** um frame WS inválido derrubava o handler. Agora `JSON.parse`/`onMessage` ficam em try/catch com log, sem afetar a conexão.
- **Resultado:** 130 testes server + 101 web verdes, `tsc` (server e web) limpo, `vite build` OK. Objetivo autônomo (itens 2a→24 + revisão geral) concluído.

### D21 — Conversa parcial ao reviver (pedido explícito do /goal)
- **Pedido:** "qnd der um resume de uma sessão que já existe, na web deve mostrar parcial da conversa anterior para ajudar o operador a se contextualizar."
- **Escolha:** já coberto pela feature 2a/D4 — ao reviver, o `effectiveClaudeId` (id do Claude conhecido imediatamente pelo DB) dispara o carregamento do histórico do transcript, e o chat re-renderiza as mensagens anteriores. O operador abre a sessão revivida e vê a conversa que já existia, sem precisar reenviar nada. Nenhum trabalho adicional necessário — o requisito estava satisfeito pela arquitetura de histórico.
