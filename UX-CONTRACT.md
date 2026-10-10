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

## Favoritos dos terminais

Pedido do usuário em 2026-09-29: a estrela no cartão marca/desmarca o terminal como favorito, inclusive quando o cartão está compacto. A marca fica no banco junto ao terminal e aparece para os usuários que podem acessá-lo, também em outros dispositivos. Qualquer usuário com acesso ao terminal pode mudar essa marca; o filtro de favoritos é apenas uma preferência de visualização deste navegador, persistida no localStorage.

O switch com estrela mostra somente terminais favoritos. Pode ser combinado com “Somente ativos”; nesse caso, só aparecem favoritos com agente ativo. Setores e grupos sem filhos visíveis desaparecem, e os contadores exibem visíveis/total. Os dados completos continuam sendo a fonte da ordenação; o arraste fica indisponível enquanto um filtro está ligado. Remover a estrela no modo filtrado retira o cartão da lista. Falha na gravação restaura o estado anterior e mostra uma mensagem. Sem resultados, a lista explica se faltam ativos, favoritos ou terminais que atendam aos dois filtros.

## Busca na lateral

Pedido do usuário em 2026-10-04: um campo no alto da lista de terminais filtra pelo nome. O trecho pode estar em qualquer posição do nome; a busca ignora caixa e acentos e, com várias palavras, exige todas, em qualquer ordem. É a mesma regra do `@@` (`matchesSearch` em `web/src/mentions.ts`), para que procurar um terminal não dê resultados diferentes conforme o lugar. Um grupo ou setor cujo nome bate traz todos os seus terminais.

A busca se combina com os filtros de ativos e favoritos. Enquanto há texto, grupos e setores recolhidos abrem só na visão, sem mudar o que está salvo; os contadores mostram visíveis/total e o arraste fica indisponível. A busca é transitória: não vai para o localStorage e não sobrevive a recarregar a página, porque uma busca esquecida faria a lista parecer vazia sem motivo. O × e o Escape limpam; Escape com o campo vazio devolve o foco à página. Sem resultado, a lista mostra o termo procurado e avisa quando um filtro ligado esconde o resultado. O campo só aparece quando há terminais e some no modo régua, onde a busca deixa de filtrar. Em telas de até 768px o texto do campo tem 16px, para o iPhone não ampliar a página ao focar.

## Terminal temporário

Pedido do usuário em 2026-10-04: criar um terminal para conversar sem escolher pasta. O botão de raio no cabeçalho, antes de “+ Terminal” e só para admin, pede ao servidor (`POST /api/projects/scratch`) uma pasta nova `temp-AAAAMMDD-HHMMSS` em `~/.claudinei/scratch` (ou em `CLAUDINEI_SCRATCH`) e cria nela um terminal chamado “Temporário <dia/mês hora>”, com o ícone 🧪. A pasta fica fora do `/tmp` porque o sistema o esvazia.

O caminho nunca vem do cliente. O servidor valida nome e ícone antes de criar a pasta, para que um pedido recusado não deixe pasta órfã, e duas criações no mesmo segundo recebem sufixo em vez de dividir a pasta. Excluir o terminal pelo menu não apaga a pasta; ela fica até o usuário removê-la.

Correção em 2026-10-08: o raio abre a escolha de engine e modelo com um rascunho (nome e ícone) e não cria nada. O terminal e a pasta só nascem ao clicar em “Iniciar sessão”; Cancelar e o clique fora não deixam terminal nem pasta. Depois de criar, a lista recarrega e a busca é limpa. Falha na criação aparece no próprio modal. Se o terminal foi criado mas a sessão foi recusada, tentar de novo usa o mesmo terminal, e o botão não aceita um segundo clique enquanto o pedido anterior não volta.

