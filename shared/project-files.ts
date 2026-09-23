export interface ProjectFileEntry {
  name: string
  /** Relativo à raiz do projeto, inclusive quando o item é um symlink interno. */
  path: string
  isDir: boolean
}

export interface ProjectFileListing {
  path: string
  parent: string | null
  entries: ProjectFileEntry[]
  nextOffset: number | null
}
