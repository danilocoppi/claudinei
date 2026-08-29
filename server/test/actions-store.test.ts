import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../src/db.js'
import { createProjectsService } from '../src/projects.js'
import { createActionsStore } from '../src/actions.js'

let db: Db
let store: ReturnType<typeof createActionsStore>
let alpha: number, beta: number

beforeEach(() => {
  db = openDb(':memory:')
  const p = createProjectsService(db)
  alpha = p.create({ name: 'Alpha', path: mkdtempSync(join(tmpdir(), 'ac-')) }).id
  beta = p.create({ name: 'Beta', path: mkdtempSync(join(tmpdir(), 'ac-')) }).id
  store = createActionsStore(db)
})

/**
 * Uma ação é um nome e uma sequência de comandos que se repete com um clique.
 * Ela pertence ao TERMINAL: o `awsVAEXA` que faz sentido num projeto publicaria
 * na conta errada em outro, então não há lista global.
 */
describe('ações de um terminal', () => {
  it('guarda nome e comandos', () => {
    const a = store.create(alpha, { name: 'Deploy', commands: ['awsVAEXA', 'npm run deploy'] })
    expect(a).toMatchObject({ projectId: alpha, name: 'Deploy', commands: ['awsVAEXA', 'npm run deploy'] })
    expect(store.list(alpha)).toHaveLength(1)
  })

  it('a ação de um terminal não aparece no outro', () => {
    store.create(alpha, { name: 'Deploy', commands: ['npm run deploy'] })
    expect(store.list(beta)).toEqual([])
  })

  /** O padrão é NÃO fechar: um deploy que quebra e some é o pior resultado. */
  it('fechar ao terminar é opção, e vem desligada', () => {
    expect(store.create(alpha, { name: 'X', commands: ['ls'] }).autoClose).toBe(false)
    expect(store.create(alpha, { name: 'Y', commands: ['ls'], autoClose: true }).autoClose).toBe(true)
  })

  it('renomeia e troca os comandos', () => {
    const a = store.create(alpha, { name: 'Deploy', commands: ['ls'] })
    const b = store.update(a.id, { name: 'Deploy prod', commands: ['awsVAEXA', 'npm run deploy'], autoClose: true })
    expect(b).toMatchObject({ name: 'Deploy prod', autoClose: true })
    expect(b.commands).toEqual(['awsVAEXA', 'npm run deploy'])
  })

  it('exclui', () => {
    const a = store.create(alpha, { name: 'X', commands: ['ls'] })
    store.remove(a.id)
    expect(store.list(alpha)).toEqual([])
  })

  it('mantém a ordem de cadastro', () => {
    for (const n of ['Primeira', 'Segunda', 'Terceira']) store.create(alpha, { name: n, commands: ['ls'] })
    expect(store.list(alpha).map((a) => a.name)).toEqual(['Primeira', 'Segunda', 'Terceira'])
  })

  /** Linha em branco entre comandos é descuido de digitação, não comando. */
  it('descarta linhas vazias', () => {
    const a = store.create(alpha, { name: 'X', commands: ['ls', '  ', '', 'pwd'] })
    expect(a.commands).toEqual(['ls', 'pwd'])
  })

  it('recusa ação sem nome ou sem comando', () => {
    expect(() => store.create(alpha, { name: '  ', commands: ['ls'] })).toThrow(/nome/i)
    expect(() => store.create(alpha, { name: 'X', commands: ['  ', ''] })).toThrow(/comando/i)
  })

  it('excluir o terminal leva as ações dele junto', () => {
    store.create(alpha, { name: 'X', commands: ['ls'] })
    db.prepare('DELETE FROM projects WHERE id=?').run(alpha)
    expect(store.list(alpha)).toEqual([])
  })
})

/**
 * O campo de digitação é escolha de quem cadastra, e não um padrão.
 *
 * O PTY sempre aceitou escrita — é um terminal. Quem decide é a INTERFACE: numa
 * ação que só publica e cospe log, um campo de texto só serviria para mandar
 * caractere a um processo que não está lendo.
 */
describe('campo para responder ao comando', () => {
  it('vem desligado e sobrevive à edição', () => {
    const a = store.create(alpha, { name: 'Deploy', commands: ['ls'] })
    expect(a.allowInput).toBe(false)

    const b = store.update(a.id, { name: 'Deploy', commands: ['ls'], allowInput: true })
    expect(b.allowInput).toBe(true)
    expect(store.get(a.id)?.allowInput).toBe(true)

    store.update(a.id, { name: 'Deploy', commands: ['ls'] })
    expect(store.get(a.id)?.allowInput, 'omitir é desligar, como no autoClose').toBe(false)
  })

  it('nasce ligado quando pedido', () => {
    const a = store.create(alpha, { name: 'Migrar', commands: ['npm run migrate'], allowInput: true })
    expect(store.get(a.id)?.allowInput).toBe(true)
  })
})
