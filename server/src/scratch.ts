import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Reserva a pasta de um terminal temporário: `temp-AAAAMMDD-HHMMSS` dentro da base.
 *
 * Mora em `~/.claudinei/scratch`, e não em `/tmp`, de propósito: o `/tmp` é
 * esvaziado no boot, e o terminal que apontasse para lá viraria um "diretório não
 * existe" depois de reiniciar a máquina. A pasta fica até alguém apagá-la.
 *
 * O `mkdirSync` SEM `recursive` é quem detecta a colisão: duas criações no mesmo
 * segundo recebem EEXIST na segunda, que ganha um sufixo em vez de dividir a pasta
 * (e a conversa) com a primeira.
 */
export function createScratchDir(baseDir: string, now: Date = new Date()): string {
  mkdirSync(baseDir, { recursive: true })
  const dois = (n: number) => String(n).padStart(2, '0')
  const carimbo = `${now.getFullYear()}${dois(now.getMonth() + 1)}${dois(now.getDate())}`
    + `-${dois(now.getHours())}${dois(now.getMinutes())}${dois(now.getSeconds())}`
  for (let i = 1; i <= 999; i++) {
    const dir = join(baseDir, i === 1 ? `temp-${carimbo}` : `temp-${carimbo}-${i}`)
    try {
      mkdirSync(dir)
      return dir
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
  }
  throw new Error('não foi possível reservar uma pasta temporária')
}
