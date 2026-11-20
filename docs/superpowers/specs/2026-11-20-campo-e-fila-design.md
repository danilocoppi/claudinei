# Campo de mensagem e fila editável — desenho

Projetos 8 ("Pequenos do campo e da conversa") e 5 ("Fila editável") do roteiro
`docs/superpowers/roteiro-ideias-t3code.md`, numa trilha só (8 primeiro, 5
depois), mais uma sobra da onda A: o aviso de terminal sem nenhum motor
instalado.

## Por quê

O campo de mensagem é onde o operador passa o dia, e hoje ele tem atritos
pequenos que somam:

- Uma ideia que ainda não é hora de mandar não tem onde ficar: ou fica no campo
  (atrapalhando a mensagem seguinte) ou se perde.
- Colar um log ou um arquivo grande enche o campo e, no Kimi e no OpenCode, pode
  estourar o limite de ~120 KB por mensagem (`MAX_PROMPT_BYTES`).
- Não há como focar só na conversa: lateral, cabeçalho e coluna de
  acompanhamento disputam a tela.
- Mensagem mandada no meio do turno entra no turno atual no Claude e no Codex —
  é o que o operador quer como padrão (acréscimo, nunca cancelamento) —, mas não
  há como deixar algo **para o próximo turno**, e no Kimi e no OpenCode a
  mensagem é simplesmente recusada ("turno em andamento").

## Objetivos

1. **Modo Zen**: uma tecla esconde a moldura (lateral, cabeçalho do chat e coluna
   de acompanhamento) e a mesma tecla traz de volta.
2. **Guardar o prompt (Ctrl+S)**: tira o rascunho do campo e guarda para depois;
   com o campo vazio, Ctrl+S traz de volta o último guardado.
3. **Colar texto grande vira anexo**: acima de um limite, o texto colado vira um
   arquivo `.txt` anexado; Ctrl+Shift+V cola como texto mesmo assim.
4. **Fila do próximo turno**: mensagens que esperam o turno acabar, visíveis acima
   do campo, com editar, reordenar, remover e "enviar agora".
5. **Aviso de terminal sem motor instalado** (sobra da onda A).

## Não-objetivos

- Esconder as ações do agente (ferramentas) como o "Zen" do T3 — o operador
  escolheu esconder só a moldura. Fica para depois, se ele pedir.
- Fila compartilhada entre motores ou entre terminais: a fila é da sessão.
- Retirar texto que já foi entregue ao CLI (no meio do turno, no Claude/Codex):
  só o que está na fila é editável.
- Guardar prompts no servidor (vale por navegador).

## Anti-objetivos

- Mudar o padrão da mensagem no meio do turno: no Claude e no Codex ela continua
  entrando no turno atual. A fila é opt-in (Alt+Enter), exceto onde o motor não
  aceita acréscimo (Kimi, OpenCode), que hoje recusa.
- Uma mensagem na fila ser mandada quando o operador não espera (depois de um
  erro, de um limite, de um interrompido): a fila **para** nesses casos.
- Perder anexos ao guardar ou restaurar um rascunho.
- Peso na interface sem GPU (AGENTS.md): nada de animação contínua nova.

## Abordagens consideradas

1. **Fila no servidor, por sessão (escolhida).** Sobrevive a recarregar a página e
   a trocar de aba/máquina; o servidor sabe quando o turno acabou e entrega na
   hora certa, mesmo com o navegador fechado.
2. Fila só no navegador. Mais simples, mas some ao recarregar e depende da aba
   aberta para entregar. Descartada.

Ctrl+S, Zen e colar ficam no navegador (localStorage), como o rascunho e o
`railMode` de hoje.

## Como (decidido com o operador)

### Modo Zen

- Esconde só a moldura: `Sidebar` + `SidebarResizer` (e o `MobileTopbar` no
  celular), o cabeçalho do chat (projeto, abas de motor, Progress, Schedules,
  "Abrir no terminal") e a `ProgressColumn`. O chat, o campo e os avisos
  (interrompido, limite, perguntas) continuam.
- Persistido por navegador em localStorage (`claudinei:zen`), no mesmo molde do
  `railMode` (`web/src/store.ts:17`, `:373-384`).
- Atalho: **Alt+Z** (ver "Decisões de quem escreveu").

### Mensagem no meio do turno (decidido: opção a)

- **Claude e Codex**: Enter continua como hoje — entra no turno atual (Claude
  escreve no stdin; Codex usa `pendingInputs` + `turn/steer`,
  `codex-session.ts:134-139`). **Alt+Enter** manda para a fila do próximo turno.
- **Kimi e OpenCode**: como hoje recusam no meio do turno
  (`kimi-session.ts:53`, `opencode-session.ts:38`), Enter no meio do turno vai
  para a fila.
