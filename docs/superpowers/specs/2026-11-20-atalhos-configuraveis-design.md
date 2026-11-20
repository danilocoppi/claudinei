# Atalhos configuráveis — desenho

Projeto 14 do roteiro `docs/superpowers/roteiro-ideias-t3code.md` (inspirado no
`keybindings.json` do T3 Code, com editor visual e detecção de conflito).

## Por quê

- Os atalhos estão fixos no código, cada um no seu arquivo e com a sua regra de teclas
  (`ChatInput.tsx`, `speech/shortcut.ts`, `useUsageShortcut.ts`, `useZenShortcut.ts`,
  `keyboard.ts`, `UndoToast.tsx`). Não há lista única nem verificação de conflito. Quem
  quer outra tecla não tem como trocar.
- Ctrl e ⌘ variam: busca, desfazer e guardar aceitam os dois; enviar, voz e uso, só Ctrl.
- As dicas ("Alt+Z liga e desliga") estão escritas à mão em `i18n/pt-BR.ts:206,385,513,538`.

## Objetivos

1. Um **registro central**: um lugar só com id, padrão, rótulo, escopo e se é editável.
2. Um **único ponto** que casa a tecla com a combinação, no lugar das seis funções de hoje.
3. Trocar a tecla das ações gerais numa aba **Atalhos** do painel de aparência, com aviso
   de conflito e "voltar ao padrão" por atalho e geral.
4. A escolha fica na conta do usuário, no servidor, e vale em qualquer navegador.
5. **Mod** uniforme: ⌘ no Mac, Ctrl nos outros sistemas.
6. As dicas na tela mostram a combinação que está valendo.

## Não-objetivos

- Trocar Enter, Shift+Enter, Esc, setas e o salvar dos editores (ficam como "fixo").
- Condições `when`, sequências de teclas, paleta de comandos que busca atalhos.
- Atalhos para ações que hoje não têm (os projetos 9 e 11 não criam nenhum nesta onda).
- Avisar as outras abas na hora: pegam ao recarregar, como a aparência hoje.

## Abordagens consideradas

1. **Registro + função única de casamento, com os ouvintes onde já estão (escolhida).**
   O microfone precisa da soltura da tecla, a busca olha `defaultPrevented`, o campo usa
   o próprio `onKeyDown`. Muda só a pergunta "é este atalho?", que vira
   `matchShortcut(e, id)`, e a regra de foco, que passa a vir do escopo do registro.
2. Um despachante único na janela. Descartada: mudaria a ordem em que os ouvintes tratam
   a tecla e arriscaria a voz, a busca e o campo, sem ganho para o operador.
3. Um `keybindings.json` com `when`, como no T3. Descartada: poder demais para oito ações.

## Desenho

### Registro (`web/src/shortcuts/registry.ts`)

Uma entrada por atalho: `{ id, labelKey, default, scope, editable, adminOnly? }`. Atalho
novo = uma linha na lista, o rótulo nas três línguas e `matchShortcut(e, id)` no ouvinte.
O servidor não conhece os ids.

**Editáveis** (conferidos no código):

| id | Ação | Padrão | Hoje em | Escopo |
|---|---|---|---|---|
| `chat.send` | Enviar | Mod+Enter | `ChatInput.tsx:368-377` | página |
| `chat.queue` | Pôr na fila | Alt+Enter | `ChatInput.tsx:609` | campo |
| `chat.voice` | Microfone | Ctrl+Espaço | `speech/shortcut.ts:8` | página |
| `chat.stash` | Guardar rascunho | Mod+S | `ChatInput.tsx:59-63` | campo |
| `chat.find` | Buscar na conversa | Mod+F | `keyboard.ts:33-42` | conversa |
| `view.zen` | Modo Zen | Alt+Z | `useZenShortcut.ts:14` | tudo, menos o terminal |
| `view.usage` | Página de uso (só admin) | Mod+U | `useUsageShortcut.ts:12` | fora de campos |
| `triage.undo` | Desfazer da triagem | Mod+Z | `UndoToast.tsx:34` | fora de campos e modais |

A lista confere com a decisão do operador; não achei outro atalho geral no mesmo
critério. O Ctrl+Shift+V (colar como texto, `ChatInput.tsx:585`) fica fixo: quem cola
sem formatação é o próprio navegador, e com outra tecla ele colaria normal.