Verificação em 2026-10-04: `server/test/projects-scratch.test.ts`, `server/test/auth-rbac.test.ts`, `web/src/test/sidebar-search.test.tsx` e `web/src/test/sidebar-entries.test.ts`, com as suítes completas aprovadas (1234 no servidor, 1212 no frontend). Ensaio numa instância isolada, só com mouse e teclado reais: “BACKEND” achou os dois terminais Backend, “acao critica” achou “Ação Crítica”, o nome do grupo trouxe seu terminal com contador 1/1, a busca sem resultado mostrou o termo, × e Escape limparam. O raio criou a pasta e o terminal, limpou a busca e abriu “Nova sessão”; a sessão iniciada rodou dentro da pasta temporária, e excluir o terminal manteve a pasta.

## Excluir terminal com sessões abertas

Pedido do usuário em 2026-10-07: excluir um terminal com sessão aberta não pode só mostrar um erro e parar. As duas portas de exclusão — o menu do cartão na lateral e a lixeira do cartão no painel — usam o mesmo `DeleteProjectDialog`. Sem sessão aberta, ele é o diálogo de sempre. Com sessões abertas em qualquer engine (iniciando, ociosa, trabalhando, esperando você ou no terminal), lista cada uma como “engine — estado” e mostra a caixa “Estou ciente de que as sessões serão finalizadas”; Excluir fica desabilitado até ela ser marcada.

Ao confirmar, o servidor (`DELETE /api/projects/:id?stopSessions=1`, só admin) finaliza cada sessão e espera o processo encerrar: a do chat pelo `manager.stop`, a do terminal fechando o PTY. Depois confere de novo e só então fecha as ações e remove o terminal; se alguma sessão continuar de pé, recusa e não remove nada. Sem `stopSessions`, a recusa (409) traz a lista das sessões abertas. Se o navegador não sabia de uma sessão que abriu depois, essa lista passa a valer no diálogo, a caixa volta desmarcada e uma mensagem pede nova confirmação — nada é finalizado sem o operador ter visto o quê. Enquanto finaliza, o botão mostra “Finalizando sessões…” e não aceita outro clique; Cancelar e o clique fora não fecham o diálogo no meio da operação.

Correção em 2026-10-09: uma sessão revivida que ainda não recebeu mensagem também conta como aberta. Reviver não gravava o estado no banco até a primeira mensagem, então a exclusão via a sessão viva, não achava o que finalizar e recusava com “não foi possível finalizar todas as sessões”. Agora o estado inicial de toda sessão ligada vai para o banco na hora.

Verificação em 2026-10-07: `server/test/routes-projects.test.ts` e `web/src/test/delete-project-dialog.test.tsx`, com as suítes completas aprovadas (1237 no servidor, 1216 no frontend); a remoção da conferência final e a remoção da exigência da caixa foram sabotadas e os testes as pegaram. Ensaio numa instância isolada com CLIs falsas de Claude e Codex, só com mouse real: o terminal com uma sessão Claude no chat e uma Codex no terminal mostrou as duas, o botão só habilitou com a caixa marcada, e a exclusão encerrou os dois processos; a lixeira do painel mostrou o texto no singular e encerrou a sessão do outro terminal.

## Pasta padrão e pasta nova

Pedido do usuário em 2026-10-08: criar um terminal numa pasta nova, a partir de uma pasta padrão configurável. A pasta padrão fica no painel da engrenagem, numa seção “Terminais” visível só para admin, e é uma configuração do Claudinei — vale para todos os admins, porque só admin cria terminal. Como a escolha do terminal da máquina, ela grava na hora, fora do rascunho de aparência que o Salvar confirma. O servidor (`GET`/`PUT /api/settings/default-folder`, só admin, porque revela caminhos) só aceita uma pasta que exista. Sem configuração, a efetiva é a pasta pessoal; se a guardada sumir do disco, a efetiva volta a ser a pessoal e o painel avisa.

No “+ Terminal”, o campo de pasta já vem com a pasta padrão, e trocá-la abre o seletor dentro dela; uma pasta escolhida antes de a padrão chegar do servidor não é sobrescrita. A caixa “Criar pasta nova dentro desta” mostra o campo do nome e o caminho final (“Será criada: …”). O nome acompanha o do terminal, sem acento e com hífens (“Meu App” → `meu-app`), até o operador editá-lo; sem nome, Criar fica desabilitado. Com a caixa marcada, o aviso de pasta já usada não aparece, porque o caminho escolhido é só a base.

