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

/**
 * Leitura POSICIONADA, para o histórico em páginas: cada linha sai com o byte em
 * que começa no arquivo. Os logs das engines só crescem no fim, então esse byte
 * não muda — é a identidade estável do evento na tela, e "a página anterior" é
 * simplesmente "as linhas antes do byte X".
 */
export interface PositionedLine { text: string; pos: number }

const NL = 0x0a
/** Passo da varredura para trás quando a janela não tem uma linha inteira. */
const PASSO_VARREDURA = 64 * 1024

/**
 * As linhas inteiras da janela `[max(0, before − maxBytes), before)`; `before`
 * ausente = fim do arquivo.
 *
 * - Janela que não começa no byte 0: a primeira linha está partida e sai fora;
 *   `start` é o byte depois dela, e a próxima página pede `before = start`.
 * - O que vem depois da última quebra, antes de `before`, também está partido
 *   (`before` no meio de uma linha) e sai fora — exceto no fim do arquivo, onde
 *   a última linha pode só não ter `\n` ainda.
 * - Linha maior que a janela: a janela estica para trás até o começo dela, e a
 *   linha vem inteira. Sem isso, uma página no meio do arquivo poderia vir vazia
 *   com `start === before`, e quem pagina ou busca ficaria preso ali.
 *
 * Decodifica cada linha a partir do seu início, então um caractere multibyte
 * cortado pela borda da janela nunca vira lixo.
 */
export async function readLinesBefore(
  file: string,
  before: number | undefined,
  maxBytes: number,
): Promise<{ lines: PositionedLine[]; start: number; atStart: boolean }> {
  const vazio = { lines: [], start: 0, atStart: true }
  let fh
  try { fh = await open(file, 'r') } catch { return vazio }
  try {
    const size = (await fh.stat()).size
    const fim = Math.max(0, Math.min(before ?? size, size))
    if (fim === 0) return vazio
    const inicioJanela = Math.max(0, fim - Math.max(1, maxBytes))
    let buf = await lerTrecho(fh, inicioJanela, fim)
    let base = inicioJanela

    // Fim da última linha inteira (absoluto). No fim do arquivo, o resto sem `\n`
    // conta como linha; antes dele, é o começo partido da linha seguinte.
    const ultimaQuebra = buf.lastIndexOf(NL)
    let fimLinhas = fim === size ? fim : ultimaQuebra === -1 ? -1 : base + ultimaQuebra + 1
    // Começo da primeira linha inteira (absoluto).
    const primeiraQuebra = buf.indexOf(NL)
    let comeco = inicioJanela === 0 ? 0 : primeiraQuebra === -1 ? -1 : base + primeiraQuebra + 1

    if (fimLinhas === -1) {
      // Nenhuma quebra na janela, e ela termina no meio de uma linha: a linha
      // completa mais próxima termina na última quebra antes da janela.
      const q = await ultimaQuebraAntes(fh, inicioJanela)
      if (q === -1) return vazio // tudo antes de `before` é uma linha só, partida
      fimLinhas = q + 1
      comeco = -1
    }
    if (comeco === -1 || comeco >= fimLinhas) {
      // Nenhuma linha inteira na janela: estica até o começo da linha que
      // termina em `fimLinhas`. Não há quebra entre o início da janela e ela,
      // então a varredura começa no menor dos dois.
      comeco = (await ultimaQuebraAntes(fh, Math.min(inicioJanela, fimLinhas - 1))) + 1
      buf = await lerTrecho(fh, comeco, fimLinhas)
      base = comeco
    }

    const lines: PositionedLine[] = []
    let i = comeco - base
    const limite = fimLinhas - base
    while (i < limite) {
      const nl = buf.indexOf(NL, i)
      const fimLinha = nl === -1 || nl >= limite ? limite : nl
      if (fimLinha > i) lines.push({ text: buf.toString('utf8', i, fimLinha), pos: base + i })
      i = fimLinha + 1
    }
    return { lines, start: comeco, atStart: comeco === 0 }
  } catch {
    return vazio
  } finally {
    await fh.close().catch(() => { /* já fechado/sumiu */ })
  }
}

type Handle = Awaited<ReturnType<typeof open>>

async function lerTrecho(fh: Handle, de: number, ate: number): Promise<Buffer> {
  const buf = Buffer.allocUnsafe(ate - de)
  const { bytesRead } = await fh.read(buf, 0, buf.length, de)
  return buf.subarray(0, bytesRead)
}

/** Byte da última `\n` antes de `pos` (exclusivo), ou -1 se não houver. */
async function ultimaQuebraAntes(fh: Handle, pos: number): Promise<number> {
  let ate = pos
  while (ate > 0) {
    const de = Math.max(0, ate - PASSO_VARREDURA)
    const buf = await lerTrecho(fh, de, ate)
    const q = buf.lastIndexOf(NL)
    if (q !== -1) return de + q
    ate = de
  }
  return -1
}

/**
 * `parseFromTail` com posição e a partir de um byte: lê as linhas antes de
 * `before` numa janela que cresce 4× (mesmo motivo da cauda: densidade de
 * conversa varia demais) até o parser render `minItems`, a janela chegar a
 * `maxBytes` ou o começo do arquivo.
 */
export async function readPositionedTail<T>(
  file: string,
  parseLines: (lines: PositionedLine[]) => T[],
  opts: { before?: number; minItems: number; maxBytes?: number; firstChunkBytes?: number },
): Promise<{ items: T[]; start: number; atStart: boolean }> {
  const maxBytes = opts.maxBytes ?? MAX_BYTES
  let janela = Math.min(opts.firstChunkBytes ?? FIRST_CHUNK, maxBytes)
  for (;;) {
    const r = await readLinesBefore(file, opts.before, janela)
    const items = parseLines(r.lines)
    if (items.length >= opts.minItems || r.atStart || janela >= maxBytes) {
      return { items, start: r.start, atStart: r.atStart }
    }
    janela = Math.min(janela * 4, maxBytes)
  }
}
