# Acesso por dias e horários

Em **Gestão de usuários**, crie ou edite uma conta e ative **Acesso limitado**.
Escolha o fuso, os dias da semana e uma ou mais janelas. As permissões de terminais
continuam sendo configuradas separadamente: estar dentro do horário não concede
acesso a terminais adicionais nem privilégios de administrador.

- Cada janela tem seus próprios dias. Por exemplo: segunda a sexta, 09:00–12:00,
  e outra janela nos mesmos dias, 13:00–18:00.
- **Todos os dias** seleciona os sete dias; **Dia inteiro** permite as 24 horas
  dos dias selecionados.
- Uma janela 22:00–02:00 termina no dia seguinte. Os dias selecionados são os
  dias de início: sexta-feira 22:00 inclui sábado até 02:00.
- Basta estar dentro de uma das janelas. Sobreposições são permitidas.
- O início é inclusivo e o fim é exclusivo: 09:00–18:00 bloqueia às 18:00.
- O padrão do editor é `America/Sao_Paulo`, alterável por usuário. O relógio do
  servidor e o fuso escolhido determinam o acesso, independentemente do relógio
  ou fuso do navegador. Mudanças de horário de verão seguem a base de fusos do
  runtime: horários locais repetidos correspondem às duas ocorrências; horários
  locais que não existem naquele dia não criam acesso extra.
- Desativar **Acesso limitado** remove a restrição. Contas existentes e novas
  contas sem essa opção mantêm acesso sem restrição de horário.
- A restrição também se aplica a contas administradoras que a tenham configurada.

## Durante o bloqueio

O usuário pode autenticar-se, consultar seus horários e sair da conta. A interface
mostra uma tela de acesso bloqueado e desmonta chat, terminais, actions e criação
de terminais. O acesso retorna automaticamente após confirmação do servidor dentro
de uma janela permitida. Há também um botão para verificar novamente.

O bloqueio é imposto no servidor: todas as rotas HTTP protegidas recusam acesso,
inclusive via token e chamadas diretas. A permissão é verificada ao receber a
requisição e novamente antes do handler, após a leitura do corpo. Os WebSockets
de chat, terminal e action verificam a permissão em cada entrada e saída; conexões
silenciosas são fechadas em até aproximadamente um segundo. A interface verifica
o acesso no máximo a cada 30 segundos, junto à próxima mudança de minuto para
contas restritas, ao retornar à aba e ao receber uma recusa do servidor.

As tarefas já aceitas e processos em execução continuam no servidor. O fim da
janela desconecta os clientes, sem enviar interrupt ou matar processos. Comandos
pendentes no navegador são descartados, e janelas antigas de actions não são
relançadas automaticamente no desbloqueio. As actions ainda em execução podem ser
reencontradas pela interface de ações em andamento. Automações agendadas e o token
interno de serviço continuam seguindo suas permissões existentes; não representam
o acesso interativo de uma conta humana.

## API e persistência

`POST /api/auth/users` e `PATCH /api/auth/users/:id` aceitam `accessHours`:

```json
{
  "accessHours": {
    "timeZone": "America/Sao_Paulo",
    "windows": [
      { "days": [1, 2, 3, 4, 5], "start": "09:00", "end": "12:00" },
      { "days": [1, 2, 3, 4, 5], "start": "13:00", "end": "18:00" }
    ]
  }
}
```

Os dias vão de 0 (domingo) a 6 (sábado). A lista aceita de 1 a 64 janelas, cada uma
com ao menos um dia e horários diferentes no formato `HH:mm`. `24:00` é aceito
somente no fim; `00:00`–`24:00` representa um dia inteiro. `accessHours: null`
remove a política; omitir o campo em um PATCH preserva a política existente.
Configuração inválida retorna 400 sem aplicar parcialmente a alteração do usuário.

Login e `GET /api/auth/me` incluem `accessHours` e
`access: { allowed, serverNow, checkAt }`, com instantes em milissegundos UTC.
Uma rota protegida fora da janela retorna
`403 { "error": "access_hours_restricted" }`.
WebSockets abertos são fechados com código 1008 e motivo `access_hours`.

Uma migração aditiva e idempotente cria `users.access_hours` (TEXT anulável).
Valores nulos preservam o comportamento anterior. A política é lida nas
verificações de acesso, de modo que alterações não exigem um novo login.

## Validação

Testes cobrem limites de minuto, dias, janelas sobrepostas, virada de semana,
fusos e horário de verão; migração e persistência; rollback de alterações
inválidas; chamadas HTTP e WebSockets reais com PTY simulado; sessões já abertas;
edição e remoção pela interface; bloqueio com falha de rede; descarte de envios
pendentes; e desbloqueio somente após autorização do servidor.
