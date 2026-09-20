import { writeFile } from 'node:fs/promises'

export async function writeFileAtomic(real: string, conteudo: string, _anterior: Buffer): Promise<void> {
  await writeFile(real, conteudo, 'utf8')
}