**Fixos** (selo "fixo", sem editar): Enter envia e Shift+Enter quebra linha no campo; ↑/↓
no histórico; Ctrl+Shift+V; Mod+S nos editores (`CodeEditor.tsx:55`,
`HtmlVisualEditor.tsx:52`); Enter e Shift+Enter na barra de busca; Esc (parar o turno,
fechar menu, barra ou visualizador); e "editar texto" (copiar, colar, recortar, selecionar
tudo, desfazer), que é do navegador em qualquer campo.

**Escopos.** As regras de foco de hoje viram funções nomeadas no mesmo módulo, sem mudar
o comportamento: *campo* (só no campo de mensagem); *página* (no campo ou fora de
qualquer outro campo de texto, a regra `isForeignField`); *conversa* (como página, e fora
de modal e do terminal, a regra do `shouldOpenFind`); *fora de campos* (fora de qualquer
campo, inclusive o de mensagem); *tudo, menos o terminal* (o Zen). O que não é foco fica
no componente: o desfazer só existe com o aviso na tela; o uso, só para administrador; o
segundo Mod+F com a barra aberta segue para o navegador.

### Combinação e casamento único (`web/src/shortcuts/combo.ts`)

- **Formato guardado:** texto como `Mod+Shift+K`, modificadores na ordem `Mod`, `Ctrl`,
  `Alt`, `Shift`. Teclas aceitas: A–Z, 0–9, Enter, Space, F1–F12.
- **`Mod`** é ⌘ no Mac e Ctrl nos outros; **`Ctrl`** é sempre a tecla Control. Fora do
  Mac os dois são iguais e a gravação guarda `Mod`; no Mac, ⌘ grava `Mod` e Control grava
  `Ctrl`. O microfone fica `Ctrl+Space` nos dois, porque ⌘+Espaço no Mac é o Spotlight.
- **`isMac()`**, um lugar só: `navigator.userAgentData?.platform` ou `navigator.platform`
  contendo Mac, iPhone ou iPad.
- **`matchShortcut(e, id)`** pega a combinação valendo para o id e compara:
  - modificadores exatos, nem a mais nem a menos;
  - a letra vale por `e.key`; a posição (`KeyX`) só entra quando a tecla dá letra de
    outro alfabeto (cirílico; Option+Z do Mac dá "Ω") ou tecla morta. É a regra atual do
    Zen e do guardar, que passa a valer para todos. No Dvorak a posição do U dá "g", e
    Ctrl+G segue com o navegador (commit a8b7134);
  - dígitos valem pela posição (`DigitN`): em alguns layouts o número só sai com Shift;
  - evento em composição (`isComposing`) nunca casa.
- **Microfone:** a soltura hoje olha Espaço ou Control; passa a olhar a tecla e cada
  modificador da combinação valendo.
- **Mostrar:** `formatCombo` dá "Ctrl+Enter" fora do Mac e "⌘↩" no Mac.

### Campo de mensagem e atalhos globais

- No campo, quem trata é o `onKeyDown` dele: guardar, colar como texto, menu do `/`,
  histórico, Esc, pôr na fila, enviar pela combinação configurada e, por último, o
  **Enter puro**, que envia. Hoje qualquer Enter sem Shift envia; passa a ser só o Enter
  sem modificador. Assim, com a fila em outra tecla, o Alt+Enter antigo não manda a
  mensagem na hora sem querer.
- Os atalhos de escopo *página* e *tudo, menos o terminal* ouvem a janela e valem também
  com o foco no campo. O ouvinte global do enviar continua pulando o campo, para não
  enviar duas vezes.
- O que o campo trata leva `preventDefault`. A busca já ignora evento com
  `defaultPrevented`; o Zen e o desfazer passam a ignorar também.

### Dados e servidor

- `user_prefs` ganha `keybindings TEXT` (nula), pelo `ALTER TABLE` de sempre (`db.ts:170`). Guarda só as **diferenças** do padrão:
  `{ "view.zen": "Alt+M", "triage.undo": null }`, onde `null` é "sem atalho". Quem nunca
  mexeu fica com `{}` e acompanha os padrões de versões futuras.
- `sanitizeKeybindings` em `server/src/prefs.ts`, no molde do `sanitizeAppearance`, confere
  só a forma: id em `^[a-z][a-z0-9.-]{0,40}$`, combinação pela gramática ou `null`, até 64
  entradas. O que não passa é descartado sem recusar o resto. Id novo muda só o cliente.
- `GET /api/prefs` devolve `{ appearance, keybindings }`. `PUT` aceita os dois, ambos
  opcionais; o que não vier não muda (hoje um PUT sem `appearance` voltaria a aparência
  ao padrão). A resposta traz os dois saneados.
