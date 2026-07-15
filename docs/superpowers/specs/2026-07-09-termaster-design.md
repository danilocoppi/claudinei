# Termaster — Design

**Data:** 2026-07-09
**Status:** Aprovado pelo usuário (brainstorm concluído)

## Problema

O usuário trabalha simultaneamente em dezenas de projetos pessoais (~80 pastas em `~/Projects/`), abrindo um terminal com uma sessão do Claude Code para cada um. Isso gera:

- Dificuldade de acompanhar o que cada sessão está fazendo (varredura manual de janelas);
- Nenhuma forma de as sessões colaborarem entre si;
- Leitura desconfortável: a saída de terminal é menos legível que uma interface rica.

## Objetivo

Uma interface web **local** (localhost, sem autenticação) que:

1. Cria e gerencia sessões do Claude Code por projeto;
2. Exibe cada sessão como um chat rico (markdown, diffs, tool calls recolhíveis);
3. Mostra um dashboard com o status de todas as sessões, com fácil navegação e identificação visual de cada projeto;
4. Notifica quando uma sessão precisa de atenção;
5. Permite comunicação entre agentes em três níveis: direta (agente→agente), mural compartilhado e roteamento manual pela UI;
6. Possui um orquestrador central (sessão "maestro") que despacha tarefas entre projetos;
7. Mantém acesso híbrido: qualquer sessão pode ser "transferida" para um terminal (tmux) e depois retomada na web.

## Decisões de arquitetura

| Decisão | Escolha | Justificativa |
|---|---|---|
| Motor das sessões | Binário `claude` real em modo headless (`-p --input-format stream-json --output-format stream-json --verbose`) | Paridade máxima com o Claude Code do terminal: plugins auto-descobertos, MCP de usuário, skills, hooks, CLAUDE.md — requisito explícito do usuário. O Agent SDK cobre ~85-90% e fica como opção de migração futura. |
| Acesso | Somente localhost | Sem autenticação; simplicidade. |
| Permissões | `bypassPermissions` por padrão, toggle por sessão | Usuário já usa `--dangerously-skip-permissions` no fluxo atual. |
| Híbrido web↔terminal | Revezamento via `claude --resume <session_id>` em tmux | Uma sessão nunca fica viva em dois frontends ao mesmo tempo. Requer mesmo `cwd` absoluto. |
| Histórico | JSONL nativos de `~/.claude/projects/<cwd-codificado>/` como fonte da verdade | Zero duplicação; o Claude Code já persiste tudo. |
| Persistência própria | SQLite (better-sqlite3) | Apenas para: registro de projetos (nome, cor, ícone, cwd), mural, tarefas do orquestrador. |
| Backend | Node.js + TypeScript, Fastify + WebSocket | Ecossistema natural; WS para streaming em tempo real. |
| Frontend | React + Vite + TypeScript | UI rica, iteração rápida. |

## Componentes

### 1. Session Manager (backend)

Gerencia um processo `claude` headless de vida longa por sessão ativa.

- **Spawn**: `cwd` = diretório do projeto; captura `session_id` do evento `system/init`.
- **Entrada**: mensagens do usuário viram linhas JSON no stdin do processo.
- **Saída**: parser tolerante linha a linha do stdout. Evento de tipo desconhecido não quebra o fluxo — é encaminhado à UI como "evento cru" (fallback de renderização).
- **Estados da sessão**: `trabalhando` | `ociosa` | `aguardando_usuario` | `finalizada` | `morta`.
- **Recuperação**: processo morto → estado `morta` + ação "reviver" que respawna com `--resume <session_id>` (contexto preservado).

### 2. API Gateway (backend)

- REST: CRUD de projetos, listagem/criação de sessões, histórico (leitura dos JSONL), ações (pausar, reviver, handoff).
- WebSocket: broadcast de eventos parseados por sessão + recepção de mensagens do usuário.

### 3. Frontend web

- **Dashboard**: um card por projeto — nome, cor/ícone configuráveis, status da sessão, resumo da tarefa atual, última atividade.
- **Chat por sessão**: markdown renderizado, highlight de código, diffs coloridos, tool calls recolhíveis. Carrega histórico do JSONL ao abrir.
- **Sidebar**: navegação entre projetos com indicador de status e badge de não-lidos.
- **Notificações**: Notification API + som quando sessão termina, trava ou aguarda o usuário.

### 4. Handoff para terminal (híbrido)

- Botão "abrir no terminal": backend encerra o processo headless graciosamente, marca a sessão como `em_terminal` e cria janela tmux em `cwd` do projeto rodando `claude --resume <session_id>`.
- Retomada: usuário clica "retomar na web" (ou o backend detecta o fim do processo tmux) → respawn headless com `--resume`.
- Trava: sessão em `em_terminal` não aceita mensagens pela web.

### 5. Hermes — servidor MCP de comunicação inter-agente

Servidor MCP próprio, injetado na configuração de todas as sessões gerenciadas.

- `perguntar_agente(projeto, pergunta)`: enfileira a pergunta como mensagem na sessão-alvo; a resposta retorna como resultado da ferramenta ao chamador (com timeout). Interações visíveis na UI de ambas as sessões.
- `publicar_no_mural(titulo, conteudo)` / `ler_mural(filtro?)`: quadro compartilhado assíncrono em SQLite, também visível na web.
- Roteamento manual: botão "encaminhar para..." em qualquer mensagem da UI injeta o conteúdo em outra sessão (não passa pelo MCP; é função da UI/backend).

### 6. Orquestrador central

Sessão especial do Claude (cwd = raiz de `~/Projects/`) com ferramentas MCP exclusivas: `listar_projetos`, `despachar_tarefa(projeto, tarefa)`, `status_tarefa(id)`, `coletar_resultado(id)`. A UI exibe painel de tarefas despachadas e andamento.

## Fluxo de dados (mensagem do usuário)

```
UI (WS) → Gateway → Session Manager → stdin do claude (stream-json)
claude stdout (stream-json) → parser → eventos tipados → WS broadcast → UI renderiza
                                    ↘ estado da sessão atualizado (dashboard/notificações)
```

Histórico persistido pelos JSONL nativos; a UI lê via REST ao abrir uma sessão.

## Tratamento de erros

- **Processo morre**: estado `morta`, notificação, ação "reviver" com resume.
- **Evento desconhecido no stream**: renderização crua, sem quebrar o parser (proteção contra mudanças de formato entre versões do Claude Code).
- **Resume falha** (ex.: `cwd` divergente): erro claro na UI com o comando manual sugerido.
- **`perguntar_agente` com alvo ocupado/morto**: timeout configurável e erro descritivo devolvido ao agente chamador.

## Fases de entrega

1. **MVP**: Session Manager + Gateway + chat rico + dashboard + notificações.
2. **Comunicação**: handoff tmux + Hermes (direto, mural, manual).
3. **Orquestrador**: sessão maestro + painel de tarefas.

## Estratégia de testes

- **Unitários**: parser de stream-json com fixtures capturadas do binário real (regressão contra mudanças de formato).
- **Integração**: subir uma sessão real com prompt trivial e validar ciclo completo (spawn → mensagem → resposta → estado).
- **UI**: testes leves de componentes (renderização de mensagens, estados do dashboard).

## Fora de escopo (por ora)

- Acesso remoto/autenticação;
- Aprovação de permissões pela web (mitigado por `bypassPermissions` + handoff para terminal);
- Mobile;
- Suporte a outros agentes além do Claude Code.
