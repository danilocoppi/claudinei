import { readdir, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ProjectFileEntry, ProjectFileListing } from '../../../shared/project-files.js'

const PAGE_SIZE = 100
const nameOrder = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })
const exactOrder = new Intl.Collator('en')
const fold = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
const inside = (root: string, target: string) => {
  const path = relative(root, target)
  return !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`)
}

/** Lista um nível, sem ler conteúdo nem varrer a árvore inteira do projeto. */
export async function listProjectFiles(
  projectPath: string, path = '', query = '', offset = 0,
): Promise<ProjectFileListing> {
  const root = await realpath(projectPath)
  const target = resolve(root, path)
  if (isAbsolute(path) || !inside(root, target)) throw new Error('outside_project')
  const real = await realpath(target)
  // Vale para admin também: este seletor navega apenas pela raiz do terminal.
  if (!inside(root, real)) throw new Error('outside_project')
  const current = relative(root, target).split(sep).join('/')
  const words = fold(query.trim()).split(/\s+/).filter(Boolean)
  const names = (await readdir(real, { withFileTypes: true }))
    .filter(entry => {
      if (!words.length) return true
      const name = fold(entry.name)
      return words.every(word => name.includes(word))
    })
  const entries: ProjectFileEntry[] = []
  // Symlinks precisam de realpath, mas não disparamos milhares de operações de
  // filesystem de uma vez. Arquivos especiais e links quebrados ficam de fora.
  for (let start = 0; start < names.length; start += 32) {
    const batch = await Promise.all(names.slice(start, start + 32).map(async entry => {
      let isDir = entry.isDirectory()
      if (entry.isSymbolicLink()) {
        try {
          const destination = await realpath(join(real, entry.name))
          if (!inside(root, destination)) return null
          const info = await stat(destination)
          if (!info.isDirectory() && !info.isFile()) return null
          isDir = info.isDirectory()
        } catch { return null }
      } else if (!isDir && !entry.isFile()) return null
      return { name: entry.name, path: current ? `${current}/${entry.name}` : entry.name, isDir }
    }))
    for (const entry of batch) if (entry) entries.push(entry)
  }
  entries.sort((a, b) => Number(b.isDir) - Number(a.isDir)
    || nameOrder.compare(a.name, b.name)
    || exactOrder.compare(a.name, b.name))
  return {
    path: current,
    parent: current ? (dirname(current) === '.' ? '' : dirname(current)) : null,
    entries: entries.slice(offset, offset + PAGE_SIZE),
    nextOffset: offset + PAGE_SIZE < entries.length ? offset + PAGE_SIZE : null,
  }
}
