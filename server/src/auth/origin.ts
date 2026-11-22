import type { IncomingHttpHeaders } from 'node:http'

/**
 * Origem permitida para quem fala com o Claudinei de dentro de um navegador
 * (WebSockets e escrita em /api): só a MESMA origem, isto é, o host:porta do
 * `Origin` igual ao `Host` da requisição — ou, atrás de proxy reverso
 * (`behindProxy`), ao `X-Forwarded-Host` que ele repassa.
 *
 * Não há ramo de loopback: outra porta do localhost é OUTRA origem. Uma página
 * servida pelo servidor de desenvolvimento de um projeto (localhost:3000, a
 * porta de um agente) mandaria o cookie do operador junto e abriria /ws, o
 * terminal ou o navegador do agente. O desenvolvimento da interface pelo Vite
 * continua passando porque o proxy dele não reescreve o Host (sem
 * `changeOrigin`): o servidor vê `Host: localhost:9100` e `Origin:
 * http://localhost:9100`.
 *
 * Sem `Origin` passa: não é navegador (Hermes com token de serviço, curl).
 * `Origin: null` (páginas em sandbox) não é URL com host e é recusada.
 */
export function isAllowedOrigin(origin: string | undefined, host: string | undefined, forwardedHost?: string): boolean {
  if (origin === undefined) return true
  let u: URL
  try {
    u = new URL(origin)
  } catch {
    return false
  }
  if (!u.host) return false
  // X-Forwarded-Host com mais de um proxy vem em lista: o primeiro é o que o navegador viu.
  const candidates = [host, forwardedHost?.split(',')[0]?.trim()]
  return candidates.some((h) => !!h && sameHost(u, h))
}

/**
 * O host do cabeçalho, lido no esquema da origem: assim `localhost:80` casa
 * com `http://localhost` (o navegador omite a porta padrão; o inject do
 * Fastify não) e maiúsculas não contam.
 */
function sameHost(origin: URL, host: string): boolean {
  // Só host[:porta]: nada que o parser de URL leria como usuário, caminho ou consulta.
  if (/[/\\@?#\s]/.test(host)) return false
  try {
    return new URL(`${origin.protocol}//${host}`).host === origin.host
  } catch {
    return false
  }
}

/** A regra acima aplicada a uma requisição; o X-Forwarded-Host só vale com `behindProxy`. */
export function originAllowed(req: { headers: IncomingHttpHeaders; behindProxy?: boolean }): boolean {
  const fwd = req.behindProxy ? req.headers['x-forwarded-host'] : undefined
  return isAllowedOrigin(req.headers.origin, req.headers.host, Array.isArray(fwd) ? fwd[0] : fwd)
}
