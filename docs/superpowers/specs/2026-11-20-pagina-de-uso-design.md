# Página de uso — design

Projeto 13 do roteiro `docs/superpowers/roteiro-ideias-t3code.md` (inspirado na
"Página de uso (`Ctrl+U`)" do T3 Code, que lê os históricos locais de cada agente).

## Por quê

O operador roda dezenas de terminais, em quatro motores, e não sabe onde os
tokens vão. O cartão "Uso" da lateral mostra quanto do plano já foi gasto e
quando a janela reabre, mas não quem gastou: nenhum terminal, nenhum modelo.
O Claudinei grava só um total diário por motor (`engine_usage_daily`), sem
projeto nem modelo, e para o Claude não grava nada (o `result` dele não traz
tokens). Os dados existem no disco: os históricos dos agentes guardam o uso de
cada pedido, com modelo e pasta.

## Objetivos

1. Uma página (só administrador) que responde: **quais terminais e quais modelos
   gastam mais tokens**, num período escolhido.
2. Mostrar **quanto o cache economiza**: quantos tokens de entrada vieram do
   cache em vez de serem processados de novo.
3. Abrir com `Ctrl+U` e por uma entrada na lateral (inclusive no celular).
4. Funcionar desde o primeiro dia com o histórico que já está no disco.

## Não-objetivos

- Custo em dinheiro ou "equivalente de API": o operador escolheu tokens (13: A).
  Nada de tabela de preços.
- Substituir o cartão "Uso" da lateral (limites do plano e reset): ele fica como
  está.
- Kimi e OpenCode nesta versão (ver "Decisões de quem escreveu").
- Uso por usuário do Claudinei; uso por conversa individual.
- Ler o conteúdo das mensagens.

## Anti-objetivos

- Pesar o servidor: o índice nunca pode travar a subida, as rotas ou as sessões
  dos agentes, nem varrer 16 GB de uma vez a cada abertura.
- Pesar o navegador sem GPU (AGENTS.md): nada de gráficos com canvas animado ou
  bibliotecas de gráfico pesadas; barras simples em CSS.
- Contar duas vezes: o Claude escreve a mesma resposta em várias linhas.
- Expor dados de projetos a quem não é administrador.

## Abordagens consideradas

1. **Índice incremental dos históricos locais (escolhida).** Um indexador lê os
   arquivos dos agentes aos poucos, lembra até onde leu em cada um (tamanho e
   data de modificação), grava só os números numa tabela do SQLite e a página
   consulta o banco. Tem passado desde o primeiro dia e custa pouco depois da
   primeira passada.
2. Coletar só de agora em diante, pelos eventos das sessões. A página nasceria
   vazia, não veria o que roda fora do Claudinei, e o Claude não manda tokens
   no `result`. Descartada.
3. Reler os arquivos a cada abertura da página. ~8,7 GB só no Claude (3.988
   arquivos); segundos de leitura e muito mais de parse. Descartada.

## Como (decidido com o operador)

### Fontes (v1: Claude e Codex)

- **Claude:** `~/.claude/projects/*/*.jsonl` e os de subagentes
  (`<sessão>/subagents/*.jsonl`). Das linhas `type: "assistant"` lê só:
  `timestamp`, `cwd`, `isSidechain`, `message.id`, `requestId` (quando houver),
  `message.model` e `message.usage` (`input_tokens`, `output_tokens`,
  `cache_read_input_tokens`, `cache_creation_input_tokens`).
- **Deduplicação do Claude:** cada resposta aparece em várias linhas (medido:
  10.317 linhas, 5.078 únicas num arquivo). Chave: `message.id` + `requestId`;
  sem `requestId` (linhas sintéticas de erro), só `message.id`. Linhas com
  `isApiErrorMessage` ou modelo `<synthetic>` não contam.
- **Codex:** `~/.codex/sessions/**/*.jsonl`. `turn_context` dá `model` e `cwd`;
  `event_msg` com `payload.type: "token_count"` dá `info.last_token_usage`
  (`input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`,
  `output_tokens`, `reasoning_output_tokens`). Soma-se o `last_token_usage` de
  cada evento (o `total_token_usage` é acumulado e serve só de conferência).
- Subagentes do Claude contam para o terminal e o modelo deles (um subagente em
  Haiku aparece como Haiku).

### O índice

- Tabela de arquivos lidos: caminho, motor, tamanho e mtime vistos, byte até
  onde leu. Arquivo que cresceu: lê do byte salvo em diante. Arquivo menor que o
  salvo ou com mtime anterior (foi reescrito): relê do zero, apagando antes o que
  veio dele. Arquivo que sumiu (limpeza do agente): os números já indexados
  **ficam** — é assim que a página guarda mais que os ~30 dias do Claude.
- Tabela de uso agregada por **hora × motor × modelo × pasta (cwd)**: entrada,
  saída, lido do cache, escrito no cache, raciocínio. Agregar por hora mantém a
  tabela pequena e basta para os períodos da página.
- A chave de deduplicação do Claude precisa sobreviver entre leituras parciais do
  mesmo arquivo: guardar os ids já contados por arquivo (ou só os da última hora
  lida, já que as repetições ficam juntas no arquivo — escolha de quem constrói,
  desde que nunca conte duas vezes).