- Com o agente parado, Enter manda na hora e Alt+Enter também (fila vazia + livre
  = entrega imediata).

### A fila

- Mostrada acima do campo, uma linha por mensagem (texto encurtado + anexos), com
  editar, arrastar para reordenar, remover e **enviar agora**.
- Entrega: quando a sessão fica livre (`idle`/`needs_attention`, o mesmo sinal do
  `onSessionAvailable` em `manager.ts:420-423`), o servidor manda **uma**
  mensagem da fila, como mensagem do operador; a próxima espera o turno seguinte
  acabar.
- **"Enviar agora"**: no Claude e no Codex, injeta no turno atual (como Enter); no
  Kimi e no OpenCode, interrompe o turno e manda.

## Decisões de quem escreveu (o operador confere na leitura)

- **Ctrl+S guarda**: o rascunho do campo, **com o mapa de anexos**
  (token → caminho), vai para uma lista de até **10 por terminal**
  (projeto + motor, para sobreviver a sessões novas; o rascunho de hoje é por
  sessão, `drafts.ts`), em localStorage. Com o campo vazio, Ctrl+S traz de volta o
  último guardado (e o tira da lista). Uma lista curta acessível por um ícone no
  campo mostra os outros. `preventDefault` sempre (senão o navegador abre "Salvar
  página"). Passando de 10, o mais antigo sai.
- **Colar grande**: acima de **10 KB ou 100 linhas**, o texto colado vira
  `colado-<hora>.txt`, enviado pela rota de uploads que já existe
  (`POST /api/uploads`) e mostrado como o token `[📎 …]` de sempre — o agente
  recebe o caminho, como com qualquer anexo. **Ctrl+Shift+V** cola como texto.
- **A fila para** quando o turno termina com erro, com limite de uso, ou foi
  interrompido pelo operador (Esc/Parar), e quando a sessão morre ou para: as
  mensagens ficam, com um aviso "fila pausada" e um botão **Retomar fila**.
  Mandar uma mensagem normal não retoma a fila.
- **Retomada do Claudinei** (reinício, limite, goals): a fila espera; a mensagem
  do Claudinei tem prioridade, e a fila segue depois do turno dela.
- **A fila é da sessão**: se a sessão for substituída (nova sessão do mesmo
  terminal), os itens migram para a nova; se o terminal for excluído, somem.
- **Tamanho**: até 20 itens por sessão; cada item obedece aos limites de mensagem
  de hoje.
- **Atalho do Zen: Alt+Z.** Não colide com Ctrl+Enter, Ctrl+Space, Ctrl+U,
  Ctrl+Z, Ctrl+S nem Ctrl+F. É ignorado no terminal interativo (onde Alt+Z é do
  shell/TUI), seguindo a regra de `isForeignField` (`web/src/keyboard.ts:6`)
  ampliada para o terminal. No modo Zen, um botão discreto no canto também sai do
  modo (para quem não lembra a tecla e no celular).
- **Mensagem do operador limpa a "pausa"?** Não: a fila só volta com Retomar fila
  (evita entrega surpresa).

### Aviso de terminal sem motor instalado (sobra da onda A)

Quando **todos** os motores da lista do terminal estão desinstalados (o
`tabEngines` de `web/src/terminalEngines.ts:32` não sobra nenhum) e não há sessão
viva, o cabeçalho mostra, no lugar das abas: "Nenhum motor desta lista está
instalado — editar", com o link abrindo ⋮ → Editar (o `NewProjectModal`). Sem
animação.

## Verificação

- Testes da web: Zen esconde e mostra a moldura e persiste; Alt+Z ignorado no
  terminal; Ctrl+S guarda e restaura **com anexos**, limite de 10; colar acima e
  abaixo do limite; Ctrl+Shift+V; a fila aparece, edita, reordena, remove;
  Alt+Enter vai para a fila; aviso de motores desinstalados.
- Testes do servidor: fila por sessão (criar, editar, reordenar, remover);
  entrega uma por turno ao ficar livre; pausa em erro, limite, interrompido,
  morte; "enviar agora" por motor (injeta vs interrompe e manda); migração para
  sessão nova; prioridade da mensagem do Claudinei.
- Ensaio numa instância isolada com o CLI falso: turno longo + duas mensagens na
  fila + reordenar + "enviar agora"; fila pausada por erro; recarregar a página
  mantém a fila.

## Deixado para quem constrói

- Rotas e mensagens de WebSocket da fila; onde guardar (tabela nova).
- O visual da fila e do ícone dos rascunhos guardados (variáveis de tema).
- Textos nas três línguas.
- Detalhe do arrastar para reordenar (pode ser setas ↑/↓ no celular).
