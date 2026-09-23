# Preferências do usuário

## Reinício do serviço

- Sempre consultar o usuário e obter sua confirmação explícita antes de reiniciar o serviço do Claudinei.
- Podem existir sessões, tarefas ou processos em andamento. O usuário quer preservar esses fluxos e decidir o momento do reinício.
- Pedidos para implementar, atualizar, compilar, empacotar ou instalar alterações não autorizam automaticamente um reinício.
- Preparar e validar as alterações primeiro; então informar que estão prontas e pedir confirmação para reiniciar. Sem resposta, manter o serviço em execução.
- A mesma regra vale para reinícios agendados ou disparados por scripts, timers e tarefas independentes. Não agendar um reinício sem a confirmação do usuário.
- Uma autorização anterior não vale para reinícios futuros.

## Aparência dos indicadores

- O frontend precisa ter desempenho aceitável **sem aceleração por GPU**. A correção vale no produto; ativar a GPU na máquina do usuário não é solução aceita.
- Preservar o desenho e os movimentos dos rostinhos e das bolinhas dos terminais. Trocá-los por poses estáticas ou pulsos discretos foi rejeitado — otimizar mantendo a animação é o caminho.
- Configuração atual dos indicadores, a preservar ao mexer neles: amostragem nativa em ~20 quadros/s, pausa fora da tela e sem `backdrop-filter` na lateral inteira.
- Os rostinhos pesavam de fato no consumo, mas removê-los não resolveu tudo: a conversa ativa continua cara, inclusive depois de compactar, enquanto um terminal ocioso deixa o navegador leve.
- O Chrome do usuário roda Compositing e Rasterization por software, com a GPU desativada depois de quedas sucessivas. Não atribuir essas quedas ao Claudinei nem mexer em drivers do servidor por causa da máquina dele; ensaio em Chrome com renderização por software não prova, sozinho, a causa da lentidão.