- Roda em segundo plano, depois do `listen`, ao subir e a cada 10 min; em fatias
  (por exemplo 20 MB ou 200 ms por vez, cedendo o laço de eventos entre fatias),
  nunca em paralelo consigo mesmo. A primeira passada completa pode levar
  minutos; a página mostra "indexando… X de Y arquivos" enquanto isso.
- Lê linha a linha e só faz parse das linhas que interessam (filtro barato antes
  do `JSON.parse`, como `"type":"assistant"` / `"token_count"` /
  `"turn_context"`). Nunca guarda texto de mensagem.

### Terminal = pasta

- O `cwd` de cada pedido é casado com o caminho dos projetos do Claudinei (pasta
  igual ou dentro dela; a mais específica vence). Sem casamento: balde **"Fora do
  Claudinei"**.
- Pasta compartilhada por dois terminais (já existe no Claudinei): o uso vai para
  a pasta, e a página mostra os terminais da pasta juntos ("Vaexa - Admin /
  Vaexa - Backend"). Separar por terminal exigiria casar conversa por conversa
  com `project_threads` — fica para depois.
- Terminal = projeto + motor, como no resto do Claudinei: a linha do terminal
  mostra o total e a divisão por motor.

### A página

- Nova visão `usage` ao lado de dashboard/chat/board/tasks/schedules; abre com
  `Ctrl+U` (com `preventDefault`, porque o navegador usa para "ver código-fonte")
  e por uma entrada no cartão "Uso" da lateral ("Ver detalhes"). Só administrador
  (mesma regra de `/api/usage`).
- Período: **24 h, 7 dias, 30 dias, 90 dias**. Aviso fixo quando o período passa
  do histórico disponível: "o Claude apaga históricos com mais de ~30 dias; os
  números mais antigos são os que o Claudinei já tinha indexado".
- Blocos:
  1. Totais do período: tokens de entrada, saída, lidos do cache; e a
     **economia do cache** em palavras simples: "X% da entrada veio do cache"
     (lido do cache ÷ (entrada + lido do cache + escrito no cache)).
  2. **Terminais que mais gastam**: lista ordenada, barra horizontal em CSS,
     total e divisão por motor; clicar abre o terminal.
  3. **Modelos que mais gastam**: mesma forma.
  4. Por dia (7/30/90 d) ou por hora (24 h): barras simples.
- "Gasto" para ordenar = entrada + saída + escrito no cache (o lido do cache
  aparece à parte, porque é o que o cache poupou).
- Celular: blocos empilhados, sem tabela larga.

## Decisões de quem escreveu (o operador confere na leitura)

- **Kimi e OpenCode ficam de fora da v1.** O Kimi já soma em `engine_usage_daily`
  (sem projeto nem modelo) e o OpenCode guarda em outro formato (105 MB não
  examinados). Entram depois, num projeto pequeno, se fizerem falta.
- Agregação por hora (não por pedido): suficiente para os períodos e pequena.
- Os números indexados não são apagados quando o agente apaga o histórico; não há
  limpeza automática nesta versão (a tabela cresce devagar: uma linha por hora,
  motor, modelo e pasta usados).
- Pasta compartilhada: uso somado por pasta, não dividido por terminal.
- A entrada da lateral fica dentro do cartão "Uso", que já é só de administrador.

## Verificação

- Testes do servidor, com históricos falsos pequenos (gerados no teste, nunca
  copiados de transcrições reais):
  - deduplicação do Claude (`message.id` + `requestId`), linhas de erro fora;
  - leitura incremental: arquivo que cresce, arquivo reescrito, arquivo apagado
    (números ficam), linha cortada no fim (espera completar);
  - Codex: `turn_context` + `token_count` somando `last_token_usage`;
  - casamento `cwd` → projeto (pasta mais específica, "Fora do Claudinei", pasta
    compartilhada);
  - consultas por período, terminal e modelo; percentual do cache;
  - rota só para administrador (403 para os demais).
- Teste de fatia: o indexador cede o laço de eventos entre fatias (uma rota
  responde enquanto ele roda).
- Testes da interface: os blocos, a troca de período, `Ctrl+U` abre a página e
  não chega ao navegador, aviso de "indexando".
- Ensaio na instância isolada (porta 9199) apontada para os históricos reais
  (somente leitura): tempo da primeira passada, uso de CPU, e conferência de um
  dia contra o `total_token_usage` do Codex e contra a soma manual de um
  transcript do Claude.

## Deixado para quem constrói

- Tamanho da fatia e intervalo entre passadas.
- Onde guardar os ids já contados do Claude.
- Nomes das tabelas e das rotas.
- Textos e chaves de i18n (pt-BR, en, es) e o visual das barras (variáveis de
  tema, sem animação).

## Decisões depois da revisão do desenho (de quem escreveu)

- **Codex repete o mesmo uso em linhas seguidas.** O indexador ignora a repetição quando o total acumulado não mudou (ou usa o uso por resposta, quando o rollout o traz).
- **Mesma base de cache para os dois motores.** O Codex conta os tokens do cache dentro da entrada; o Claude não. Para o Codex, a entrada nova = entrada − cache, e o percentual de cache e o ranking significam a mesma coisa nos dois.
- **"Nunca contar duas vezes" vale entre arquivos**: o mesmo id de resposta do Claude aparece em mais de um arquivo de subagente; a deduplicação é global (id da mensagem + requestId), não por arquivo.
- **Subagentes em subpastas**: o indexador procura `subagents/` recursivamente (há `subagents/workflows/wf_*/`).
