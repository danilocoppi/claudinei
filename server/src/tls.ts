import { readFileSync } from 'node:fs'

/**
 * HTTPS servido pelo próprio Claudinei — opcional.
 *
 * Existe porque a alternativa (terminar TLS num reverse proxy) tem um custo que
 * não é óbvio: com um proxy na frente, o par TCP vira sempre `127.0.0.1`, e o
 * servidor perde a capacidade de distinguir quem está NA máquina de quem chega
 * pela rede — é o que obriga o `--behind-proxy` a desligar abrir-pasta, VS Code,
 * `!comando` e Actions para todo mundo. Servindo TLS aqui, o socket enxerga o IP
 * real e essas funções continuam valendo para quem está no teclado.
 *
 * Fica DESLIGADO por padrão: quem roda em localhost não deve precisar de
 * certificado para usar a ferramenta.
 */
export interface TlsFiles {
  cert?: string
  key?: string
}

export interface TlsOptions {
  cert: Buffer
  key: Buffer
}

/**
 * Lê os arquivos, ou devolve null quando TLS não foi pedido.
 *
 * Lança em vez de degradar para HTTP: meio-configurado é engano, não intenção, e
 * subir em texto puro calado deixaria alguém convencido de que expôs com TLS
 * quando não expôs. Errar alto é o comportamento seguro aqui.
 */
export function loadTlsOptions(files: TlsFiles): TlsOptions | null {
  const cert = files.cert?.trim()
  const key = files.key?.trim()
  if (!cert && !key) return null
  if (!cert) throw new Error('TLS: falta o certificado (--tls-cert / CLAUDINEI_TLS_CERT)')
  if (!key) throw new Error('TLS: falta a chave (--tls-key / CLAUDINEI_TLS_KEY)')

  const ler = (caminho: string, qual: string): Buffer => {
    try {
      return readFileSync(caminho)
    } catch (err) {
      // O caminho entra na mensagem: o erro cru do Node ("EISDIR", "EACCES") não
      // diz QUAL dos dois arquivos falhou nem onde ele foi procurado.
      throw new Error(`TLS: não consegui ler ${qual} em ${caminho} — ${(err as Error).message}`)
    }
  }
  return { cert: ler(cert, 'o certificado'), key: ler(key, 'a chave') }
}
