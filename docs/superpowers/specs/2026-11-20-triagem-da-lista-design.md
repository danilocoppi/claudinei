# Triagem da lista — design

Projeto 4 do roteiro `docs/superpowers/roteiro-ideias-t3code.md` (inspirado nas
seções Pinned/Working/Settled/Snoozed e no `Ctrl+Z` da lista do T3 Code).

## Por quê

A lateral tem cerca de 65 terminais em setores e grupos. Achar o que importa
agora (o que está rodando, o que espera o operador, os poucos em que ele trabalha
todo dia) exige rolar e abrir setores. A ⭐ de hoje só filtra
(`Sidebar.tsx:431`, `sidebarEntries.ts:61`): não muda a posição do cartão. E
não há como tirar da frente um terminal que "terminou por ora" sem mexer na
organização que o operador montou.

Diferença em relação ao T3: lá a lista é de conversas descartáveis. Aqui são
projetos que duram, então nada sai da lista para sempre e nada se assenta sozinho
por tempo.

## Objetivos

1. **Fixar**: a ⭐ vira "fixar" e leva o cartão para a seção **Fixados**, no
   topo.
2. **Trabalhando**: uma faixa no topo com uma linha curta por terminal em
   atividade. Os cartões continuam no lugar deles nos setores e grupos.
3. **Assentar**: recolhe o cartão numa seção **Assentados**, no fim da lista. O
   cartão volta sozinho quando o terminal começa a trabalhar ou pede o operador.
4. **Adiar**: esconde o cartão por **1 h**, **até amanhã às 9:00** ou **até
   segunda às 9:00**. Ele volta antes se pedir o operador ou falhar.
5. **Desfazer com `Ctrl+Z` por 5 s** qualquer uma dessas ações.

## Não-objetivos

- Seleção múltipla e ações em lote: fica para depois.
- Assentar sozinho por tempo ou por evento (o T3 assenta após 7 dias ou com o PR
  integrado). Aqui os projetos são permanentes.
- Atalho "assentar e ir para o próximo" (`Ctrl+Shift+S` no T3): fica para o
  projeto 14 (atalhos configuráveis).
- Mudar setores, grupos, a ordem por arrastar ou o painel inicial (Dashboard).

## Anti-objetivos

- **Rostinhos reiniciando a animação.** Em React, mover um cartão para outra
  seção troca o elemento pai e remonta o cartão, e a animação é preparada de novo
  (`indicatorMotion.ts`). Com 65 terminais mudando de estado o tempo todo, isso
  pesa sem GPU (AGENTS.md). Por isso a faixa Trabalhando **não move cartões**:
  ela só lista. Mover cartões entre seções acontece só por ação do operador, ou
  quando um assentado volta sozinho.
- **Desmontar a organização do operador**: setores, grupos e a ordem continuam
  intactos. Fixar, assentar e adiar são camadas por cima.
- **Esconder o que pede o operador**: um terminal adiado ou assentado que precisa
  dele reaparece sem que ele tenha de procurar.

## Abordagens consideradas

1. **Estado no servidor, por usuário (escolhida).** Tabela própria, que vale em
   qualquer aparelho e para cada usuário com acesso ao terminal.
2. Estado só no navegador (localStorage), como os setores recolhidos. Descartada:
   o estado se perde ao trocar de aparelho, e o acordar antecipado do adiado
   dependeria de o navegador estar aberto.
3. Reaproveitar `projects.favorite`. Descartada: o campo é do projeto,
   compartilhado entre usuários, e qualquer usuário com acesso o muda.

## Como (decidido com o operador)

### Dados

- Tabela `user_triage (user_id, project_id, pinned_at, settled_at,
  snoozed_until)`, com chave `(user_id, project_id)`. `ON DELETE CASCADE` no
  projeto. Sem linha, nada está aplicado.
- `user_id = 0` é a instalação sem autenticação, como em `user_prefs`
  (`server/src/prefs.ts:63-66`).
- Migração: cada usuário (e o usuário 0) começa com fixados os projetos com
  `favorite = 1` aos quais tem acesso. A coluna `favorite` fica no banco, mas a
  interface deixa de usá-la.
- Rotas do usuário logado: `GET /api/triage` e
  `PATCH /api/projects/:id/triage` com `{ pinned?, settled?, snoozedUntil? }`.
  Um WebSocket `triage` vai só para o próprio usuário, para os outros aparelhos
  dele.

### Seções da lateral, de cima para baixo

```
[busca] [só ativos] [só fixados]
TRABALHANDO (3)              ▾
  ✳ AIFinex - Backend   claude · trabalhando
  ◐ Claudinei           codex  · compactando
  ⌨ NFE                 no terminal · processando
FIXADOS                      ▾
  [cartões completos]
SETORES / GRUPOS             (como hoje, sem os fixados, assentados e adiados)
ADIADOS (2)                  ▸  (recolhida; cada cartão mostra "volta às 9:00")
ASSENTADOS (11)              ▸  (recolhida)
```

