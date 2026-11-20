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
9. Pedido do usuário em 2026-11-02: cada arquivo tem um ⋯ no fim da linha (pastas não têm). Ele, o clique direito no arquivo e a tecla de menu (ou Shift+F10) abrem o mesmo menu do link de arquivo do chat, com **Referenciar na mensagem** em primeiro e depois Abrir em popup, Ver inline no chat, Copiar caminho, Copiar caminho completo e Revelar na pasta (este só em acesso local). Clicar no arquivo continua referenciando direto. Referenciar pelo menu é igual ao clique. As outras ações tiram o `@!` do rascunho e fecham o seletor, porque nada foi referenciado; o restante do texto fica como estava. O ⋯ fica fora do percurso das setas da lista. Pelo teclado o menu abre com o foco no primeiro item, e setas, Home/End e Enter/Espaço navegam e escolhem. Esc ou clique fora fecham só o menu e deixam o seletor aberto, com o foco de volta no arquivo. Se o seletor fechar com o menu aberto, o menu fecha junto.

Busca, pasta e paginação são transitórias, locais ao popup; não vão para a URL nem são compartilhadas entre terminais. Essa é uma exceção intencional à persistência de filtros de páginas de dados. Fechar preserva o rascunho, inclusive o gatilho ainda não substituído.

## Favoritos dos terminais

Pedido do usuário em 2026-09-29: a estrela no cartão marca/desmarca o terminal como favorito, inclusive quando o cartão está compacto. A marca fica no banco junto ao terminal e aparece para os usuários que podem acessá-lo, também em outros dispositivos. Qualquer usuário com acesso ao terminal pode mudar essa marca; o filtro de favoritos é apenas uma preferência de visualização deste navegador, persistida no localStorage.

O switch com estrela mostra somente terminais favoritos. Pode ser combinado com “Somente ativos”; nesse caso, só aparecem favoritos com agente ativo. Setores e grupos sem filhos visíveis desaparecem, e os contadores exibem visíveis/total. Os dados completos continuam sendo a fonte da ordenação; o arraste fica indisponível enquanto um filtro está ligado. Remover a estrela no modo filtrado retira o cartão da lista. Falha na gravação restaura o estado anterior e mostra uma mensagem. Sem resultados, a lista explica se faltam ativos, favoritos ou terminais que atendam aos dois filtros.

