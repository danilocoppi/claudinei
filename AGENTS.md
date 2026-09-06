# Preferências do usuário

## Reinício do serviço

- Sempre consultar o usuário e obter sua confirmação explícita antes de reiniciar o serviço do Claudinei.
- Podem existir sessões, tarefas ou processos em andamento. O usuário quer preservar esses fluxos e decidir o momento do reinício.
- Pedidos para implementar, atualizar, compilar, empacotar ou instalar alterações não autorizam automaticamente um reinício.
- Preparar e validar as alterações primeiro; então informar que estão prontas e pedir confirmação para reiniciar. Sem resposta, manter o serviço em execução.
- A mesma regra vale para reinícios agendados ou disparados por scripts, timers e tarefas independentes. Não agendar um reinício sem a confirmação do usuário.
- Uma autorização anterior não vale para reinícios futuros.

Preferência registrada por solicitação explícita do usuário em 2026-09-06.

## Aparência dos indicadores

- Requisito explícito do usuário em 2026-09-06: o frontend deve ter desempenho aceitável sem aceleração por GPU. A correção precisa funcionar no produto; ativar a GPU no computador dele não é a solução aceita.
- Preservar as animações originais dos rostinhos e bolinhas dos terminais. O usuário rejeitou a substituição por poses estáticas e pulsos discretos em 2026-09-06.
- Exceção temporária autorizada depois, no mesmo dia: ocultar somente os rostinhos antes dos ícones dos terminais na lateral para comparar o uso de CPU. Manter todas as demais animações e o vidro durante esse teste.
- Resultado confirmado pelo usuário durante a retirada temporária: "Realmente eram os rostinhos!". Essa regressão deve ser considerada ao alterar os indicadores.
- Pedido posterior em 2026-09-06: "Quero voltar os rostinhos, mas precisamos fazer uma optimizacao". Está autorizada a restauração com otimização e validação de consumo sem GPU; isso substitui a orientação temporária de mantê-los ocultos. Preservar o desenho e os movimentos. Esse pedido não autoriza outro reinício.
- Estado atual: rostinhos restaurados no pacote `144f901f`, com amostragem nativa em cerca de 20 quadros/s, pausa fora da tela e sem backdrop-filter na lateral inteira. Instalação e reinício autorizados com "Agora pode"; essa autorização já foi consumida. Depois da instalação, o usuário confirmou: "pronto agora esta tudo certo!". Preservar essa configuração; consultar novamente antes de qualquer próximo reinício.
- Observação posterior: ainda há consumo alto na conversa ativa, inclusive depois da compactação; abrir outro terminal idle deixa o navegador leve. Os rostinhos contribuíam para o problema, mas sua remoção não resolveu todo o consumo.
- Os ensaios de desempenho em Chrome com renderização por software não confirmam, por si, a causa da lentidão no computador do usuário.
- O relatório chrome://gpu enviado em 2026-09-06 confirmou Compositing e Rasterization por software no Chrome 151 do usuário, com acesso à GPU desativado após quatro quedas. A causa dessas quedas e o estado após reabrir o navegador ainda precisam ser verificados; não atribuir automaticamente as quedas ao Claudinei nem alterar drivers do servidor para tratar o computador do usuário.
