import type { Db } from './db.js'

/**
 * As ações de um terminal: um nome e uma sequência de comandos que o operador
 * salva para repetir com um clique — deploy, migração, seed.
 *
 * Elas pertencem ao TERMINAL, e não a uma lista global, porque o comando depende
 * de onde roda: `awsVAEXA` (que é um alias e faz `export AWS_PROFILE=getvaexa`)
 * publicaria na conta errada se aparecesse noutro projeto. Quem quer a mesma ação
 * em dois terminais a cadastra nos dois — de propósito.
 */
export interface Action {
  id: number
  projectId: number
  name: string
  /** Rodam no MESMO shell, encadeados: ver o runner, em routes/actions.ts. */
  commands: string[]
  /** Fecha a janelinha quando o comando termina. Desligado por padrão. */
  autoClose: boolean
}

export interface ActionInput {
  name: string
  commands: string[]
  autoClose?: boolean
}

/** Linha em branco no meio dos comandos é descuido de digitação, não comando. */
const limpar = (commands: string[]): string[] =>
  (commands ?? []).map((c) => String(c ?? '').trim()).filter(Boolean)

function validar(input: ActionInput): { name: string; commands: string[] } {
  const name = String(input?.name ?? '').trim()
  if (!name) throw new Error('a ação precisa de um nome')
  const commands = limpar(input?.commands)
  if (commands.length === 0) throw new Error('a ação precisa de ao menos um comando')
  return { name, commands }
}

interface Row { id: number; project_id: number; name: string; commands: string; auto_close: number }

const paraAcao = (r: Row): Action => ({
  id: r.id,
  projectId: r.project_id,
  name: r.name,
  // Guardado como JSON: um comando pode ter quebra de linha, `&&`, aspas — separar
  // por caractere mágico devolveria comando picado no dia em que alguém usasse ele.
  commands: (() => { try { const v = JSON.parse(r.commands); return Array.isArray(v) ? v.map(String) : [] } catch { return [] } })(),
  autoClose: r.auto_close === 1,
})

export function createActionsStore(db: Db) {
  const byId = db.prepare<[number], Row>('SELECT * FROM actions WHERE id = ?')

  return {
    list(projectId: number): Action[] {
      return db.prepare<[number], Row>(
        'SELECT * FROM actions WHERE project_id = ? ORDER BY sort_order ASC, id ASC',
      ).all(projectId).map(paraAcao)
    },

    get(id: number): Action | undefined {
      const r = byId.get(id)
      return r ? paraAcao(r) : undefined
    },

    create(projectId: number, input: ActionInput): Action {
      const { name, commands } = validar(input)
      const ordem = (db.prepare<[number], { n: number | null }>(
        'SELECT MAX(sort_order) n FROM actions WHERE project_id = ?').get(projectId)?.n ?? 0) + 1
      const info = db.prepare(
        'INSERT INTO actions (project_id, name, commands, auto_close, sort_order) VALUES (?, ?, ?, ?, ?)',
      ).run(projectId, name, JSON.stringify(commands), input.autoClose ? 1 : 0, ordem)
      return { id: Number(info.lastInsertRowid), projectId, name, commands, autoClose: !!input.autoClose }
    },

    update(id: number, input: ActionInput): Action {
      const atual = byId.get(id)
      if (!atual) throw new Error(`ação ${id} não existe`)
      const { name, commands } = validar(input)
      db.prepare('UPDATE actions SET name = ?, commands = ?, auto_close = ? WHERE id = ?')
        .run(name, JSON.stringify(commands), input.autoClose ? 1 : 0, id)
      return { id, projectId: atual.project_id, name, commands, autoClose: !!input.autoClose }
    },

    remove(id: number): void {
      db.prepare('DELETE FROM actions WHERE id = ?').run(id)
    },
  }
}

export type ActionsStore = ReturnType<typeof createActionsStore>
