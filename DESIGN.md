---
version: alpha
name: Claudinei
description: Console de conversas e terminais de agentes, com superfícies de vidro e indicadores animados.
colors:
  background: "#0b0d16"
  text: "#eef0f8"
  textDim: "#9aa0bd"
  primary: "#7c5cff"
  accentSecondary: "#9a7bff"
  surfaceSolid: "#12141d"
  success: "#5ee0a0"
  warning: "#f5c451"
  error: "#ff6b8b"
  usageLow: "#3b82f6"
  usageHigh: "#8b5cf6"
typography:
  sans:
    fontFamily: "system-ui, -apple-system, sans-serif"
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
rounded:
  DEFAULT: "16px"
  xs: "6px"
  sm: "8px"
  md: "10px"
  lg: "12px"
omitted:
  - section: spacing
    reason: As geometrias variam por componente; não há uma escala global de espaçamento estabelecida.
  - section: components
    reason: Os componentes React e suas classes CSS são a implementação canônica, documentada abaixo.
---

# Claudinei Design System

## Overview

O produto é uma bancada de trabalho para acompanhar conversas, arquivos e terminais de agentes. A identidade existente combina vidro, acentos violetas e rostinhos animados; seletores utilitários devem continuar discretos, próximos ao contexto da conversa. Este registro documenta o sistema existente e o fluxo de referências `@!`, sem propor uma reformulação.

O uso confirmado inclui desktop, Android e iPhone. A interface oferece português, inglês e espanhol, com inglês como fallback (`web/src/i18n/index.ts`); isso não estabelece um mercado geográfico. O registro é de produto: ações curtas, nomes reais de arquivos, mensagens de estado diretas. Evitar transformar uma ferramenta de trabalho em página promocional, esconder ações atrás de hover ou adicionar animações decorativas aos seletores.

**Fonte canônica dos tokens:** `web/src/styles.css`, aplicada por `web/src/appearance.ts`. Este arquivo espelha o tema padrão Dark Fun; não gera CSS. Cores acima mapeiam a `--bg`, `--text`, `--text-dim`, `--accent`, `--accent-2`, `--surface-solid`, `--ok`, `--warn`, `--err`. Fontes mapeiam a `--font-ui`/`--font-code`; raios são derivados de `--radius` no runtime. Outros temas e ajustes do usuário permanecem definidos nessas fontes. Alterações sistêmicas devem atualizar código e documentação juntos; regras funcionais ficam em [UX-CONTRACT.md](UX-CONTRACT.md).

## Colors

Texto principal e secundário usam `--text` e `--text-dim`. Superfícies, bordas e realce usam `--surface`, `--surface-strong` e `--border`, que variam por tema. O violeta marca ação/foco e os tokens semânticos sinalizam sucesso, atenção e erro com texto, nunca só pela cor. Componentes novos não introduzem cores literais fora dos pacotes de tema. O seletor de arquivos herda esses tokens em temas claros e escuros.

As barras de uso têm duas cores semânticas independentes do acento escolhido: `usageLow` → `--usage-low` (azul, abaixo de 0,7×) e `usageHigh` → `--usage-high` (roxo, acima de 2×). Os tokens ficam no bloco `:root` compartilhado em `styles.css`. Entre 0,7× e 1× usam `--ok`; de 1× a 1,5× interpolam `--ok` → `--warn` → `--err`, com amarelo em 1,25×. De 1,5× a 2× ficam em `--err`. Sem ritmo calculável, usam `--text-dim`. `web/src/usage/pace.ts` é o único dono dessa escala, inclusive para as amostras da legenda.

## Typography

Controles usam a fonte de interface do usuário; caminhos usam a fonte de código. Nomes de arquivos preservam caixa, acentos e caracteres especiais. Nomes longos quebram linha no seletor para que seleção por toque não dependa de tooltip. A busca desse popup usa 16px para evitar zoom automático ao focar no iPhone; linhas usam a densidade compacta dos menus existentes.

## Layout

O breakpoint existente de 768px separa a composição móvel e desktop. `.chat-compose__area` cresce com o texto até seu limite, com `resize: none`. O seletor `@!` flutua acima do campo, sem deslocar a conversa, e usa `ViewportPopover` para respeitar a área visível, inclusive ao redimensionar/abrir o teclado virtual. Largura preferida: 400px; margem mínima da viewport: 8px.

A região de resultados reserva 240px durante busca, carregamento, erro e vazio. A lista rola internamente; se toda a janela for mais curta que o popup, o contêiner externo permite alcançar os controles. A navegação transitória não altera o tamanho/scroll do restante da aplicação. Novas regiões de rolagem herdam o baseline global de scrollbar; a lista de arquivos reserva o gutter.

## Elevation & Depth

Reutilizar `.glass`, `.sess-pop` e suas bordas/superfícies. `ViewportPopover` ocupa o nível dos menus existentes (z-index 61); modais continuam com o contrato de camadas já existente. Não adicionar blur à lateral inteira nem mudar o custo das animações por causa de um seletor.

## Shapes

Contêineres e controles seguem os raios ajustáveis do tema. O padrão é 16px; os fatores existentes xs/sm/md/lg são .375/.5/.625/.75. Valores no frontmatter descrevem somente o padrão, não substituem as variáveis responsivas à preferência do usuário.

## Components

- **Uso:** `UsageCard` mantém nome e multiplicador juntos no lado esquerdo de cada barra. O multiplicador usa texto secundário, números tabulares e uma casa decimal localizada; o percentual permanece à direita. Em nomes longos, apenas o nome recebe reticências.

- **Composição:** `ChatInput` é dono do rascunho, cursor e envio. `MentionMenu` continua sendo a referência visual/funcional para `@@`; `FileMentionMenu` navega pastas e escolhe um arquivo com botões nativos.
- **Overlays:** `ViewportPopover` mede e limita os menus compartilhados. O seletor de arquivos é deliberadamente não modal: título acessível, foco inicial na busca, Escape/fechar retornam ao campo, clique/foco externo fecha sem tomar o foco do destino.
- **Estados:** busca, loading textual com status, erro inline com retry, vazio e nenhum resultado ficam no popup. Botões têm hover, foco visível, pressionado e disabled; ações indisponíveis não executam. Não há gravação ao navegar nem envio automático ao selecionar.
- **Ícones:** preservar o vocabulário dos menus (pasta/arquivo e setas), com rótulos textuais localizados; ícones decorativos não duplicam os nomes acessíveis.
- **Movimento:** preservar o desenho e os movimentos dos indicadores, amostrados nativamente em cerca de 20 FPS e pausados fora da tela, conforme [AGENTS.md](AGENTS.md). O novo seletor não adiciona animação contínua e respeita as preferências existentes de movimento reduzido.

## Do's and Don'ts

- Reutilizar tokens, i18n e primitivas existentes antes de criar variantes.
- Preservar nomes completos, rascunhos, cursor e acesso por teclado/toque.
- Não trocar as animações dos terminais por estados estáticos.
- Não mudar navegação, tema ou permissões de outros fluxos para acomodar este popup.