Substituído em 2026-11-20 pela [Triagem da lista](#triagem-da-lista): a estrela passa a fixar ou desafixar só para quem clicou, e o switch vira “Somente fixados”.

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

## Atalho Ctrl+Espaço no microfone

Pedido do usuário em 2026-10-08, no modo híbrido que ele escolheu: com um chat aberto, **Ctrl+Espaço** aciona o 🎤 daquele chat. Um toque rápido (soltar em menos de 0,4 s) começa a gravar e a gravação segue até o próximo Ctrl+Espaço, que para e transcreve. Segurar por 0,4 s ou mais grava só enquanto as teclas estão apertadas: soltar o Ctrl ou o Espaço para e transcreve, e sair da janela segurando conta como soltar, porque o navegador não avisa a soltura fora dela. O atalho também para uma gravação começada pelo clique.

Funciona com o foco no campo do chat ou fora de qualquer campo, e leva o foco ao campo do chat; o texto entra onde estava o cursor, como pelo botão. O espaço não é digitado e a página não rola; a repetição do teclado com as teclas apertadas não reinicia nem para. Com o foco em outro campo (busca da lateral, um modal, o terminal), o atalho é desse campo e nada grava. Com a sessão parada ou encerrada o 🎤 fica desabilitado e o atalho também. Se as teclas forem soltas antes de o microfone terminar de abrir, a abertura é cancelada e o microfone é liberado assim que abre, sem começar a gravar sozinho. A dica do 🎤 ensina o atalho nos três idiomas.

Verificação em 2026-10-10: `web/src/test/mic-shortcut.test.tsx` (12 casos), mais os testes do botão e do microfone no ChatInput, com a suíte completa aprovada (1257 no frontend); sabotagens no cancelamento da abertura e na proteção de outro campo foram pegas. Ensaio em Chromium com microfone simulado e teclas reais numa instância isolada: o toque gravou e levou o foco ao chat, o segundo toque transcreveu, segurar 1,2 s gravou e soltar transcreveu, e na busca da lateral nada gravou.

## Ctrl+Enter envia de qualquer ponto da tela

Pedido do usuário em 2026-10-10: com um chat aberto, **Ctrl+Enter** envia a mensagem do campo como o Enter, sem precisar pôr o foco nele — por exemplo, logo depois de clicar no 🎤. Faz o mesmo que o Enter: envia o texto, roda `!comando`, respeita os anexos e não faz nada com o campo vazio. Dentro do próprio campo continua como antes (qualquer Enter sem Shift envia) e sai uma vez só. Com o foco em outro campo de digitação (busca da lateral, modal, editor de arquivo, terminal), o atalho é desse campo. A dica do botão Enviar ensina o atalho nos três idiomas.

Enviar durante o ditado espera a transcrição. Enquanto o 🎤 grava ou transcreve, o texto final ainda não está no campo: mandar na hora levaria só o parcial, e o final cairia depois no campo vazio, repetindo o que foi dito — defeito que o Enter no campo já tinha. Agora o Ctrl+Enter, o Enter no campo e o botão Enviar encerram a gravação e a mensagem sai quando a transcrição final chega, inteira e uma vez só. Se a transcrição falhar, nada é enviado: o erro aparece e o texto fica no campo.

Verificação em 2026-10-10: `web/src/test/chat-ctrl-enter.test.tsx` (9 casos) e a suíte completa (1277 no frontend); sabotagens na espera pelo ditado e na guarda do próprio campo (que enviaria duas vezes) foram pegas. Ensaio em Chromium com microfone simulado e teclas reais numa instância isolada: Ctrl+Enter com o foco na página enviou; gravando com o foco no 🎤, encerrou, esperou a transcrição e enviou o texto final, e o campo ficou vazio; com o foco na busca da lateral, nada saiu.

## Editor de agendamentos

Ao criar ou editar, `ScheduleEditor` monta `.modal-overlay` diretamente em `document.body`. A lista e os cartões têm rolagem/recorte próprios; o diálogo fora dessa árvore ocupa a viewport e mantém título e Salvar/Cancelar acessíveis. Em altura reduzida, apenas o corpo do formulário rola. O diálogo expõe nome acessível e estado modal. Fechar ou salvar mantém os fluxos existentes de `SchedulesView`.

## Modelos do Codex

O Claudinei consulta `model/list` da CLI para mostrar somente os modelos liberados à conta, com os nomes, esforços e padrão informados por ela. Ao iniciar ou alterar uma sessão, o valor enviado continua sendo o ID do modelo. Se a consulta falhar, o catálogo de reserva oferece GPT-6.1 Sol como padrão, seguido pelos modelos anteriores ainda presentes no catálogo da CLI em 2026-09-29; uma consulta posterior bem-sucedida substitui essa reserva.

## Avisos "You should know" acima do campo

Pedido do usuário em 2026-11-13: os avisos do plugin embutido "You should know" do Claude CLI (etiquetas **Heads up** e **You should know**), que o terminal interativo mostra acima do campo de digitação, aparecem no chat do Claudinei no mesmo lugar, destacados, com um **X** para fechar; vários ficam empilhados um embaixo do outro.

Como chegam: o servidor anexa cada terminal do Claude como a superfície `desktop` do plugin (o mesmo protocolo do app Desktop, marcado `@internal` no CLI 2.1.323): `ui_attach`; um `ui_render` do `AbovePrompt` (instância `above-prompt`) ao anexar e a cada `system/ui_invalidate`; `ui_press` nos cliques. A árvore que volta (Box, Text, Button, Markdown, Link, Code…) é desenhada como está, sem os nós do motor; os botões do plugin (Explique, Já sabia, Agora não, Entendi…) voltam a ele. O X aciona o botão de dispensar do próprio plugin (`role: "dismiss"`). Links só abrem se forem http/https, pela confirmação de link externo. Quem abre a tela depois recebe o aviso no snapshot.

Pilha: o plugin mantém um aviso por sessão; o mesmo assunto mudando de estado (oferta → explicando → explicado) atualiza o cartão no lugar. Um assunto novo empilha embaixo, perto do campo, e o anterior fica apagado, só para ler (botões desabilitados), até o X dele, que só fecha na tela. Até 4 cartões. Um cartão fechado no X não volta pelo snapshot.

Custo e interruptor: com a superfície anexada, o plugin passa a fazer o que faz no terminal interativo, com um agente paralelo que lê a conversa durante tarefas longas, consumindo tokens do plano. Em turnos curtos, o ensaio de 2026-11-13 não mostrou chamada extra. Cada terminal tem o interruptor **Avisos "You should know"** nos controles da sessão (só Claude), ligado por padrão e gravado no terminal (`projects.heads_up`); desligar solta a superfície na hora e tira o aviso da tela. Se uma versão nova do CLI mudar o protocolo, os avisos param de aparecer sem afetar o resto da sessão.

## Uso do Claude sem sumir

Pedido do usuário em 2026-11-02: a seção do Claude no cartão de Uso sumia com frequência. A causa era o 429 do endpoint de uso da Anthropic, cujo limite de consultas é da conta e dividido com os próprios terminais do Claude CLI; o Claudinei consultava a cada minuto e, a cada falha, apagava os números.

Agora a fonte principal é o `rate_limit_event` que todo terminal do Claude recebe no stream-json a cada turno (utilização e reset das janelas de 5 h e semanal): zero consultas. O endpoint, que traz as linhas por modelo, vai no máximo a cada 10 minutos e, depois de um 429, espera 2, 4, 8… até 30 minutos (ou o `retry-after`, se maior). Janela por janela, o dado mais novo das duas fontes vence. O último valor bom fica no servidor e em disco (`claude-usage.json`, ao lado do banco), então nem uma falha nem um reinício apagam a seção; só some uma janela que já virou. Quando o número do Claude tem mais de 15 minutos, o grupo mostra "atualizado às HH:MM".

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

## Acompanhamento de tarefas longas

- Obrigatório em todo pedido que muda arquivos ou tem três etapas ou mais: o agente publica o andamento pela ferramenta `update_progress` do Hermes antes de começar, a cada etapa concluída, ao travar ou precisar do operador, e no fim. Só perguntas, explicações e um comando rápido ficam de fora.
- A regra vai nas instruções do Hermes (todos os motores; no Codex, como instruções da conversa) e, no Claude, também no prompt de sistema. O Claude congela o prompt de sistema de cada conversa: conversas abertas antes da instalação recebem a regra só pelo Hermes e pela descrição da ferramenta, até um `/compact` ou uma conversa nova.
- Um acompanhamento por terminal (projeto + motor); o mais recente vence — rotina agendada e tarefa encaminhada também atualizam. O agente carrega para o estado novo o que ainda espera o operador.
- O botão "Acompanhamento" no cabeçalho do chat abre e fecha a coluna à direita (lembrada entre visitas); a bolinha nele aparece com tarefa em andamento e o terminal rodando.
- A coluna empurra o chat (não o cobre) e, no celular, ocupa a tela. Mostra título com "N de M" e barra, **Agora**, **Tarefas** com estado e nota, **Esperando você** (só quando há itens), e o rodapé com "atualizado há X", o caminho do arquivo (copiável) e "Descartar" (com confirmação).
- Terminal parado, morto ou levado ao terminal interativo com tarefa em andamento: aviso de que o andamento pode estar desatualizado, e as bolinhas param. Terminal ocioso não gera aviso. O rodapé fica âmbar após 45 min sem atualização com tarefa não concluída.
- O arquivo fica em `~/.claudinei/acompanhamento/<projeto>-<motor>.json`.

## Reinício sem prejuízo

- Dois interruptores por terminal (projeto + motor da aba) no ⚙ do campo, em todos os motores, logo abaixo de "Avisos 'You should know'": **Iniciar com o Claudinei** (a sessão sobe parada na última conversa, sem mandar nada) e **Retomar trabalho interrompido** (o turno cortado pelo reinício continua sozinho). Os dois começam desligados, e cada um tem dica ao passar o mouse.
- Turno interrompido que não foi retomado sozinho mostra um aviso âmbar logo acima do campo, com **Continuar** e um × de fechar: "O trabalho foi interrompido pelo reinício do Claudinei." (retomar desligado); o mesmo texto e a lista da pergunta que se perdeu (havia pergunta aberta); "Retomado 3 vezes sem concluir; esperando você." (teto); "Não foi possível retomar sozinho." (a retomada automática falhou).
- Na fila para retomar sozinho, o aviso diz "Retomando o trabalho interrompido…", no tom de destaque e sem botões.
- **Continuar** revive a sessão, se preciso, e manda a mensagem de retomada; se a chamada falha, o erro aparece no próprio aviso, que fica. O × tira o aviso sem retomar. Mandar qualquer mensagem também o tira. O aviso some quando o servidor manda o estado sem interrupção.
- A mensagem de retomada vai ao agente em inglês e aparece no chat como cartão com o selo "Claudinei", no idioma da tela, e não como mensagem do operador (sem lápis de editar).
- O aviso é estático, sem animação: a interface precisa andar sem GPU.

## Triagem da lista

Pedido do operador em 2026-11-20 (spec `docs/superpowers/specs/2026-11-20-triagem-da-lista-design.md`): separar na lateral o que precisa dele do que já foi tratado. A triagem é de cada usuário: a ação de um não muda a lista de outro, nem a do admin.

- **Seções**, de cima para baixo: faixa **Trabalhando**, **Fixados**, a árvore de setores e grupos (sem os fixados, assentados e adiados), **Adiados** e **Assentados**. Adiados e Assentados começam recolhidos; a escolha de cada seção fica no localStorage. Cada cartão adiado mostra “volta às 9:00”. Nos Fixados vale a ordem global da lateral; o arraste continua só nos setores e grupos. Filtros e busca valem para todas as seções, e a busca abre a seção onde achou.
- **Faixa Trabalhando**: os terminais com sessão `working`, compactando ou no terminal interativo processando, inclusive os assentados (que não acordam por trabalhar). Adiados não entram. Cada linha mostra ícone, nome, motor e estado, sem rostinho; o clique abre o chat. Some quando vazia e pode ser recolhida (localStorage). No trilho, Fixados no topo e a faixa como ícones; Assentados e Adiados não aparecem.
- **Ações**: a ⭐ do cartão fixa e desafixa. As três bolinhas do cartão e do título do chat têm **Fixar**/**Desafixar**, **Assentar**/**Tirar dos assentados** e **Adiar ▸**, que abre no próprio menu: **1 h**, **Até amanhã às 9:00**, **Até segunda às 9:00** e, só para quem está adiado, **Cancelar o adiamento**. Os horários são calculados no fuso do navegador e vão ao servidor como horário absoluto; “amanhã” pedido entre 0 h e 5 h é o mesmo dia às 9:00.
- **Combinações**: assentar tira o pin e o adiamento; adiar tira o assentado e mantém o pin (o cartão sai dos Fixados até voltar); fixar tira o assentado. O cartão muda de seção na hora, e a resposta do servidor vale.
- **O que acorda** um assentado ou adiado (decisão do operador): só pergunta aberta, falha do turno (resultado com erro que não seja interrupção pedida pelo operador, ou sessão `dead`), aviso de trabalho interrompido do reinício com motivo diferente de `queued` (só quando o aviso nasce retido: um aviso que segue aberto não acorda de novo a cada reinício) ou, quando o projeto 6 do roteiro (“Bateu o limite”) ligar esse aviso ao despertador, aviso de limite de uso — por enquanto nada o chama. Turno que só terminou, `working`, agendamento e tarefa encaminhada não acordam. O despertar vale para todos os usuários com acesso ao terminal. Um adiamento vencido volta sozinho, com a página aberta, sem recarregar.
- **Marcar como lido**: assentar ou adiar zera o contador de não lidas de todas as sessões do terminal e manda `mark_read` para cada sessão viva (parada e morta ficam de fora). Fixar não marca.
- **Desfazer**: cada ação (⭐ ou menu) mostra por 5 s um aviso no canto de baixo à esquerda (no celular, acima da caixa de mensagem do chat), como “Alpha assentado · **Desfazer**”. O botão e o `Ctrl+Z` (`Cmd+Z` no Mac) devolvem os três campos de antes — desfazer um assentar devolve o pin. Com o foco num campo (o chat, a busca, a textarea do terminal) ou em qualquer ponto de um modal aberto, inclusive num botão, o `Ctrl+Z` não desfaz a triagem. Se o terminal mudou desde a ação (o servidor o acordou), **Desfazer** só fecha o aviso, sem esconder de novo quem precisa do operador. Uma ação nova substitui a entrada anterior, e uma ação ignorada (o mesmo terminal com pedido a caminho) não mexe no aviso; o desfazer não se desfaz; passados os 5 s, o atalho volta a ser do navegador. No celular, o botão é a porta.
- **Falha**: se a rota recusa, o cartão volta ao estado de antes, nada fica para desfazer e o mesmo canto do desfazer mostra “Não foi possível mudar a triagem do terminal.” (na ⭐, “Não foi possível fixar ou desafixar o terminal.”), com um × para fechar. O aviso aparece também com a lateral em trilho e no celular com a gaveta fechada, e some no ×, na próxima ação ou em 5 s, para não aparecer velho depois. Se o servidor mandou pelo WebSocket um estado novo do terminal enquanto o pedido estava a caminho (um despertar), a falha não o desfaz.
- O aviso de desfazer e as seções são estáticos, sem animação: a interface precisa andar sem GPU. Mudar o status de uma sessão não remonta cartões; só a ação do operador, ou um assentado que acorda, muda o cartão de seção.

Verificação: `web/src/test/triage-actions.test.tsx` (menu, horário absoluto, marcar como lido, desfazer pelo botão e pelo atalho, foco em campo e em modal, falha da rota no trilho, despertar durante o desfazer e durante o pedido, ação ignorada), `web/src/test/sidebar-triage.test.tsx`, `web/src/test/sidebar-favorites.test.tsx` e, no servidor, `server/test/triage-store.test.ts`, `server/test/triage-routes.test.ts` e `server/test/triage-wake.test.ts`.
