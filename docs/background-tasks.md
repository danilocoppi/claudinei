# Tarefas em background no Claude Code

`background_tasks_changed` informa a lista completa de tarefas vivas. A lista
inclui agentes e processos de shell. No Claude Code 2.1.261 instalado, os
campos nativos são `task_id`, `task_type`, `description` e `ambient` opcional;
`task_started` também informa especialidade e prompt do agente. O servidor
preserva o tipo em `BackgroundTask.taskType`, separado de `type` (especialidade).

O `result` fecha o turno principal. Tarefas `local_bash` e tarefas `ambient`
não mantêm a sessão em `working`: um servidor Hardhat ou DynamoDB pode continuar
ligado indefinidamente sem representar trabalho pendente do agente. Elas não
são interrompidas quando a resposta termina. Processos de shell aparecem numa
lista recolhível de tarefas em background, com parada individual, sem contador
de subagentes ou indicador de geração de resposta.

Subagentes reais continuam mantendo o terminal ativo. Quando o último trabalho
termina, a sessão sai de `working` mesmo se não chegar outro `result`. Um novo
`turn_starting`, conteúdo do agente principal ou envio do operador reabre o
trabalho. Esvaziar a lista enquanto o turno principal continua ativo não o
encerra. `task_notification` e `task_updated` também removem tarefas concluídas,
falhadas ou interrompidas.

Snapshots de versões antigas sem `task_type` conservam o comportamento anterior.
A origem nunca é inferida da descrição, do nome do comando ou de seu PID.

Regressões: `server/test/background-tasks.test.ts`,
`web/src/test/running-subagents.test.tsx` e
`web/src/test/chat-autoscroll.test.tsx` cobrem processos persistentes, agente e
shell simultâneos, conclusão sem segundo result e falha ao parar um processo.
