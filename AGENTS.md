# Preferências do usuário

## Reinício do serviço

- Sempre consultar o usuário e obter sua confirmação explícita antes de reiniciar o serviço do Claudinei.
- Podem existir sessões, tarefas ou processos em andamento. O usuário quer preservar esses fluxos e decidir o momento do reinício.
- Pedidos para implementar, atualizar, compilar, empacotar ou instalar alterações não autorizam automaticamente um reinício.
- Preparar e validar as alterações primeiro; então informar que estão prontas e pedir confirmação para reiniciar. Sem resposta, manter o serviço em execução.
- A mesma regra vale para reinícios agendados ou disparados por scripts, timers e tarefas independentes. Não agendar um reinício sem a confirmação do usuário.
- Uma autorização anterior não vale para reinícios futuros.

Preferência registrada por solicitação explícita do usuário em 2026-09-06.
