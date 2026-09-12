import { open, stat } from 'node:fs/promises'

/**
 * Lê o FIM de um arquivo de log e devolve o que o parser extrair dali.
 *
 * Nasceu de um histórico que sumia: o rollout do Codex de uma sessão longa
 * chegou a 5,5 GB, `readFile` recusa acima de 2 GiB, e o `catch` de quem
 * chamava transformava o erro em "conversa vazia" — a tela abria sem nada e sem
 * explicação. Carregar o arquivo inteiro nunca foi necessário, aliás: a rota de
 * histórico mostra os últimos 300 eventos.
 *
 * A janela CRESCE porque densidade de conversa varia demais entre logs: no
 * rollout real, 4 MB de cauda rendiam 18 eventos e 256 MB rendiam 123 — quase
 * tudo ali é estado de ferramenta, não diálogo. Então lê-se pouco, e só se
 * insiste enquanto faltar assunto para a tela.
 */
export interface TailOptions {
  /** Quantos itens bastam para parar de crescer (default: 300, o teto da rota). */
  minItems?: number
  /** Teto por leitura. 256 MB saem em ~80 ms no arquivo real; acima disso a
   *  espera passaria a ser sentida a cada troca de terminal. */
  maxBytes?: number
  /** Primeira janela. Cresce 4× por tentativa. */
  firstChunkBytes?: number
}

const MIN_ITEMS = 300
const MAX_BYTES = 256 * 1024 * 1024
const FIRST_CHUNK = 4 * 1024 * 1024

export async function parseFromTail<T>(
  file: string,
  parse: (texto: string) => T[],
  opts: TailOptions = {},
): Promise<T[]> {
  const minItems = opts.minItems ?? MIN_ITEMS
  const maxBytes = opts.maxBytes ?? MAX_BYTES
  let size: number
  try { size = (await stat(file)).size } catch { return [] }
  if (size === 0) return []

  let janela = Math.min(opts.firstChunkBytes ?? FIRST_CHUNK, maxBytes)
  let itens: T[] = []
  for (;;) {
    const bytes = Math.min(janela, size, maxBytes)
    const texto = await lerCauda(file, bytes, size)
    if (texto === null) return itens
    itens = parse(texto)
    if (itens.length >= minItems || bytes >= size || bytes >= maxBytes) return itens
    janela *= 4
  }
}

/** Os últimos `bytes` do arquivo, já sem a linha partida ao meio na borda. */
async function lerCauda(file: string, bytes: number, size: number): Promise<string | null> {
  let fh
  try { fh = await open(file, 'r') } catch { return null }
  try {
    const buf = Buffer.allocUnsafe(bytes)
    const { bytesRead } = await fh.read(buf, 0, bytes, size - bytes)
    const texto = buf.toString('utf8', 0, bytesRead)
    // Começou no início real do arquivo: a primeira linha está inteira.
    if (bytes >= size) return texto
    // Senão, o corte caiu no meio de uma linha (e talvez no meio de um caractere
    // multibyte): usá-la produziria um evento truncado ou lixo.
    const nl = texto.indexOf('\n')
    return nl === -1 ? '' : texto.slice(nl + 1)
  } catch {
    return null
  } finally {
    await fh.close().catch(() => { /* já fechado/sumiu */ })
  }
}
