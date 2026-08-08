/**
 * Caminho de arquivo nas duas formas que o operador precisa copiar: o RELATIVO
 * (bom para colar no chat, que é como a engine se refere aos arquivos) e o
 * COMPLETO (bom para colar num terminal).
 *
 * O path que chega do chat às vezes é relativo e às vezes absoluto — depende de
 * como a engine escreveu —, então as duas funções normalizam em vez de assumir.
 */

const stripTrailingSlash = (p: string): string => (p.endsWith('/') ? p.slice(0, -1) : p)

/** Caminho relativo à raiz do projeto. Fora do projeto (ou sem raiz), volta como veio. */
export function toRelativePath(path: string, projectPath?: string): string {
  if (!projectPath) return path
  // A barra é obrigatória no prefixo: sem ela, a raiz `…/wl-backend` casaria
  // também com `…/wl-backend-old/a.js` e o corte sairia errado.
  const root = stripTrailingSlash(projectPath) + '/'
  return path.startsWith(root) ? path.slice(root.length) : path
}

/** Caminho absoluto. Já absoluto (ou sem raiz conhecida), volta como veio. */
export function toFullPath(path: string, projectPath?: string): string {
  if (path.startsWith('/') || !projectPath) return path
  return `${stripTrailingSlash(projectPath)}/${path.replace(/^\.\//, '')}`
}

/**
 * O navegador está falando com o servidor pela própria máquina?
 *
 * "Abrir na pasta" roda no SERVIDOR: de um celular ou de outro micro, o
 * gerenciador de arquivos abriria na máquina do Claudinei, não na de quem
 * clicou — então a opção só aparece quando as duas são a mesma.
 */
export function isLocalHost(hostname: string = window.location.hostname): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]'
}
