import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, type Db } from '../src/db.js'
import { recordThread, ownLatestThread, foreignThreadIds, isSharedPath } from '../src/project-threads.js'

let db: Db

// Dois projetos na MESMA pasta e um em pasta própria: é a topologia que todo o
// resto do plano assume. O INSERT direto (sem o serviço) porque aqui só
// interessa a posse do thread, não a validação de diretório existente.
beforeEach(() => {
  db = openDb(':memory:')
  const ins = db.prepare(`INSERT INTO projects (id, name, path, color, icon) VALUES (?, ?, ?, '#fff', '📁')`)
  ins.run(1, 'A', '/tmp/juntos')
  ins.run(2, 'B', '/tmp/juntos')
  ins.run(3, 'C', '/tmp/sozinho')
})

describe('posse de conversa', () => {
  it('ownLatestThread devolve o último thread registrado do projeto+engine', () => {
    recordThread(db, 1, 'claude', 'conv-antiga')
    recordThread(db, 1, 'claude', 'conv-nova')
    expect(ownLatestThread(db, 1, 'claude')).toBe('conv-nova')
  })

  it('sem thread nenhum, ownLatestThread é null (o card nasce em conversa nova)', () => {
    expect(ownLatestThread(db, 1, 'claude')).toBeNull()
  })

  // Reencontrar uma conversa velha a promove de volta: é o que acontece quando o
  // operador reabre no terminal um thread anterior.
  it('registrar de novo um thread já conhecido o traz para a frente, sem duplicar linha', () => {
    recordThread(db, 1, 'claude', 'conv-a')
    recordThread(db, 1, 'claude', 'conv-b')
    recordThread(db, 1, 'claude', 'conv-a')
    expect(ownLatestThread(db, 1, 'claude')).toBe('conv-a')
    const n = db.prepare(`SELECT COUNT(*) AS n FROM project_threads WHERE project_id=1`).get() as { n: number }
    expect(n.n).toBe(2)
  })

  it('threads são por engine: o do codex não vira o último do claude', () => {
    recordThread(db, 1, 'claude', 'conv-claude')
    recordThread(db, 1, 'codex', 'conv-codex')
    expect(ownLatestThread(db, 1, 'claude')).toBe('conv-claude')
    expect(ownLatestThread(db, 1, 'codex')).toBe('conv-codex')
  })

  it('foreignThreadIds traz só o que é do vizinho da MESMA pasta e da MESMA engine', () => {
    recordThread(db, 1, 'claude', 'meu')
    recordThread(db, 2, 'claude', 'do-vizinho')
    recordThread(db, 2, 'codex', 'do-vizinho-outra-engine')
    recordThread(db, 3, 'claude', 'de-outra-pasta')
    expect([...foreignThreadIds(db, 1, 'claude')]).toEqual(['do-vizinho'])
  })

  it('pasta não compartilhada não tem thread alheio a descartar', () => {
    recordThread(db, 3, 'claude', 'so-meu')
    expect(foreignThreadIds(db, 3, 'claude').size).toBe(0)
  })

  it('isSharedPath: verdadeiro só quando outro projeto aponta para o mesmo caminho', () => {
    expect(isSharedPath(db, 1)).toBe(true)
    expect(isSharedPath(db, 2)).toBe(true)
    expect(isSharedPath(db, 3)).toBe(false)
  })

  // Sem a cascata, apagar um terminal deixaria a posse das conversas dele
  // pendurada e o vizinho continuaria descartando ids de um projeto que não existe.
  it('apagar o projeto leva os threads dele', () => {
    recordThread(db, 1, 'claude', 'vai-embora')
    db.prepare('DELETE FROM projects WHERE id=1').run()
    const n = db.prepare(`SELECT COUNT(*) AS n FROM project_threads`).get() as { n: number }
    expect(n.n).toBe(0)
  })
})
