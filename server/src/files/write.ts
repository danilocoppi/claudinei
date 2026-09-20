import { rename, unlink, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { statSync } from 'node:fs'

/**
 * Grava por temporário + rename, no mesmo diretório do alvo.
 *
 * O rename é atômico: uma queda no meio nunca deixa o arquivo truncado, e o
 * agente que estiver lendo vê a versão antiga ou a nova — nunca meio arquivo.
 * O `mode` do original viaja junto porque o temporário nasce com o padrão do
 * processo (0o600 depois do umask), e o rename leva esse modo consigo.
 *
 * O fim de linha do arquivo manda: um `.md` gravado em CRLF que voltasse em LF
 * viraria um diff de arquivo inteiro no git por causa de uma frase corrigida.
 */
export async function writeFileAtomic(real: string, conteudo: string, anterior: Buffer): Promise<void> {
  const texto = anterior.includes('\r\n') ? conteudo.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n') : conteudo
  const temp = join(dirname(real), `.${basename(real)}.claudinei-tmp-${randomBytes(6).toString('hex')}`)
  try {
    await writeFile(temp, texto, { encoding: 'utf8', mode: statSync(real).mode & 0o777 })
    await rename(temp, real)
  } catch (err) {
    await unlink(temp).catch(() => { /* o temporário pode nem ter sido criado */ })
    throw err
  }
}
