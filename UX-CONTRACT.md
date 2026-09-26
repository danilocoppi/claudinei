# Contratos de interação

Registro incremental dos fluxos verificados, não uma certificação de toda a interface legada. Aparência e fontes de tokens: [DESIGN.md](DESIGN.md).

## Fontes e escopo

| Tema | Fonte | Consequência para a interface |
| --- | --- | --- |
| Referências locais | Pedido do usuário em 2026-09-23: `@!` abre arquivos/pastas da raiz do terminal; pasta entra, arquivo seleciona | Iniciar no projeto da sessão e inserir uma referência no rascunho |
| Permissões | `server/src/auth/guards.ts`, `projectFor` em `server/src/routes/files.ts`, `docs/superpowers/specs/2026-07-14-file-viewer-design.md` | Autorizar o projeto antes de listar; não oferecer navegação fora de sua raiz neste seletor, inclusive por symlink |
| Leitura/edição de arquivos | Rotas existentes em `server/src/routes/files.ts` | Selecionar não lê conteúdo, envia, altera ou remove arquivos; visualização posterior continua revalidando acesso |
| Rascunhos | `web/src/drafts.ts`, `ChatInput.tsx` | Referências persistem como parte do texto já salvo por terminal |
| Reinício e indicadores | `AGENTS.md` | Não reiniciar sem nova confirmação; preservar desenho, animações e otimizações |
| Billing, exclusão e texto legal | Não envolvidos neste fluxo | Nenhuma política nova introduzida |

## Referenciar um arquivo com `@!`

1. O gatilho imediatamente antes do cursor abre o popup, como `@@`, com busca própria e foco nela. Não abre dentro de uma palavra nem durante composição IME.
2. A raiz é `project.path` da sessão. Pastas vêm primeiro; a ordenação alfanumérica é estável no servidor. A busca por nome ignora caixa/acentos e vale apenas para a pasta atual.
3. Clicar/ativar uma pasta entra nela. A seta sobe um nível e o nome do projeto volta à raiz. A raiz não permite subir. Links para fora e arquivos especiais/quebrados ficam de fora.
4. A API lista um nível, sem ler conteúdo, em páginas de 100 itens. “Carregar mais” mantém os itens anteriores. Busca/pasta novas reiniciam a paginação.
5. A busca tem debounce de 300ms, clear imediato, Enter que antecipa consulta pendente e cancelamento/isolamento de respostas antigas. Composição IME não seleciona nem envia.
6. Campo de busca: seta para baixo foca o primeiro resultado; Enter seleciona o primeiro resultado disponível. Lista: setas movem foco, Enter/Espaço ativam botões nativos, Tab mantém seu comportamento nativo. Escape fecha e devolve o foco ao rascunho.
7. Selecionar um arquivo substitui apenas o `@!` correspondente por um caminho explícito relativo, entre aspas JSON, e espaço final (ex.: `"./src/arquivo.ts"`). Espaços, acentos, aspas, arquivos ocultos e sem extensão são preservados. O envio é uma ação posterior do usuário; Claude/Codex recebem o caminho no texto.
8. O parser do chat reconhece essa referência completa e o visualizador existente confirma existência e escopo antes de exibi-la como arquivo clicável.

Busca, pasta e paginação são transitórias, locais ao popup; não vão para a URL nem são compartilhadas entre terminais. Essa é uma exceção intencional à persistência de filtros de páginas de dados. Fechar preserva o rascunho, inclusive o gatilho ainda não substituído.

## Cores do ritmo de uso

O multiplicador aparece ao lado do nome de cada limite, com uma casa decimal e separador do idioma ativo (ex.: `All Models (1.5×)` / `Todos os modelos (1,5×)`), conforme pedido posterior do usuário em 2026-09-25. Ele usa o mesmo cálculo da cor e do tooltip. Nome longo pode receber reticências; multiplicador e percentual permanecem visíveis. Sem ritmo finito calculável, o multiplicador é omitido.

