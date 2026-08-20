/**
 * O dicionário que traduz o vocabulário de quem TRABALHA para o de quem DESENHA.
 *
 * Foi medido: entre os ~250 mil ícones do Iconify, "cliente", "financeiro",
 * "pagamento", "relatório" e "produção" devolvem ZERO resultados. "backend" e
 * "frontend" devolvem só nomes de empresa. Não é falta de acervo — é que ninguém
 * batiza um ícone em português, e "backend" não é desenho de coisa nenhuma: é
 * conceito. Nenhuma quantidade de ícone resolve isso; um dicionário resolve.
 *
 * As entradas são palavras que alguém digita de verdade ao nomear um terminal —
 * em português e em inglês, porque ele alterna as duas — e os valores são nomes
 * que EXISTEM como ícone. Ambiguidade não se resolve adivinhando: "banco" devolve
 * banco de dados E banco financeiro, e quem procura reconhece o seu num relance.
 */
export const VOCABULARY: Record<string, string[]> = {
  // --- papéis e acesso ---
  admin: ['shield', 'user-cog', 'key', 'crown'],
  administrador: ['shield', 'user-cog', 'key', 'crown'],
  master: ['crown', 'star', 'git-branch'],
  root: ['crown', 'terminal', 'key'],
  usuario: ['user', 'user-circle', 'users'],
  user: ['user-circle', 'users', 'id-badge'],
  conta: ['user-circle', 'wallet', 'id-badge'],
  cliente: ['users', 'user-heart', 'briefcase', 'contact'],
  customer: ['users', 'user-heart', 'briefcase', 'contact'],
  equipe: ['users', 'users-group'],
  time: ['users', 'users-group'],
  team: ['users', 'users-group'],
  permissao: ['key', 'lock', 'shield-check'],
  acesso: ['key', 'lock', 'log-in'],
  login: ['log-in', 'key', 'fingerprint'],
  auth: ['fingerprint', 'key', 'shield-check'],
  autenticacao: ['fingerprint', 'key', 'shield-check'],
  senha: ['key', 'lock', 'asterisk'],
  password: ['key', 'lock', 'asterisk'],
  seguranca: ['shield', 'lock', 'shield-check'],
  security: ['shield', 'lock', 'shield-check'],
  certificado: ['certificate', 'award', 'shield-check'],
  ssl: ['lock', 'certificate', 'shield-check'],

  // --- camadas e infraestrutura ---
  backend: ['server', 'database', 'cpu'],
  frontend: ['browser', 'layout', 'monitor', 'palette'],
  fullstack: ['layers', 'stack'],
  servidor: ['server', 'cpu'],
  server: ['cpu', 'database', 'hard-drive'],
  infra: ['server-cog', 'network', 'cloud'],
  infraestrutura: ['server-cog', 'network', 'cloud'],
  devops: ['infinity', 'settings-automation', 'workflow'],
  rede: ['network', 'wifi', 'globe'],
  network: ['wifi', 'globe', 'router'],
  nuvem: ['cloud', 'cloud-upload'],
  cloud: ['cloud-upload', 'server'],
  container: ['box', 'package', 'ship'],
  docker: ['ship', 'container', 'box'],
  kubernetes: ['ship-wheel', 'hexagon', 'network'],
  k8s: ['ship-wheel', 'hexagon', 'network'],
  dominio: ['globe', 'link', 'world-www'],
  domain: ['globe', 'link', 'world-www'],
  dns: ['globe', 'list-tree', 'route'],
  proxy: ['route', 'arrow-right-left', 'network'],
  vpn: ['shield-lock', 'lock', 'network'],
  firewall: ['brick-wall', 'shield', 'flame'],

  // --- dados ---
  banco: ['database', 'building-bank', 'server'],
  bancodedados: ['database', 'server'],
  bd: ['database', 'server'],
  database: ['server', 'table', 'hard-drive'],
  dados: ['database', 'chart-bar', 'table'],
  data: ['database', 'chart-bar', 'table'],
  cache: ['memory-stick', 'zap', 'database'],
  fila: ['list-ordered', 'layers', 'stack'],
  queue: ['list-ordered', 'layers', 'stack'],
  backup: ['archive', 'save', 'hard-drive'],
  migracao: ['arrow-right-left', 'database-export', 'move'],
  planilha: ['table', 'file-spreadsheet', 'grid'],
  tabela: ['table', 'grid'],

  // --- ciclo de vida do código ---
  api: ['plug', 'webhook', 'braces'],
  deploy: ['rocket', 'cloud-upload', 'ship'],
  build: ['hammer', 'package', 'tool'],
  release: ['tag', 'package', 'rocket'],
  producao: ['rocket', 'factory', 'server'],
  prod: ['rocket', 'factory', 'server'],
  homologacao: ['flask', 'layers', 'clipboard-check'],
  staging: ['flask', 'layers', 'clipboard-check'],
  desenvolvimento: ['code', 'terminal', 'hammer'],
  dev: ['code', 'terminal', 'hammer'],
  teste: ['flask', 'test-pipe', 'bug'],
  testes: ['flask', 'test-pipe', 'bug'],
  test: ['flask', 'test-pipe', 'bug'],
  bug: ['alert-triangle', 'shield-alert'],
  erro: ['bug', 'alert-triangle', 'circle-x'],
  log: ['file-text', 'scroll', 'list'],
  logs: ['file-text', 'scroll', 'list'],
  script: ['file-code', 'terminal', 'scroll'],
  repositorio: ['git-branch', 'folder-git', 'book'],
  repo: ['git-branch', 'folder-git', 'book'],
  branch: ['git-branch', 'git-fork'],
  commit: ['git-commit', 'git-branch'],
  merge: ['git-merge', 'git-pull-request'],
  pipeline: ['workflow', 'infinity', 'git-pull-request'],
  ci: ['workflow', 'infinity', 'refresh'],
  cd: ['workflow', 'rocket', 'infinity'],
  integracao: ['plug', 'puzzle', 'link'],
  automacao: ['robot', 'zap', 'workflow'],
  bot: ['robot', 'cpu', 'message-circle'],
  robo: ['robot', 'cpu'],
  ia: ['brain', 'sparkles', 'robot'],
  ai: ['brain', 'sparkles', 'robot'],

  // --- interfaces e produto ---
  site: ['globe', 'browser', 'world-www'],
  website: ['globe', 'browser', 'world-www'],
  web: ['globe', 'browser'],
  app: ['smartphone', 'device-mobile', 'layout'],
  aplicativo: ['smartphone', 'device-mobile', 'layout'],
  mobile: ['smartphone', 'device-mobile'],
  desktop: ['monitor', 'device-desktop'],
  painel: ['layout-dashboard', 'gauge', 'grid'],
  dashboard: ['layout-dashboard', 'gauge', 'grid'],
  design: ['palette', 'pen-tool', 'brush'],
  layout: ['grid', 'columns', 'frame'],

  // --- operação ---
  monitoramento: ['activity', 'gauge', 'eye'],
  monitor: ['activity', 'gauge', 'eye'],
  metrica: ['chart-bar', 'gauge', 'activity'],
  metricas: ['chart-bar', 'gauge', 'activity'],
  grafico: ['chart-line', 'chart-bar', 'chart-pie'],
  relatorio: ['chart-bar', 'file-text', 'clipboard-list'],
  report: ['chart-bar', 'file-text', 'clipboard-list'],
  alerta: ['bell', 'alert-triangle', 'siren'],
  alarme: ['bell', 'alert-triangle', 'siren'],
  notificacao: ['bell', 'mail'],
  agendamento: ['clock', 'calendar', 'timer'],
  agenda: ['calendar', 'clock', 'notebook'],
  cron: ['clock', 'timer', 'repeat'],
  performance: ['gauge', 'zap', 'trending-up'],
  velocidade: ['gauge', 'zap', 'rocket'],

  // --- negócio ---
  financeiro: ['wallet', 'currency-dollar', 'chart-line', 'calculator'],
  financas: ['wallet', 'currency-dollar', 'chart-line'],
  finance: ['wallet', 'currency-dollar', 'chart-line'],
  pagamento: ['credit-card', 'cash', 'wallet'],
  payment: ['credit-card', 'cash', 'wallet'],
  cobranca: ['receipt', 'file-invoice', 'credit-card'],
  fatura: ['receipt', 'file-invoice', 'file-text'],
  nota: ['receipt', 'file-invoice', 'sticky-note'],
  imposto: ['receipt', 'calculator', 'scale'],
  fiscal: ['receipt', 'calculator', 'scale'],
  contabilidade: ['calculator', 'book', 'receipt'],
  orcamento: ['calculator', 'coins', 'file-text'],
  venda: ['shopping-cart', 'trending-up', 'tag'],
  vendas: ['shopping-cart', 'trending-up', 'tag'],
  compra: ['shopping-cart', 'shopping-bag'],
  compras: ['shopping-cart', 'shopping-bag'],
  loja: ['store', 'shopping-bag', 'building-store'],
  ecommerce: ['store', 'shopping-cart', 'package'],
  estoque: ['package', 'boxes', 'warehouse'],
  inventario: ['package', 'boxes', 'warehouse'],
  produto: ['package', 'box', 'tag'],
  produtos: ['package', 'box', 'tag'],
  entrega: ['truck', 'package', 'ship'],
  logistica: ['truck', 'package', 'ship'],
  frete: ['truck', 'package'],
  contrato: ['file-text', 'scale', 'signature'],
  juridico: ['scale', 'gavel', 'file-text'],
  legal: ['scale', 'gavel', 'file-text'],
  rh: ['users', 'id-badge', 'user-heart'],
  pessoas: ['users', 'user-heart'],
  marketing: ['megaphone', 'target', 'trending-up'],
  suporte: ['headset', 'life-buoy', 'message-circle'],
  atendimento: ['headset', 'message-circle', 'phone'],
  helpdesk: ['headset', 'life-buoy', 'ticket'],
  chamado: ['ticket', 'life-buoy', 'message-circle'],
  meta: ['target', 'flag', 'trending-up'],
  objetivo: ['target', 'flag'],
  empresa: ['building', 'briefcase'],
  escritorio: ['building', 'briefcase'],
  trabalho: ['briefcase', 'building'],

  // --- comunicação e arquivos ---
  chat: ['message-circle', 'messages', 'mail'],
  mensagem: ['message-circle', 'mail'],
  conversa: ['messages', 'message-circle'],
  email: ['mail', 'at', 'inbox'],
  telefone: ['phone', 'headset'],
  documentacao: ['book', 'file-text', 'notebook'],
  doc: ['file-text', 'book'],
  docs: ['file-text', 'book'],
  arquivo: ['file', 'folder', 'archive'],
  pasta: ['folder', 'folder-open'],
  imagem: ['image', 'photo', 'camera'],
  foto: ['photo', 'camera', 'image'],
  video: ['play', 'film', 'movie'],
  audio: ['music', 'volume', 'headphones'],
  som: ['volume', 'music'],
  musica: ['music', 'headphones'],
  voz: ['microphone', 'waveform'],
  microfone: ['microphone'],

  // --- organização ---
  projeto: ['folder-kanban', 'briefcase', 'clipboard'],
  tarefa: ['check-square', 'list-checks', 'clipboard'],
  tarefas: ['list-checks', 'check-square', 'clipboard'],
  task: ['check-square', 'list-checks'],
  todo: ['list-checks', 'check-square'],
  calendario: ['calendar', 'calendar-days'],
  busca: ['search', 'zoom-in'],
  pesquisa: ['search', 'zoom-in'],
  config: ['settings', 'sliders', 'tool'],
  configuracao: ['settings', 'sliders', 'tool'],
  ajuste: ['sliders', 'settings', 'tool'],
  ferramenta: ['tool', 'wrench', 'hammer'],
  laboratorio: ['flask', 'test-pipe', 'microscope'],
  lab: ['flask', 'test-pipe', 'microscope'],
  jogo: ['device-gamepad', 'dice', 'sword'],
  game: ['device-gamepad', 'dice', 'sword'],
  casa: ['home', 'house'],
  pessoal: ['home', 'user', 'heart'],
  favorito: ['star', 'heart', 'bookmark'],
  urgente: ['flame', 'alert-triangle', 'siren'],
  lixo: ['trash', 'trash-2'],
  energia: ['zap', 'bolt', 'battery'],
}

/** Quantos sinônimos entram no leque. Cada um é uma ida à API. */
const FAN_OUT = 4

/**
 * Acento e caixa não podem separar quem digita "segurança" de quem digita
 * "seguranca" — os dois querem a mesma coisa. NFD separa a letra do acento; a
 * faixa ̀-ͯ é o acento sozinho, que sai fora.
 */
export function normalizeTerm(raw: string): string {
  return raw.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
}

/**
 * A palavra digitada continua sendo a primeira tentativa — o dicionário ACRESCENTA
 * caminhos, nunca substitui o que a pessoa pediu.
 */
export function expandQuery(raw: string): string[] {
  const term = normalizeTerm(raw)
  if (!term) return []
  // Plural só é tentado depois do termo cru: "dados" e "docs" existem por si.
  const entry = VOCABULARY[term] ?? (term.endsWith('s') ? VOCABULARY[term.slice(0, -1)] : undefined)
  return entry ? [term, ...entry.slice(0, FAN_OUT)] : [term]
}