- Usuário sem linha: o INSERT grava a aparência padrão (`appearance` é `NOT NULL`). Token
  de serviço: GET devolve `{}`, PUT dá 403, como hoje. A linha 0 segue sendo a instalação
  sem login. JSON corrompido na coluna vale `{}`.

### Web

- **Estado:** a store ganha `keybindings: { overrides, resolved, notices }`. `resolved` é
  id → combinação valendo (ou nenhuma) neste navegador; `notices` diz por que algum não
  vale. Cache em localStorage (`claudinei:keybindings`), no molde do `cacheAppearance`,
  para os atalhos valerem antes do primeiro `fetch`.
- **Aba Atalhos:** o `AppearancePanel` ganha as abas "Aparência" e "Atalhos". A aba lista
  todos, com rótulo, combinação e o selo "fixo" quando for o caso. A linha do uso só
  aparece para administrador.
- **Gravar:** clicar na combinação mostra "aperte a nova combinação…". O painel escuta em
  captura, com `preventDefault` e `stopImmediatePropagation`: nenhum atalho dispara
  enquanto grava (Alt+Z não liga o Zen). Esc cancela; um modificador sozinho não grava.
- **Conflitos**, avisados na própria linha:
  - *com outro editável:* "Já é o atalho de Modo Zen", com **Trocar** (o outro fica sem
    atalho) e **Cancelar**;
  - *com um fixo:* recusado, quando os dois ouvem no mesmo lugar. Ação que vale no campo
    de mensagem não pode usar a edição de texto (Mod+C, V, X, A, Z, Y, Mod+Shift+Z) nem
    Mod+Shift+V; o Zen, que vale nos editores, não pode usar Mod+S. O guardar (Mod+S, só
    no campo) e o salvar dos editores convivem como hoje;
  - *reservado, que a página nem recebe:* recusado. Fora do Mac: Ctrl+W, T, N,
    Ctrl+Shift+W, T, N, Q, Ctrl+Tab, Alt+F4. No Mac: ⌘W, T, N, Q, H, M, ⌘⇧W, T, N, ⌘Tab,
    ⌘Espaço;
  - *do navegador, mas a página consegue tomar:* aviso amarelo, aceito (Mod+R, L, P, D, G,
    J, O; Alt+D, E, F fora do Mac). É o que o Ctrl+U já faz com o "ver código-fonte";
  - *sem Ctrl, ⌘ ou Alt:* recusado, para não roubar letras da digitação;
  - *Ctrl+Alt fora do Mac:* recusado. No Windows é o AltGr, que no ABNT2 escreve "/", "?", "°".
- **Voltar ao padrão:** um botão por linha (só quando difere) e "Voltar todos ao padrão"
  no rodapé da aba. O "Restaurar" de hoje (`AppearancePanel.tsx:212`) fica só na aparência.
- **Salvar:** a aba edita um rascunho, **sem prévia ao vivo**: o atalho novo só vale depois
  de Salvar. O Salvar do painel manda um PUT só com o que mudou; Cancelar descarta tudo.
  Se a rede falhar, o erro aparece no painel e nada muda.
- **Dicas na tela:** as quatro frases das traduções recebem `{{combo}}` de `formatCombo`,
  nas três línguas. Ação sem atalho: a dica não cita tecla.

## Erros e bordas

- **Combinação salva que depois fica inválida.** Ao carregar, `resolveBindings` monta o
  `resolved` nesta ordem: fixos e reservados do sistema atual; escolhas do usuário, na
  ordem do registro; padrões das ações que ele não mexeu. O que não cabe não vale, e a
  linha da aba diz o porquê:
  - id que saiu do registro: ignorado; some do banco no próximo Salvar;
  - combinação que virou reservada ou fixa numa versão nova, ou que a gramática não aceita
    mais: a ação volta ao padrão, com "voltou ao padrão porque …";
  - padrão de ação nova que bate com uma escolha do usuário: a escolha vence; a ação nova
    fica sem atalho, com aviso (idem se o padrão de quem voltou estiver ocupado).
  Nada disso é gravado sozinho: a escolha guardada continua no servidor.
- **Mesma conta no Mac e no Linux.** `Mod` acompanha o sistema. Combinação reservada só num
  deles (⌘H no Mac) volta ao padrão só ali, com aviso, e continua valendo no outro.
- **Tecla segurada:** o Zen ignora a repetição; o microfone mantém toque e segurar. No
  celular, sem teclado físico, os botões continuam sendo o caminho.