Pedido do usuário em 2026-09-25: azul abaixo de 0,7×; verde de 0,7× a 1×; progressão por amarelo até vermelho em 1,5×; vermelho de 1,5× a 2×; roxo somente acima de 2×. O amarelo ocupa o ponto médio, 1,25×. A regra vale para todas as barras em `UsageCard`, via `paceColor`, e a legenda em `UsageInfo` usa a mesma função e mensagens nos três idiomas. Ritmo desconhecido usa cinza para distingui-lo de consumo elevado. Os cálculos de cota, percentual consumido, janela e reset permanecem os mesmos.

Validação: 40 testes de ritmo, card, agrupamento, tokens e i18n; build do frontend; lint do DESIGN sem erros/avisos. Conferência no Chromium com os componentes reais em 393px e 320px, temas claro/escuro, legenda, espanhol e movimento reduzido; imagens inspecionadas em `/tmp/claudinei-usage-colors-vTDBMH`. A auditoria strict manteve os 16 apontamentos legados, sem novos (`/tmp/claudinei-usage-colors-before.json` e `-after.json`).

## Estados e recuperação

Loading, pasta vazia e busca sem resultado são distintos. Falhas de rede/servidor, permissão e pasta removida mostram mensagem inline; retry ou navegação permitem recuperar. Requisições expiram em 12 segundos e são abortadas ao trocar a consulta ou fechar. A API continua usando o tratamento global existente de autenticação/horário de acesso.

O popup é não modal, sem `aria-modal` nem aprisionamento de foco. Foco/clique externo o fecha e mantém o destino escolhido. O scroll dos resultados é próprio; `ViewportPopover` mantém o painel dentro da viewport visual, preservando o modo antigo de coordenadas dos outros menus.

## Verificação do fluxo

- `server/test/files-list.test.ts`: escopo, autorização, traversal/symlinks, busca e paginação.
- `web/src/test/file-mention-input.test.tsx`: cursor, envio, rascunho, teclado, cancelamento, IME e respostas antigas.
- Testes existentes de `mentions`, `files`, `messageblock-files` e `files-routes`: regressões de referências e visualização.
- `scripts/verify-file-mentions.mjs`: navegador com componentes/CSS reais e diretório temporário, sem usar o serviço ou iniciar uma sessão de agente. Executar com `PLAYWRIGHT_MODULE` apontando ao Playwright instalado quando ele não estiver no node_modules do projeto. Inclui telas estreitas/baixas, loading/erro/retry/offline, paginação, teclado, `@@`, tema claro/espanhol e o popover antigo.

Emulação de viewport não equivale a ensaio no teclado físico de um iPhone. Pendências globais de auditoria anteriores ao fluxo devem ser registradas separadamente, sem alargar esta feature para uma migração de toda a interface.

Evidência em 2026-09-23: 58 testes de arquivos no servidor e 102 testes relevantes no frontend aprovados; typecheck do servidor e build do frontend aprovados. O build mantém os avisos existentes de chunks grandes/imports mistos. O ensaio Playwright passou em 1280×800, 393×852, 393×360 e 320×480; screenshots em `/tmp/claudinei-file-mentions-Zmw6i2` foram inspecionados.

O lint de `DESIGN.md` terminou sem erros/avisos. A auditoria estática global em modo strict manteve os mesmos 16 apontamentos anteriores, sem novos: sete decisões de controles nativos não registradas, dois formulários legados, quatro avisos de textarea, dois links de ação com `href="#"` e um botão de fixture. O aviso de `ChatInput` é falso positivo: o resize é definido por `.chat-compose__area` no CSS; os links do visualizador têm handlers e testes de abertura. Os demais fluxos legados não foram migrados nesta feature. JSONs de comparação: `/tmp/claudinei-file-reference-ui-audit-before.json` e `/tmp/claudinei-file-reference-ui-audit-after.json`.