O servidor (`POST /api/projects` com `newFolder`) valida o nome antes de qualquer `mkdir` — sem barra, sem `.`/`..`, até 120 caracteres — e cria a pasta sem `recursive`: se ela já existe, recusa com 409 sem tocar no que está lá, e o modal mostra o erro sem fechar. Se o terminal for recusado depois de a pasta ser criada, a pasta recém-criada é removida.

Verificação em 2026-10-08: `server/test/new-folder.test.ts`, `server/test/routes-projects.test.ts`, `server/test/auth-rbac.test.ts`, `web/src/test/folder-slug.test.ts`, `web/src/test/new-project-modal.test.tsx` e `web/src/test/default-folder-settings.test.tsx`, com as suítes completas aprovadas (1251 no servidor, 1230 no frontend); sabotagens na remoção da pasta, na recusa de barras, no nome que acompanha o terminal e na proteção contra a resposta atrasada foram pegas. Ensaio numa instância isolada, só com mouse e teclado reais: a pasta padrão foi escolhida navegando pelo seletor e gravada; o “+ Terminal” veio com ela, a pasta `meu-app-e2e` foi sugerida e criada no disco com o terminal; repetir o nome mostrou “a pasta já existe” com o modal aberto.

## Editor de agendamentos

Ao criar ou editar, `ScheduleEditor` monta `.modal-overlay` diretamente em `document.body`. A lista e os cartões têm rolagem/recorte próprios; o diálogo fora dessa árvore ocupa a viewport e mantém título e Salvar/Cancelar acessíveis. Em altura reduzida, apenas o corpo do formulário rola. O diálogo expõe nome acessível e estado modal. Fechar ou salvar mantém os fluxos existentes de `SchedulesView`.

## Modelos do Codex

O Claudinei consulta `model/list` da CLI para mostrar somente os modelos liberados à conta, com os nomes, esforços e padrão informados por ela. Ao iniciar ou alterar uma sessão, o valor enviado continua sendo o ID do modelo. Se a consulta falhar, o catálogo de reserva oferece GPT-6.1 Sol como padrão, seguido pelos modelos anteriores ainda presentes no catálogo da CLI em 2026-09-29; uma consulta posterior bem-sucedida substitui essa reserva.

## Cores do ritmo de uso

O multiplicador aparece ao lado do nome de cada limite, com uma casa decimal e separador do idioma ativo (ex.: `All Models (1.5×)` / `Todos os modelos (1,5×)`), conforme pedido posterior do usuário em 2026-09-25. Ele usa o mesmo cálculo da cor e do tooltip. Nome longo pode receber reticências; multiplicador e percentual permanecem visíveis. Sem ritmo finito calculável, o multiplicador é omitido.

Pedido do usuário em 2026-09-25: azul abaixo de 0,7×; verde de 0,7× a 1×; progressão por amarelo até vermelho em 1,5×; vermelho de 1,5× a 2×; roxo somente acima de 2×. O amarelo ocupa o ponto médio, 1,25×. A regra vale para todas as barras em `UsageCard`, via `paceColor`, e a legenda em `UsageInfo` usa a mesma função e mensagens nos três idiomas. Ritmo desconhecido usa cinza para distingui-lo de consumo elevado. Os cálculos de cota, percentual consumido, janela e reset permanecem os mesmos.

Validação: 40 testes de ritmo, card, agrupamento, tokens e i18n; build do frontend; lint do DESIGN sem erros/avisos. Conferência no Chromium com os componentes reais em 393px e 320px, temas claro/escuro, legenda, espanhol e movimento reduzido; imagens inspecionadas em `/tmp/claudinei-usage-colors-vTDBMH`. A auditoria strict manteve os 16 apontamentos legados, sem novos (`/tmp/claudinei-usage-colors-before.json` e `-after.json`).

## Editar o HTML pela página

