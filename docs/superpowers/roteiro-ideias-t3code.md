# Roteiro: ideias trazidas do T3 Code

Combinado com o Danilo em 20/11/2026, a partir do estudo
`/home/coppi/Projects/61-Claudinei/estudos/2026-11-19-t3code-comparativo.md`
(T3 Code, https://github.com/pingdotgg/t3code, commit `80cf4f79`).

Cada linha é um projeto próprio: desenho, plano, implementação, revisão e
aprovação do Danilo para integrar, instalar e reiniciar. A ordem foi aprovada.

| # | Projeto | O que entra | Tamanho | Estado |
|---|---|---|---|---|
| 1 | Reinício sem prejuízo | Retomar sozinho o trabalho interrompido; marcar quais terminais iniciam sozinhos com o Claudinei | médio | entregue |
| 2 | Motores por terminal | Escolher quais agentes aparecem no cabeçalho de cada terminal | pequeno | entregue |
| 3 | Conversa virtualizada | Só as mensagens perto da tela existem na página | médio | entregue |
| 4 | Triagem da lista | Fixar, assentar, adiar, seção "Trabalhando", desfazer com Ctrl+Z | médio | entregue |
| 5 | Fila editável | Editar, reordenar, "enviar agora"; esperar a vez ou intervir no turno | médio | entregue |
| 6 | Bateu o limite | Continuar quando a janela reabrir ("Resume at reset"), adiar até lá ("Snooze until reset") | pequeno (usa o 1) | entregue |
| 7 | Achar na conversa | Busca dentro das mensagens; Ctrl+F que alcança o histórico inteiro | médio | entregue |
| 8 | Pequenos do campo e da conversa | Modo Zen; guardar prompt (Ctrl+S); colar texto grande vira anexo | pequeno | entregue |
| 9 | Desfazer o que o agente fez | Ponto de restauração por turno, diff do turno, editar a partir daqui | grande | — |
| 10 | Delegar e ser acordado | Quem delega é acordado quando a tarefa termina | médio | entregue |
| 11 | Ramificar a conversa | Conversa lateral `/side`/`/btw`, fork, trocar de motor levando o contexto | grande | — |
| 12 | Goals | `/goal`: o agente segue até cumprir o critério de pronto | médio | entregue |
| 13 | Página de uso | Tokens, economia com cache, custo estimado, por modelo e período | médio | entregue |
| 14 | Atalhos configuráveis | Atalhos editáveis, com detecção de conflito | médio | — |
| 15 | Respostas visuais | O agente responde com página HTML em sandbox (e MCP Apps) | médio | — |
| 16 | Navegador embutido | O agente navega e o operador vê, anota e manda o recorte ao chat; servidores locais com Parar | grande | — |
| 17 | Simuladores | Emulador ao vivo no painel | grande | — |

## Limites já conhecidos

- **Simuladores (17):** o simulador de iOS só existe no macOS; nesta máquina (Linux) só o emulador Android. Transmitir o vídeo a um Chrome sem GPU pesa.
- **Desfazer (9):** no T3, reverter arquivos só vale em worktree isolado. No Claudinei vários terminais podem trabalhar na mesma pasta, e reverter pode apagar o trabalho de outro agente.
- **Retomar sozinho (1):** continuar um turno gasta tokens, então cada terminal terá um interruptor. Nada disso muda a regra do AGENTS.md: reiniciar o serviço continua exigindo autorização expressa.
