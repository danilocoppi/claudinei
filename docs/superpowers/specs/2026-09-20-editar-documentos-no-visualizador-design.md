# Editar documentos no visualizador

Data: 2026-09-20

## O problema

O visualizador de arquivos do Claudinei (`FileViewerModal` e `InlineFileView`) é
somente leitura. Quem abre um `.md` e vê uma frase errada não tem como corrigi-la
ali: precisa pedir a um agente ou abrir um editor fora do app. O servidor
acompanha essa limitação — em `server/src/routes/files.ts` não existe nenhuma
rota que escreva em disco.

O objetivo é um lápis no visualizador que torne o documento editável **sem
perder a visualização formatada**: o markdown continua bonito enquanto se digita,
e o fonte de `.html`/`.ts`/`.json` vira um editor de código de verdade.

## Decisões tomadas

Quatro escolhas fecharam o desenho antes da escrita deste documento:

1. **Markdown com live preview** (estilo Obsidian): o buffer continua sendo
   markdown, renderizado ao vivo; as marcas de sintaxe só aparecem na linha onde
   está o cursor. Descartado o WYSIWYG puro — a serialização de volta para `.md`
   é lossy, e aqui os arquivos também são escritos por agentes.
2. **`.html` só na aba Fonte**: a aba Página continua sendo visualização. Editar
   a página renderizada exigiria injetar script no iframe `sandbox` e atravessar
   o isolamento que hoje protege o cookie de sessão. Fica para uma segunda etapa.
3. **Escrita restrita à pasta do projeto**, inclusive para admin — mesmo que a
   leitura, para admin, alcance qualquer caminho absoluto do disco.
4. **Salvar explícito** (`Ctrl+S` e botão), com indicação de alterações pendentes
   e confirmação ao fechar sujo.

## Escopo

**Dentro:** editar e salvar arquivos de tipo `markdown`, `code` e `text` que já
existem, pelo modal e pelo painel inline; live preview para markdown; editor de
código com realce para o resto; detecção de alteração concorrente no disco.

**Fora:** editar na aba Página do HTML; criar, renomear ou apagar arquivos;
edição colaborativa simultânea (dois operadores no mesmo arquivo resolvem pelo
conflito, não por merge); histórico de versões.

## Servidor

### A rota

```
POST /api/files/write
body: { path: string, projectId: number, content: string, baseHash: string }
→ 200 { hash: string }        // hash do conteúdo gravado, para o próximo save
```

A resolução do caminho reusa `resolveInScope` (fonte única de verdade de
segurança), mas a escrita acrescenta uma condição que a leitura não tem: **o
realpath precisa estar sob a raiz real do projeto**. `isAdmin` não substitui essa
condição. Sem `projectId` a rota recusa — não existe escrita fora de projeto.

Como `resolveInScope` hoje devolve `inScope: true` para admin em caminho absoluto
qualquer, a checagem de raiz vira uma função própria em `server/src/files/scope.ts`
(ex.: `isUnderProjectRoot(real, project)`), usada pela rota de escrita. A rota de
leitura não muda de comportamento.

### Recusas

| Situação | Resposta |
|---|---|
| Sem `projectId`, ou caminho fora da raiz real do projeto | 403 `forbidden` |
| Arquivo não existe (a rota não cria) | 404 `not_found` |
| Tipo `image`, `pdf` ou `binary` | 415 `not_editable` |
| Conteúdo acima de 2 MB (mesmo teto da leitura) | 413 `too_large` |
| `baseHash` diferente do hash atual do arquivo | 409 `stale` |

O symlink é seguido pelo `realpath`: edita-se o arquivo apontado, e é o alvo que
precisa estar dentro do projeto — um link para fora é recusado.

### Gravação atômica

Escreve num temporário no mesmo diretório (`.<nome>.claudinei-tmp-<aleatório>`) e
faz `rename` por cima. Uma queda no meio nunca deixa o arquivo truncado, e o
leitor concorrente (um agente) vê o arquivo antigo ou o novo, nunca um pedaço. O
temporário nasce com o `mode` do arquivo original, preservado pelo rename; em
qualquer erro ele é removido.

A escrita é registrada no log do Fastify (quem, qual projeto, qual caminho,
quantos bytes).

## Integridade: o hash

`GET /api/files/content` passa a devolver `X-Content-Hash: <sha256 hex dos bytes
do arquivo>` nas respostas de texto. O front guarda esse valor ao carregar e o
reenvia como `baseHash` ao salvar; o servidor relê o arquivo, compara, e em caso
de divergência responde **409 sem escrever nada**.

O hash vem do servidor (bytes reais), não é calculado no cliente — assim um
arquivo com bytes que não são UTF-8 válido não produz um conflito eterno por
causa do `U+FFFD` que o `fetch().text()` insere.

A UI de 409 mostra "este arquivo mudou no disco desde que você abriu" com um botão
de recarregar; o texto editado continua na tela até o operador decidir.