### Ações

- A estrela do cartão fixa e desafixa.
- O menu de três pontos do cartão (`TerminalMenu.tsx`) ganha **Fixar** /
  **Desafixar**, **Assentar** / **Tirar dos assentados** e **Adiar ▸** (1 h,
  amanhã 9:00, segunda 9:00, cancelar o adiamento).
- O horário de "amanhã 9:00" e "segunda 9:00" é calculado no navegador, no fuso
  do operador, e enviado ao servidor já como horário absoluto.

### Acordar sozinho

- **Assentado**: o servidor tira a marca quando uma sessão do terminal passa a
  `working` ou fica esperando o operador (`needs_attention` ou pergunta
  pendente).
- **Adiado**: o servidor tira a marca quando o terminal espera o operador ou
  falha. O fim do prazo não precisa de evento: `snoozed_until` no passado é lido
  como não adiado.

### Desfazer

- Cada ação do operador gera uma entrada de desfazer que dura 5 s, guardada só
  no navegador. Um aviso mostra, por exemplo, "Assentado · **Desfazer**".
- `Ctrl+Z` desfaz, exceto quando o foco está num campo de texto.
- No celular, que não tem `Ctrl+Z`, o botão do aviso faz o mesmo.

## Decisões de quem escreveu (o operador confere na leitura)

- **Fixar e assentar se excluem.** Assentar um fixado tira o pin; o `Ctrl+Z`
  devolve os dois. Adiar mantém o pin: o cartão some dos Fixados até voltar.
- **"Falha", para acordar um adiado**, quer dizer qualquer um destes casos:
  - a sessão morre inesperadamente (`dead`);
  - aparece o aviso de interrompido do projeto 1 com motivo diferente de
    `queued`;
  - uma execução de agendamento do terminal termina em erro ou timeout.
- **A faixa Trabalhando** lista os terminais com sessão `working`, compactando,
  ou no terminal interativo processando. Também lista assentados, que acordam ao
  trabalhar. Não lista adiados: o operador pediu silêncio.
  - Cada linha mostra só o ícone e o nome do terminal, o motor e o estado, sem
    rostinho, o que não custa animação.
  - O clique abre o chat do terminal.
  - A faixa some quando está vazia e pode ser recolhida, lembrando a escolha.
- **Filtros e busca** valem para todas as seções.
  - "Só ativos" continua como hoje.
  - A chave da ⭐ ("só favoritos") passa a ser "só fixados".
  - A busca também encontra adiados e assentados e abre a seção deles enquanto a
    busca está ativa.
- **Arrastar** continua só nos setores e grupos. Dentro de Fixados, a ordem segue
  a ordem global da lateral; não há arrastar próprio nesta versão.
- **Desempenho**: a divisão entre as seções sai da mesma passagem que monta a
  árvore (`buildEntries`). A faixa Trabalhando lê o estado das sessões por
  seletores estreitos, para não renderizar a lateral inteira a cada evento.
- **Celular**: a mesma lateral na gaveta, com as mesmas seções. O desfazer é
  pelo botão do aviso.
- **O painel inicial (Dashboard)** fica como está.

## Verificação

- **Testes do servidor:**
  - migração (⭐ vira pin para cada usuário com acesso; o usuário 0 também);
  - rotas com controle de acesso (um usuário não vê nem muda o estado de outro);
  - acordar o assentado (`working`, esperando o operador) e o adiado (esperando
    o operador, `dead`, aviso de interrompido, agendamento com erro);
  - `snoozed_until` vencido é lido como não adiado.
- **Testes da interface:**
  - as seções e a ordem;
  - a estrela fixa;
  - as ações do menu;
  - desfazer por `Ctrl+Z` e pelo botão, e que o `Ctrl+Z` é ignorado num campo de
    texto;
  - filtros e busca nas seções novas;
  - a faixa Trabalhando não remonta cartões: um teste com `Profiler` mede commits
    e montagens ao mudar o status de uma sessão.
- **Ensaio na instância isolada (porta 9199):** fixar, assentar e adiar alguns
  terminais e ver que eles voltam sozinhos com o CLI falso.

## Deixado para quem constrói

- Ícones, textos (pt-BR, en, es) e o visual das seções e da faixa, com as
  variáveis de tema e sem animação nova.
- O formato da entrada de desfazer e do aviso.
- Onde exatamente ficam os ganchos de acordar no servidor: status das sessões,
  aviso do projeto 1 e fim de execução de agendamento.
