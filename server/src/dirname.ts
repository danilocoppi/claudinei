import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * __dirname que funciona tanto em dev (tsx roda os .ts como ESM real — sem
 * __dirname/__filename ambiente, só import.meta.url) quanto no binário
 * empacotado (scripts/package.mjs usa esbuild p/ bundlar tudo em CJS — ver
 * dist-pkg/server.cjs — onde import.meta.url fica vazio/undefined, mas o
 * wrapper CJS do Node injeta um __dirname real).
 *
 * NÃO dá pra fazer isso inline em cada arquivo com
 * `const __dirname = typeof __dirname !== 'undefined' ? __dirname : ...`:
 * a própria declaração `const __dirname` entra em TDZ dentro do seu próprio
 * inicializador (o `typeof` só protege contra identificador nunca declarado,
 * não contra self-reference em TDZ) — por isso o `typeof __dirname` mora
 * numa função à parte, sem nenhuma variável de mesmo nome no escopo dela.
 */
export function moduleDirname(importMetaUrl: string): string {
  if (typeof __dirname !== 'undefined') return __dirname
  return dirname(fileURLToPath(importMetaUrl))
}

/** Mesma ideia de moduleDirname, mas pro caminho do arquivo — usado por
 *  createRequire(), que precisa de um caminho real (import.meta.url vira
 *  undefined no bundle CJS — createRequire(undefined) explode). */
export function moduleFilename(importMetaUrl: string): string {
  if (typeof __filename !== 'undefined') return __filename
  return fileURLToPath(importMetaUrl)
}