### Fim de linha

Se o conteúdo carregado contém `\r\n`, o editor normaliza para `\n` (CodeMirror
sempre o faz) e a gravação reconverte para `\r\n`. Sem isso, salvar um arquivo
CRLF produziria um diff de arquivo inteiro.

## Front

### Onde o lápis mora

Não no cabeçalho do modal: o modal e o painel inline têm cabeçalhos próprios, e o
que os dois compartilham é o `FileBody`. A barra de ações do documento fica
**dentro do corpo**, no mesmo lugar onde já vivem as abas Página/Fonte do HTML.
Assim a funcionalidade aparece nos dois contextos sem duplicação.

O lápis só aparece quando o arquivo é textual (`markdown`, `code`, `text`) **e**
há `projectId`. Arquivo aberto por caminho absoluto fora de projeto continua só
leitura, coerente com a regra do servidor.

### Componentes

- `web/src/components/TextDocument.tsx` — envolve a barra de ações e o corpo;
  alterna entre visualizar (o render de hoje) e editar. Dono do estado do
  documento: texto, hash base, sujo/limpo, erro de gravação.
- `web/src/components/CodeEditor.tsx` — casca fina sobre o CodeMirror 6:
  recebe texto, linguagem e `onChange`, e devolve o editor montado.
- `web/src/editor/markdown-live.ts` — o plugin de live preview.

### O live preview

Não existe pronto para CodeMirror 6; é código nosso. Para ser testável sem
montar uma view, o miolo é uma **função pura** que recebe o texto e a linha do
cursor e devolve as decorações (faixas de posição + classe + "esconder"); o
plugin CM6 só traduz isso para `Decoration.set`. Os testes exercitam a função.

Cobertura da primeira versão: títulos, negrito, itálico, riscado, código inline,
blocos de código com realce, citação, listas e links (texto estilizado, URL
escondida fora da linha do cursor). Tabelas e imagens aparecem como texto cru —
não quebram, só não ficam bonitas ainda.

Para `code` e `text` é o mesmo CodeMirror sem o plugin, com a linguagem derivada
da extensão (o `langOfPath` de `web/src/files.ts` já faz esse mapeamento).

### Dependências novas

`@codemirror/state`, `@codemirror/view`, `@codemirror/commands`,
`@codemirror/language`, `@codemirror/lang-markdown`, `@codemirror/lang-html`,
`@codemirror/lang-javascript`. Ordem de 250–300 KB no bundle.

### Interação

`Ctrl+S` salva. O botão de salvar fica desabilitado quando não há alteração. Um
ponto ao lado do nome indica pendência. O `Escape` que hoje fecha o modal passa a
pedir confirmação quando há alteração não salva — o `FileViewerModal` consulta um
`fileEditDirty` no store, setado pelo editor. A confirmação reusa o
`ConfirmDialog` existente.

Depois de salvar um `.html`, a aba Página recarrega com uma prévia nova (novo
token), para mostrar o resultado.

Textos em `web/src/i18n/{pt-BR,en,es}.ts`.

## Testes

**Servidor** (TDD, vermelho antes):

- grava e o disco reflete exatamente o conteúdo enviado;
- recusa caminho fora da raiz do projeto **inclusive como admin**;
- recusa symlink cujo alvo está fora do projeto;
- recusa tipo binário, arquivo inexistente e conteúdo acima do teto;
- 409 quando o arquivo mudou no disco depois da leitura, sem tocar no arquivo;
- preserva o `mode` do arquivo original;
- arquivo CRLF continua CRLF depois de salvo;
- `GET /api/files/content` devolve `X-Content-Hash` coerente.

**Front:**

- o lápis aparece para markdown/código/texto com projeto, e não aparece para
  imagem, PDF, binário ou arquivo sem projeto;
- salvar chama a rota com o `baseHash` recebido no carregamento;
- `Ctrl+S` salva; fechar sujo pede confirmação;
- 409 vira o aviso de arquivo alterado, e recarregar traz o conteúdo novo;
- decorações do live preview: `# Título` vira título, a marca `#` some quando o
  cursor sai da linha, `**x**` fica negrito.

## Riscos e limitações conhecidas

- **CodeMirror 6 em jsdom.** A montagem da view depende de layout, que o jsdom
  não fornece. Por isso a lógica do live preview vive numa função pura; se a
  montagem do editor não rodar nos testes de componente, o teste cobre a barra de
  ações e o fluxo de gravação, e o editor em si é verificado à mão e pelos testes
  da função pura. Nenhum código só-de-teste entra em produção.
- **Bytes que não são UTF-8 válido** num arquivo textual: o editor trabalha com
  texto decodificado, então salvar normaliza esses bytes. O hash evita
  sobrescrita cega, mas não impede a normalização. Caso raro e aceito.
- **Sem histórico.** O desfazer é o do editor, na sessão. Quem salva por cima do
  agente conta com o git do projeto.