Pedido de 2026-09-28: oferecer o lápis na visão formatada com WYSIWYG. `FileBody`/`HtmlBody` compartilham `TextDocument` entre popup e inline; `TextDocument` é dono da leitura, rascunho, hash, salvamento e erros. A variante HTML troca apenas a apresentação entre `HtmlVisualEditor` (Página) e `CodeEditor` (Fonte), mantendo o mesmo rascunho. A edição visual cobre texto, negrito, itálico, sublinhado, listas e desfazer/refazer; não reorganiza o layout por arrasto.

O lápis exige projeto e hash lido; na Página também exige a URL da prévia para resolver CSS/imagens locais. Salvar usa a rota e autorização existentes (`POST /api/files/write`, `baseHash`); conflitos e falhas preservam o rascunho, e novas edições durante um save permanecem pendentes. Concluir/fechar com alterações exige o diálogo de descarte existente; a saída real da página usa `beforeunload`. Trocar Página/Fonte conserva alterações, mas remontar um editor reinicia seu histórico de desfazer. Recarregar após conflito substitui o rascunho pela versão do disco, como no editor de fonte.

A prévia interativa continua em origem opaca (`sandbox="allow-scripts"`). A edição usa outro iframe com scripts desativados (`sandbox="allow-same-origin"`, CSP `script-src 'none'`); as duas permissões nunca são combinadas. Apenas recursos da concessão de leitura podem carregar. Formulários, navegação por links, refresh e embeds ficam inativos. Colagem insere texto simples. Conteúdo gerado por scripts não aparece durante a edição; a interface informa essa limitação. O serializador preserva o head, scripts e URLs relativas, altera o corpo e remove os detalhes temporários do editor; o navegador pode normalizar a sintaxe do HTML no primeiro save. Sem alteração, mantém o fonte exato.

Verificação: testes de preservação/isolamento em `html-visual.test.ts`, testes dos visualizadores e do salvamento em `text-document.test.tsx`, e `scripts/verify-html-visual.mjs` com componentes reais, API temporária, conflito/erro/retry, alternância de abas, teclas, inline em 393/320px, espanhol e movimento reduzido. O script não usa o serviço nem os arquivos do usuário.

### Preencher relatórios sem acionar Editar

Correção solicitada em 2026-09-28: interagir com checkboxes ou campos na Página deve disponibilizar Salvar, sem exigir o lápis. A prévia captura checkbox, rádio, texto/número/data e outros inputs comuns, textarea, select simples/múltiplo e regiões `contenteditable`. Marcar e desfazer antes de salvar volta ao estado limpo. Senhas e seleção de arquivo não entram no conteúdo persistido. Só o clique em Salvar grava o arquivo; navegar entre Página/Fonte mantém o preenchimento, e fechar com valores pendentes usa a confirmação existente.

`shared/html-form.ts` é dono da captura/restauração; `web/src/editor/html-form.ts` aplica os valores ao HTML original e `TextDocument` continua dono do rascunho/save/conflito. Valores estáticos viram atributos/conteúdo nativos; um estado e restaurador locais no HTML preservam também campos gerados por script, inclusive ao abrir o relatório fora do Claudinei. Não se salva um snapshot de todo o DOM da aplicação em execução, nem dados em localStorage. IDs/nomes dos campos identificam controles; controles sem identidade usam sua ordem dentro do tipo. Reconstrução do documento com outras identidades não tem garantia de correspondência.

O bridge só é emitido mediante pedido da prévia para um arquivo dentro do projeto autorizado, vinculado a esse arquivo e hash; não é injetado em páginas irmãs. A prévia segue em origem opaca e não ganha permissão de escrita. O app aceita apenas mensagens de seu iframe/canal, valida os dados e usa exclusivamente seu caminho/projeto/hash na rota de save existente. Divergência entre a versão lida e a exibida exige recarregar. A instrumentação da prévia não entra no arquivo salvo.

Verificado por `html-form.test.ts`, `html-preview.test.tsx`, `files-preview.test.ts` e ensaio real/minificado em `verify-html-visual.mjs`: preencher sem Editar, salvar/reabrir, campo dinâmico, documento independente, cancelamento, conflito e ausência de gravação automática.

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