- **Mudança de comportamento:** fora do Mac, a tecla Windows/Super deixa de valer como Ctrl
  na busca, no desfazer e no guardar. No Mac, enviar e uso passam a ser com ⌘, e o Control
  deixa de valer em enviar, uso, busca, desfazer e guardar (salvo se o usuário gravar `Ctrl`).

## Ordem do próximo envio e desempenho

Não entra na ordem: os atalhos só disparam ações que já existem, e a fila já tem o seu
lugar (item 3) em `server/src/queue/next-send.ts`. Sem animação nova; continua um ouvinte
por ação, e o casamento é uma consulta ao mapa `resolved`.

## Testes

- `combo.ts`: ler, formatar e casar no Mac e fora dele (`Mod`, `Ctrl` literal); Dvorak,
  cirílico, Option+Z, tecla morta, dígito com Shift, `isComposing`, modificador a mais.
- `resolveBindings`: id desconhecido, reservada, conflito com fixo, padrão novo ocupado,
  reservada só no Mac; cada caso com o aviso certo.
- Servidor: `sanitizeKeybindings` (forma, `null`, limite, JSON corrompido); PUT só com
  `keybindings` não mexe na aparência e vice-versa; token de serviço 403; linha nova com
  a aparência padrão.
- Os testes atuais passam com os padrões (`usage-page`, `chatinput-stash`, `chatinput-paste`,
  `zen`, `mic-shortcut`, `triage-actions`, `chat-find`, `chat-ctrl-enter`, `keyboard`). Os casos que esperam ⌘ fora do Mac
  (`keyboard.test.ts:43`, `triage-actions.test.tsx:257`) passam a simular o Mac.
- Com atalhos trocados: cada ação dispara pela combinação nova e não pela antiga; o
  Alt+Enter, com a fila em outra tecla, não envia; o microfone solta pelos modificadores novos.
- Aba: gravar, Esc cancela, Alt+Z gravado não liga o Zen, os avisos de conflito, Trocar,
  voltar ao padrão (um e todos), Salvar manda só o que mudou, a dica muda, uso só para admin.

## Decisões de quem escreveu (o operador confere na leitura)

- **`Mod` estrito:** ⌘ no Mac, Ctrl nos outros, sem aceitar os dois. No Mac, Control+F e
  Control+U ficam com o macOS, que os usa para mover o cursor e apagar a linha.
- **Microfone com Control também no Mac**, por causa do Spotlight.
- **"Sem atalho" existe**, por "Trocar" num conflito ou limpando a linha; sem isso não daria
  para inverter dois atalhos.
- **Teclas aceitas:** letras, dígitos, Enter, Espaço e F1–F12. Pontuação fica de fora por
  mudar de lugar entre layouts.
- **Ctrl+Alt recusado fora do Mac**, por causa do AltGr.
- **Option+letra no Mac casa pela posição física** (`e.code`, `KeyX`), tanto ao gravar quanto ao
  disparar, porque o Option troca a letra (`å`, `ß`, `ç`, `∂`…) e o casamento por `e.key`
  nunca acertaria. Aceita-se errar em Dvorak/AZERTY no Mac; o operador usa Linux. Fora desse
  caso vale a regra geral (letra primeiro, posição só para outro alfabeto ou tecla morta).
- **Listas de fixos e reservados completadas** (checagem do construtor):
  - fixos do navegador em qualquer lugar, inclusive fora de campos: Mod+C, Mod+V, Mod+X e
    Mod+A (copiar, colar, recortar e selecionar o texto da conversa);
  - fixos de edição do macOS dentro de campos: Control+A, B, D, E, F, H, K, N, P e U;
  - reservados fora do Mac: além dos já listados, Ctrl+F4 e Ctrl+1 a Ctrl+9; no Mac,
    ⌘+1 a ⌘+9.
- **Teclas F podem ser usadas sozinhas** (ex.: F2), porque não roubam digitação. Ficam
  reservadas F1, F5, F11, F12 e Ctrl+F5. Letras, dígitos, Enter e Espaço continuam exigindo
  Ctrl, ⌘ ou Alt.

## Depois

- "Assentar e ir para o próximo" (`Ctrl+Shift+S` no T3), que a spec da triagem deixou para
  este projeto: é ação nova, não troca de tecla. Com o registro, vira uma linha e uma
  chamada `matchShortcut`. O mesmo vale para atalhos futuros dos projetos 9 e 11.
