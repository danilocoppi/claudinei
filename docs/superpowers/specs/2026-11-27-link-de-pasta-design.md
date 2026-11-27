# Pastas citadas na conversa viram link

## Por quê

O agente cita pastas o tempo todo (por exemplo, "pasta `docs/hoanglong/`"), e hoje
isso é texto morto. Arquivos já viram link com um menu de ações. O Danilo quer o
mesmo para pastas: clicar e ter **Copiar caminho**, **Copiar caminho completo** e
**Mostrar na pasta**, que abre a própria pasta no gerenciador de arquivos.

## Como funciona hoje

- `web/src/files.ts` acha candidatos a caminho no texto com duas regexes, e as duas
  exigem extensão no fim (`.md`, `.docx`…). `docs/hoanglong/` não casa.
- O servidor (`POST /api/files/resolve` → `resolveInScope`) só confirma arquivos:
  um diretório volta `inScope: false`, e o front só linka o que foi confirmado.
- O menu (`FileOpenMenu`) tem popup, inline, copiar caminho, copiar caminho
  completo e "Abrir na pasta". Este último aparece só em acesso local e abre a
  pasta *onde o arquivo está* (`dirname`).

## Decisões

- **O que conta como pasta (escolha do Danilo: opção b).** Valem os caminhos que
  terminam em `/` e também os sem extensão: relativos com pelo menos uma `/`
  (`src/components`), absolutos (`/home/…`) e `~/…`. O servidor confere cada um,
  e só vira link o que existe e está no escopo. Expressões como "input/output" ou
  "27/11/2026" geram consulta, mas nunca link.
- **Menu de pasta:** só Copiar caminho, Copiar caminho completo e a ação de abrir.
  A ação de abrir segue a regra atual: só em acesso local, porque abre na máquina
  do servidor.
- **A ação de abrir abre a própria pasta**, não a de cima.

## Abordagens

1. **Estender o caminho dos arquivos (escolhida).** As mesmas regexes ganham as
   formas sem extensão, o resolve passa a responder `kind: 'folder'` para
   diretórios, e o mesmo menu ganha um modo pasta. Pastas herdam de graça o que
   os arquivos já têm: cache de resolução, regras de escopo, a confirmação antes
   de linkar e o menu acessível por teclado.
2. **Um detector e um menu só para pastas.** Duplicaria a resolução, o cache e as
   regras de escopo, que são a parte sensível. Descartada.
3. **Linkar no front sem perguntar ao servidor (pela `/` no fim).** Criaria links
   quebrados e não cobre a opção (b). Descartada.

## Desenho

- **Servidor (`server/src/files/scope.ts` e `routes/files.ts`).**
  - `resolveInScope` ganha a opção `{ allowDir: true }`. Com ela, um diretório
    passa pela mesma regra de escopo dos arquivos (admin vê tudo; não-admin, só
    sob a raiz real do projeto, e fora dela responde "não existe") e volta
    `kind: 'folder'`, sem `size`.
  - Sem a opção, nada muda. As rotas que leem conteúdo (content, raw, preview…)
    continuam recusando diretórios.
  - Só `/api/files/resolve` e `/api/files/reveal` passam a opção. O reveal abre
    `real` quando é pasta e `dirname(real)` quando é arquivo.
- **Tipos.** `FileKind` ganha `'folder'` no servidor e no web.
- **Front.**
  - `files.ts`: as regexes aceitam o caminho sem extensão e a `/` final opcional.
    Os casos com extensão continuam casando exatamente como hoje.
  - `MessageBlock`: o link de um caminho confirmado como `folder` abre o menu em
    modo pasta.
  - `FileOpenMenu`: com `kind === 'folder'`, mostra só Copiar caminho, Copiar
    caminho completo e a ação de abrir, com o rótulo "Abrir a pasta" / "Open
    folder" / "Abrir la carpeta".
- **Testes.**
  - Regexes: casos novos de pasta, e os de arquivo sem mudança.
  - `resolveInScope` com e sem `allowDir`, inclusive pasta fora do escopo para
    não-admin.
  - Rotas resolve e reveal (pasta abre ela mesma; content de pasta continua
    recusado).
  - O menu em modo pasta.
  - Conferência no navegador numa instância de teste.

## Fora do escopo

- Navegar pelo conteúdo da pasta dentro do Claudinei.
- Mudar o seletor do `@!`.

## Decisões minhas, a conferir

- O rótulo "Abrir a pasta", em vez de "Abrir na pasta": para uma pasta, abrir ela
  mesma é o que o nome diz.
- Um caminho cujo último segmento tem ponto e é um diretório (por exemplo,
  `~/.claude` ou `node_modules/foo.js/`) já é candidato hoje. Ele passa a virar
  link de pasta quando o servidor disser que é diretório.
