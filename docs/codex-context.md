# Contexto e compactação do Codex

O chat do Codex usa um processo `codex app-server` por sessão. A autenticação,
configuração, MCP Hermes e histórico continuam sendo os da CLI instalada.
Conversas anteriores de `codex exec` são retomadas por `thread/resume`; ao abrir
no terminal, o processo do App Server é encerrado antes de `codex resume`.

Mensagens enviadas durante o processamento entram pelo `turn/steer`, em ordem,
com o identificador do turno ativo. Durante o arranque ou uma compactação, ficam
pendentes até ser possível entregá-las. Se o Codex rejeitar o adendo porque o
turno já terminou, a mensagem inicia o turno seguinte. Uma confirmação tardia
não gera reenvio. Interromper ou encerrar cancela os envios ainda pendentes com
aviso no chat; desconexões e falhas de entrega também são visíveis.

Na aba Codex, o medidor usa `thread/tokenUsage/updated`: `last.totalTokens`
alimenta o numerador e `modelContextWindow` o denominador. É a última medição
reportada pelo agente, não uma contagem contínua de cada caractere digitado.
Sem janela informada, o medidor fica oculto; não assume os valores do Claude.
O consumo acumulado continua separado: a diferença de `total` entre turnos
alimenta o cartão de uso, sem recontar tokens de uma conversa retomada.

A janela exibida é a **janela ativa da sessão**, que pode ser menor que a
capacidade máxima publicada para o modelo na API. O tooltip do Codex explicita
essa diferença. A configuração nativa `model_context_window` é respeitada;
ampliar a janela exige configurar e validar o Codex, não trocar apenas o
denominador do medidor. A compactação percentual usa a mesma janela ativa.

Em ⚙ → Contexto, **Compactar agora** (ou `/compact` no chat) chama
`thread/compact/start`. Não envia essa string ao modelo. A operação exige uma
conversa já iniciada e um turno livre. `contextCompaction` liga o indicador com
relógio; conclusão, interrupção e falha o desligam. A fronteira aparece no chat
e no histórico recarregado. A medição pós-compactação pode chegar antes ou depois
do evento de conclusão; ambas as ordens são aceitas.

O limiar percentual do Claudinei é global para as engines com essa capacidade
(atualmente Claude e Codex). É verificado ao fim de cada turno normal, e só
rearma após a medição voltar abaixo do limiar, evitando compactações em ciclo.
Desligar esse limiar não desativa a compactação automática nativa do agente,
que também pode acontecer durante um turno longo. A opção nativa do Codex
`model_auto_compact_token_limit` continua sendo respeitada.

As capacidades são anunciadas por `/api/engines`; novas engines podem implementar
`EngineSession.compact()` e publicar eventos `context`. O gerenciador não envia
comandos de texto como substituto para uma operação nativa desconhecida.

Validação do protocolo: Codex CLI 0.153.4, conversa real → medição → compactação
manual → nova mensagem na mesma thread. Testes com App Server simulado cobrem
retomada, tokens acumulados, ordem das notificações, interrupção, falhas,
reconexão do navegador e limiar automático.

Referências: [App Server](https://learn.chatgpt.com/docs/app-server) e
[configuração do Codex](https://learn.chatgpt.com/docs/config-file/config-reference).
