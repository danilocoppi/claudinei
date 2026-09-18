# Dois terminais na mesma pasta — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permitir dois (ou mais) terminais apontando para a mesma pasta, cada um com sua própria conversa, sem que um retome o contexto do outro.

**Architecture:** Duas camadas. (1) `projects.path` deixa de ser `UNIQUE`, via migração destrutiva única que roda dentro de `openDb` no boot — com backup `VACUUM INTO`, transação e detecção pelo estado real do schema, porque o parque instalado está em máquinas que não podemos inspecionar. (2) Uma tabela nova, `project_threads`, guarda de quem é cada conversa; os cinco pontos em que o servidor resolve "a conversa mais recente desta pasta" passam a descartar ids alheios (`exclude`) ou a retomar o thread próprio (`ownLatest`) em vez de usar `--continue`.

**Tech Stack:** TypeScript (ESM), Fastify, better-sqlite3, SQLite (WAL), React 18 + Zustand + react-i18next, Vitest (server e web), Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-18-dois-terminais-mesma-pasta-design.md`

## Global Constraints

- Toda comunicação, comentário de código e mensagem de commit em **português**, com acentuação correta.
- Comentários explicam **por que**, não o que — é o padrão do repositório. Densidade igual à do arquivo vizinho.
- A migração roda **sozinha** no boot (`openDb`), nunca por script externo, e **não derruba o serviço** se falhar.
- Pasta com **um único terminal** tem que continuar se comportando exatamente como hoje, inclusive o `--continue`. Há teste de regressão explícito para cada um dos cinco pontos.
- `latestConversationId(projectPath, exclude?)` — o segundo parâmetro é **opcional**: chamada sem ele mantém o comportamento atual.
- Textos de interface nos três idiomas: `web/src/i18n/en.ts` (fonte do tipo), `es.ts`, `pt-BR.ts`. Chave que falta em `en.ts` quebra o build do TypeScript.
- Nada de normalizar caminhos: `/x` e `/x/` continuam projetos distintos (fora de escopo no spec).
- Rodar testes de servidor com `npm test -w server`; um arquivo só: `npx vitest run test/<arquivo> --root server`. Web: `npm test -w web`.
- **Não empacotar, não instalar em `release/` e não reiniciar o serviço** sem autorização expressa do Danilo, pedida no momento — são três permissões distintas.

## Estrutura de arquivos

| Arquivo | Responsabilidade | Ação |
|---|---|---|
| `server/src/project-threads.ts` | Posse de conversa: registrar thread, achar o thread próprio, listar os alheios, dizer se a pasta é compartilhada | **criar** |
| `server/src/db.ts` | `SCHEMA` sem `UNIQUE`, tabela `project_threads`, índice `idx_projects_path`, migração destrutiva | modificar |
| `server/src/engine/types.ts` | Assinatura `latestConversationId(projectPath, exclude?)` | modificar |
| `server/src/history.ts` | `latestTranscriptId(..., exclude?)` (Claude) | modificar |
| `server/src/engine/codex/rollout.ts` | `latestThreadForCwd(..., exclude?)` | modificar |
| `server/src/engine/kimi/kimi-history.ts` | `latestSessionId(..., exclude?)` | modificar |
| `server/src/engine/{claude-engine,codex/codex-engine,kimi/kimi-engine,opencode/opencode-engine}.ts` | Repassar `exclude`; no OpenCode ele entra na chave do cache | modificar |
| `server/src/claude/manager.ts` | `persist` alimenta `project_threads`; `start`/`revive` traduzem `continueLatest`; `openInTerminal`/`onExit` passam `exclude` | modificar |
| `server/src/routes/sessions.ts` | Prévia de histórico: thread próprio em pasta compartilhada | modificar |
| `web/src/components/NewProjectModal.tsx` | Aviso (não erro) ao criar terminal em pasta já usada | modificar |
| `web/src/components/ChatView.tsx` + `web/src/styles.css` | Indicador de pasta compartilhada no cabeçalho | modificar |
| `web/src/i18n/{en,es,pt-BR}.ts` | Textos novos | modificar |
| `server/test/project-threads.test.ts` | Posse de conversa | **criar** |
| `server/test/migrations-path-shared.test.ts` | Migração do `UNIQUE` | **criar** |
| `server/test/shared-folder.test.ts` | Isolamento nos cinco pontos + regressão de pasta única | **criar** |
| `server/test/db.test.ts` | O caso "path é único" vira "path repetido é aceito" | modificar |
| `web/src/test/new-project-modal.test.tsx`, `web/src/test/chatview.test.tsx` | Aviso e indicador | modificar |

---

### Task 1: Posse de conversa (`project_threads`)

Tabela nova mais as quatro consultas que o resto do plano usa. Nada de comportamento muda ainda: é aditivo e inerte.

**Files:**
- Create: `server/src/project-threads.ts`
- Modify: `server/src/db.ts` (bloco de `CREATE TABLE`, depois de `user_prefs`, por volta da linha 185)
- Test: `server/test/project-threads.test.ts`

**Interfaces:**
- Consumes: `Db` de `server/src/db.js`.
- Produces:
  - `recordThread(db: Db, projectId: number, engine: string, threadId: string): void`
  - `ownLatestThread(db: Db, projectId: number, engine: string): string | null`
  - `foreignThreadIds(db: Db, projectId: number, engine: string): ReadonlySet<string>`
  - `isSharedPath(db: Db, projectId: number): boolean`

- [ ] **Step 1: Escrever o teste que falha**

Criar `server/test/project-threads.test.ts`:

```ts
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
```

- [ ] **Step 2: Rodar o teste e ver falhar**

Run: `npx vitest run test/project-threads.test.ts --root server`
Expected: FAIL — `Cannot find module '../src/project-threads.js'`.

- [ ] **Step 3: Criar a tabela em `db.ts`**

Em `server/src/db.ts`, logo depois do bloco `CREATE TABLE IF NOT EXISTS user_prefs (...)`:

```ts
  // De quem é cada conversa. Existe porque as SESSÕES não servem de memória de
  // posse: a limpeza automática guarda só as 5 últimas finalizadas por projeto
  // (manager.ts), então o id de uma conversa antiga desaparece do banco enquanto
  // a conversa segue no disco da engine — pronta para ser confundida com a do
  // terminal vizinho da mesma pasta.
  //
  // `seq` ordena, não `seen_at`: `datetime('now')` tem resolução de um segundo e
  // dois registros no mesmo segundo empatariam, deixando "meu último thread"
  // indefinido (e o teste disso intermitente). `seen_at` fica para leitura humana.
  db.exec(`CREATE TABLE IF NOT EXISTS project_threads (
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    engine     TEXT NOT NULL,
    thread_id  TEXT NOT NULL,
    seq        INTEGER NOT NULL,
    seen_at    TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (project_id, engine, thread_id)
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_threads_own ON project_threads(project_id, engine, seq DESC)`)
```

- [ ] **Step 4: Escrever `server/src/project-threads.ts`**

```ts
import type { Db } from './db.js'

/**
 * Posse de conversa: qual thread de agente pertence a qual terminal.
 *
 * Duas entradas da sidebar podem apontar para a MESMA pasta, e o storage de cada
 * engine é indexado por pasta (transcripts do Claude, rollouts do Codex, `session`
 * do OpenCode). Sem saber de quem é cada conversa, "a mais recente desta pasta" é
 * a do vizinho metade das vezes — e o `onExit` do terminal chegava a gravá-la.
 */

/** Marca `threadId` como conversa deste projeto+engine, promovendo-a a mais recente. */
export function recordThread(db: Db, projectId: number, engine: string, threadId: string): void {
  db.prepare(
    `INSERT INTO project_threads (project_id, engine, thread_id, seq)
     VALUES (?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM project_threads))
     ON CONFLICT(project_id, engine, thread_id) DO UPDATE SET
       seq = (SELECT COALESCE(MAX(seq), 0) + 1 FROM project_threads),
       seen_at = datetime('now')`,
  ).run(projectId, engine, threadId)
}

/** A última conversa DESTE terminal — o que substitui o `--continue` em pasta compartilhada. */
export function ownLatestThread(db: Db, projectId: number, engine: string): string | null {
  const row = db.prepare(
    `SELECT thread_id FROM project_threads WHERE project_id=? AND engine=? ORDER BY seq DESC LIMIT 1`,
  ).get(projectId, engine) as { thread_id?: string } | undefined
  return row?.thread_id ?? null
}

/**
 * As conversas dos OUTROS terminais da mesma pasta — o conjunto a descartar ao
 * perguntar à engine qual é a conversa mais recente da pasta.
 *
 * Filtra por engine porque o storage é por engine: um thread do Codex nunca
 * apareceria na busca do Claude, e carregá-lo aqui só encheria o `NOT IN`.
 */
export function foreignThreadIds(db: Db, projectId: number, engine: string): ReadonlySet<string> {
  const rows = db.prepare(
    `SELECT pt.thread_id AS id
       FROM project_threads pt
       JOIN projects p ON p.id = pt.project_id
      WHERE pt.engine = ?
        AND pt.project_id <> ?
        AND p.path = (SELECT path FROM projects WHERE id = ?)`,
  ).all(engine, projectId, projectId) as { id: string }[]
  return new Set(rows.map((r) => r.id))
}

/**
 * Mais de um terminal nesta pasta?
 *
 * É o interruptor de tudo: com um terminal só, nada muda em relação a hoje —
 * inclusive o `--continue`, que continua sendo a coisa certa a fazer.
 */
export function isSharedPath(db: Db, projectId: number): boolean {
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM projects WHERE path = (SELECT path FROM projects WHERE id = ?)`,
  ).get(projectId) as { n: number }
  return row.n > 1
}
```

- [ ] **Step 5: Rodar o teste e ver passar**

Run: `npx vitest run test/project-threads.test.ts --root server`
Expected: PASS (8 casos).

- [ ] **Step 6: Rodar a suíte do servidor**

Run: `npm test -w server`
Expected: PASS. A única falha aceitável é a intermitente pré-existente de `routes-orchestrator.test.ts` — confirme rodando o arquivo isolado antes de investigar.

- [ ] **Step 7: Commit**

```bash
git add server/src/project-threads.ts server/src/db.ts server/test/project-threads.test.ts
git commit -m "$(cat <<'EOF'
feat(db): registra de quem é cada conversa em project_threads

As sessões não servem de memória de posse: a limpeza guarda só 5
finalizadas por projeto, e o id da conversa antiga desaparece do banco
enquanto a conversa segue no disco da engine.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `projects.path` deixa de ser `UNIQUE`

A migração destrutiva. Roda em `openDb`, detecta pelo estado real do schema, copia o banco antes e aborta inteira ao primeiro sinal de problema.

**Files:**
- Modify: `server/src/db.ts` (`SCHEMA` linha 11; funções novas; chamada antes do `return db`)
- Modify: `server/test/db.test.ts` (o caso `path de projeto é único`)
- Test: `server/test/migrations-path-shared.test.ts`

**Interfaces:**
- Consumes: nada da Task 1 (a tabela `project_threads` já existe no arquivo, e sobrevive à recriação de `projects` porque os ids são preservados).
- Produces: `openDb(path)` devolve banco onde `INSERT INTO projects` aceita caminho repetido, com índice não-único `idx_projects_path`.

- [ ] **Step 1: Escrever o teste que falha**

Criar `server/test/migrations-path-shared.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/db.js'

/**
 * A migração que remove o UNIQUE de projects.path.
 *
 * É a primeira migração DESTRUTIVA do projeto e roda em máquinas que não podemos
 * inspecionar, então o que está sob teste não é só "o UNIQUE saiu": é que nada se
 * perde, que a cópia de segurança existe, que rodar duas vezes não faz nada na
 * segunda, e que a numeração de ids não regride.
 */

/**
 * Devolve `projects` ao estado ANTIGO (com o UNIQUE), pelo mesmo procedimento de
 * recriação que a migração usa — ao contrário.
 *
 * Simular a instalação antiga escrevendo o DDL de todas as tabelas à mão ficaria
 * desatualizado no primeiro ALTER TABLE que alguém escrevesse; assim o "banco
 * antigo" é o banco de verdade, com a restrição de volta.
 */
function reintroduzirUnique(dbPath: string): void {
  const db = new Database(dbPath)
  const ddl = (db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='projects'`).get() as { sql: string }).sql
  const antigo = ddl
    .replace(/CREATE\s+TABLE\s+"?projects"?/i, 'CREATE TABLE projects_old')
    .replace(/(\bpath\s+TEXT\s+NOT\s+NULL)/i, '$1 UNIQUE')
  const cols = (db.prepare(`PRAGMA table_info(projects)`).all() as { name: string }[]).map((c) => `"${c.name}"`).join(', ')
  db.pragma('foreign_keys = OFF')
  db.exec('BEGIN')
  db.exec(antigo)
  db.exec(`INSERT INTO projects_old (${cols}) SELECT ${cols} FROM projects`)
  db.exec('DROP TABLE projects')
  db.exec('ALTER TABLE projects_old RENAME TO projects')
  db.exec('COMMIT')
  db.pragma('foreign_keys = ON')
  db.close()
}

/** Banco com dados em todas as tabelas que dependem de projects, e com o UNIQUE de volta. */
function bancoAntigoPovoado(): string {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'mig-path-')), 'claudinei.db')
  const db = openDb(dbPath)
  db.prepare(`INSERT INTO projects (id, name, path, color, icon) VALUES (1, 'Alfa', '/tmp/alfa', '#fff', '📁')`).run()
  db.prepare(`INSERT INTO projects (id, name, path, color, icon) VALUES (2, 'Beta', '/tmp/beta', '#fff', '📁')`).run()
  db.prepare(`INSERT INTO sessions (local_id, project_id, engine, status, claude_session_id) VALUES ('s1', 1, 'claude', 'stopped', 'conv-1')`).run()
  db.prepare(`INSERT INTO mural (project_id, title, content) VALUES (1, 'Aviso', 'corpo')`).run()
  db.prepare(`INSERT INTO tasks (from_project_id, to_project_id, description) VALUES (1, 2, 'tarefa')`).run()
  db.prepare(`INSERT INTO users (username, password_hash) VALUES ('u', 'h')`).run()
  db.prepare(`INSERT INTO user_projects (user_id, project_id) VALUES (1, 1)`).run()
  db.prepare(`INSERT INTO schedules (project_id, name, task, cadence) VALUES (1, 'diário', 'olhar', 'daily')`).run()
  db.prepare(`INSERT INTO actions (project_id, name, commands) VALUES (1, 'deploy', 'echo oi')`).run()
  db.prepare(`INSERT INTO project_threads (project_id, engine, thread_id, seq) VALUES (1, 'claude', 'conv-1', 1)`).run()
  db.close()
  reintroduzirUnique(dbPath)
  return dbPath
}

const unicos = (dbPath: string): number => {
  const db = new Database(dbPath, { readonly: true })
  const list = db.prepare(`PRAGMA index_list(projects)`).all() as { name: string; origin: string }[]
  let n = 0
  for (const idx of list) {
    if (idx.origin !== 'u') continue
    const cols = (db.prepare(`PRAGMA index_info('${idx.name}')`).all() as { name: string | null }[]).map((c) => c.name)
    if (cols.length === 1 && cols[0] === 'path') n++
  }
  db.close()
  return n
}

const backups = (dbPath: string): string[] =>
  readdirSync(join(dbPath, '..')).filter((f) => f.startsWith('claudinei.db.bak-'))

describe('migração: projects.path deixa de ser único', () => {
  it('abre o banco antigo e passa a aceitar duas entradas na mesma pasta', () => {
    const dbPath = bancoAntigoPovoado()
    expect(unicos(dbPath), 'o banco do teste tem que começar COM o UNIQUE').toBe(1)

    const db = openDb(dbPath)
    expect(() =>
      db.prepare(`INSERT INTO projects (name, path, color, icon) VALUES ('Alfa 2', '/tmp/alfa', '#fff', '📁')`).run(),
    ).not.toThrow()
    db.close()
  })

  it('não perde nada das tabelas que dependem de projects', () => {
    const dbPath = bancoAntigoPovoado()
    const db = openDb(dbPath)
    const conta = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n
    expect(conta('projects')).toBe(2)
    expect(conta('sessions')).toBe(1)
    expect(conta('mural')).toBe(1)
    expect(conta('tasks')).toBe(1)
    expect(conta('user_projects')).toBe(1)
    expect(conta('schedules')).toBe(1)
    expect(conta('actions')).toBe(1)
    expect(conta('project_threads')).toBe(1)
    // O DROP TABLE projects com as FKs LIGADAS levaria as filhas em cascata: a
    // contagem acima é o que prova que o PRAGMA foreign_keys=OFF pegou.
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    const p = db.prepare('SELECT * FROM projects WHERE id=1').get() as any
    expect(p).toMatchObject({ name: 'Alfa', path: '/tmp/alfa' })
    db.close()
  })

  it('a numeração de ids não regride depois da recriação', () => {
    const dbPath = bancoAntigoPovoado()
    const db = openDb(dbPath)
    const info = db.prepare(`INSERT INTO projects (name, path, color, icon) VALUES ('Gama', '/tmp/gama', '#fff', '📁')`).run()
    expect(Number(info.lastInsertRowid)).toBeGreaterThan(2)
    db.close()
  })

  it('deixa uma cópia de segurança do banco antes de mexer', () => {
    const dbPath = bancoAntigoPovoado()
    expect(backups(dbPath)).toHaveLength(0)
    const db = openDb(dbPath)
    db.close()
    expect(backups(dbPath)).toHaveLength(1)
  })

  it('é idempotente: a segunda abertura não migra nada nem copia de novo', () => {
    const dbPath = bancoAntigoPovoado()
    openDb(dbPath).close()
    openDb(dbPath).close()
    expect(backups(dbPath), 'um backup por migração, não por boot').toHaveLength(1)
    expect(unicos(dbPath)).toBe(0)
  })

  it('instalação nova nasce sem a restrição e com o índice de busca por caminho', () => {
    const db = openDb(':memory:')
    const ins = db.prepare(`INSERT INTO projects (name, path, color, icon) VALUES (?, ?, '#fff', '📁')`)
    ins.run('A', '/tmp/mesma')
    expect(() => ins.run('B', '/tmp/mesma')).not.toThrow()
    const nomes = (db.prepare(`PRAGMA index_list(projects)`).all() as { name: string }[]).map((i) => i.name)
    expect(nomes).toContain('idx_projects_path')
  })
})
```

- [ ] **Step 2: Rodar o teste e ver falhar**

Run: `npx vitest run test/migrations-path-shared.test.ts --root server`
Expected: FAIL — o primeiro caso quebra no `INSERT` com `UNIQUE constraint failed: projects.path`, e o de instalação nova também.

- [ ] **Step 3: Tirar o `UNIQUE` do `SCHEMA` e criar o índice substituto**

Em `server/src/db.ts`, no `SCHEMA`, trocar a linha 11:

```ts
  path TEXT NOT NULL,
```

Logo depois do `CREATE TABLE IF NOT EXISTS project_threads` (Task 1), acrescentar:

```ts
  // Substitui o índice que vinha de brinde com o UNIQUE removido: a busca por
  // caminho continua existindo (é como se sabe que a pasta é compartilhada).
  // Recriado aqui a cada boot porque o DROP TABLE da migração leva os índices
  // de projects embora.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_projects_path ON projects(path)`)
```

- [ ] **Step 4: Escrever a migração**

Em `server/src/db.ts`, antes de `export function openDb`:

```ts
/**
 * Índices ÚNICOS sobre `projects.path` que vieram de restrição de coluna
 * (`origin = 'u'`).
 *
 * A detecção é pelo estado real do schema porque os bancos existentes não
 * registram quais migrações já rodaram: um contador introduzido agora teria que
 * adivinhar o passado. Perguntar ao SQLite acerta nos três estados do parque —
 * banco antigo, banco já migrado e instalação nova.
 */
function indicesUnicosDePath(db: Db): string[] {
  const list = db.prepare(`PRAGMA index_list(projects)`).all() as { name: string; origin: string }[]
  const achados: string[] = []
  for (const idx of list) {
    // Só 'u' (restrição de coluna): um CREATE UNIQUE INDEX avulso apareceria como
    // 'c' e não existe neste projeto — se um dia existir, um DROP INDEX resolve,
    // sem recriar tabela.
    if (idx.origin !== 'u') continue
    const cols = (db.prepare(`PRAGMA index_info('${idx.name.replace(/'/g, "''")}')`).all() as { name: string | null }[]).map((c) => c.name)
    if (cols.length === 1 && cols[0] === 'path') achados.push(idx.name)
  }
  return achados
}

/**
 * Remove o `UNIQUE` de `projects.path` — é o que libera dois terminais na mesma
 * pasta.
 *
 * Diferente das outras migrações do arquivo, esta não cabe num
 * `try { ALTER TABLE } catch {}`: no SQLite, tirar uma restrição exige recriar a
 * tabela, e uma queda no meio das cinco instruções deixaria a instalação SEM a
 * tabela `projects`. Daí a transação, a conferência e a cópia de segurança.
 */
function migrarPathNaoUnico(db: Db, dbPath: string): void {
  if (indicesUnicosDePath(db).length === 0) return // já migrado, ou instalação nova

  // Primeira migração destrutiva do projeto, rodando em máquinas que não podemos
  // inspecionar. VACUUM INTO dá uma cópia consistente sem parar nada e sem
  // depender do estado do WAL; custa o tamanho do banco em disco, uma vez na vida
  // da instalação, e é o único caminho de volta que existe remotamente.
  if (dbPath !== ':memory:') {
    const bak = `${dbPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
    db.exec(`VACUUM INTO '${bak.replace(/'/g, "''")}'`)
  }

  const ddl = (db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='projects'`).get() as { sql?: string } | undefined)?.sql
  if (!ddl) throw new Error('projects sem DDL em sqlite_master')
  // O DDL e as colunas VÊM DO BANCO: as adicionadas por ALTER TABLE (sort_order,
  // group_id, sector_id e as que vierem depois) já estão lá. Uma lista fixa aqui
  // apagaria calada a próxima coluna que alguém escrever, e `SELECT *` quebraria
  // se a ordem das colunas divergisse entre máquinas.
  const novoDdl = ddl
    // `"projects"` entre as alternativas não é paranoia: o próprio
    // ALTER TABLE ... RENAME reescreve o DDL com o nome citado, e um banco que já
    // passou por uma recriação guarda `CREATE TABLE "projects"` (medido).
    .replace(/CREATE\s+TABLE\s+(?:"projects"|'projects'|\[projects\]|projects)/i, 'CREATE TABLE projects_new')
    .replace(/(\bpath\b[^,)]*?)\s+UNIQUE\b/i, '$1')
  const cols = (db.prepare(`PRAGMA table_info(projects)`).all() as { name: string }[]).map((c) => `"${c.name}"`).join(', ')

  // FORA da transação: dentro, este PRAGMA é no-op silencioso — e sem ele o DROP
  // abaixo dispararia o ON DELETE CASCADE das sete tabelas que apontam para
  // projects, levando embora sessões, mural, tarefas, agendamentos e ações.
  db.pragma('foreign_keys = OFF')
  try {
    db.exec('BEGIN')
    try {
      db.exec(novoDdl)
      db.exec(`INSERT INTO projects_new (${cols}) SELECT ${cols} FROM projects`)
      db.exec('DROP TABLE projects')
      db.exec('ALTER TABLE projects_new RENAME TO projects')
      db.exec(`CREATE INDEX IF NOT EXISTS idx_projects_path ON projects(path)`)
      // Confere o que a substituição no DDL de fato produziu. Se o UNIQUE
      // sobreviveu (DDL escrito de outra forma numa instalação que não conhecemos),
      // aborta com o banco intacto em vez de deixar um meio-caminho.
      if (indicesUnicosDePath(db).length > 0) throw new Error('o UNIQUE de projects.path sobreviveu à recriação')
      const violacoes = db.prepare('PRAGMA foreign_key_check').all()
      if (violacoes.length > 0) throw new Error(`foreign_key_check acusou ${violacoes.length} violação(ões)`)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  } finally {
    db.pragma('foreign_keys = ON')
  }
}
```

Na última linha de `openDb`, antes do `return db`:

```ts
  // Depois de TODAS as alterações de coluna de projects — antes delas, a cópia
  // levaria os dados sem sort_order/group_id/sector_id.
  //
  // Falhar aqui NÃO derruba o boot: o rollback já devolveu o banco íntegro, e
  // tirar o Claudinei do ar de um usuário remoto por causa de uma funcionalidade
  // opcional seria pior que não tê-la. O sintoma visível é a pasta repetida
  // continuar recusada.
  try {
    migrarPathNaoUnico(db, path)
  } catch (err) {
    console.error('[claudinei] MIGRAÇÃO projects.path FALHOU — dois terminais na mesma pasta seguem indisponíveis:', err)
  }
  return db
```

- [ ] **Step 5: Rodar o teste e ver passar**

Run: `npx vitest run test/migrations-path-shared.test.ts --root server`
Expected: PASS (6 casos).

- [ ] **Step 6: Corrigir o teste que afirmava o contrário**

Em `server/test/db.test.ts`, substituir o caso `path de projeto é único`:

```ts
  // O UNIQUE saiu de propósito: dois terminais na mesma pasta são dois projetos.
  // Quem impede duplicata acidental é o aviso do modal, não o banco.
  it('aceita duas entradas com o mesmo path', () => {
    const db = openDb(':memory:')
    const ins = db.prepare(`INSERT INTO projects (name, path, color, icon) VALUES (?, ?, ?, ?)`)
    ins.run('A', '/tmp/a', '#fff', '📁')
    expect(() => ins.run('B', '/tmp/a', '#fff', '📁')).not.toThrow()
  })
```

- [ ] **Step 7: Rodar a suíte do servidor inteira**

Run: `npm test -w server`
Expected: PASS. Qualquer outro teste que dependa do `UNIQUE` aparece aqui — corrija-o no mesmo espírito do passo anterior (o banco não é mais quem impede pasta repetida).

- [ ] **Step 8: Commit**

```bash
git add server/src/db.ts server/test/db.test.ts server/test/migrations-path-shared.test.ts
git commit -m "$(cat <<'EOF'
feat(db): projects.path deixa de ser UNIQUE, com migração automática

Remover restrição no SQLite exige recriar a tabela — cinco instruções
onde uma queda no meio deixaria a instalação sem a tabela projects. A
migração roda em openDb (portão único do boot), detecta pelo estado real
do schema, copia o banco com VACUUM INTO antes, confere
foreign_key_check dentro da transação e, se falhar, não derruba o
serviço de quem está longe.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: as engines aprendem a descartar conversas alheias

Parâmetro `exclude` opcional em `latestConversationId` e nas quatro implementações. Continua ninguém passando o parâmetro — a Task 4 faz isso.

**Files:**
- Modify: `server/src/engine/types.ts:90`
- Modify: `server/src/history.ts:30` (`latestTranscriptId`)
- Modify: `server/src/engine/claude-engine.ts:51`
- Modify: `server/src/engine/codex/rollout.ts:104` (`latestThreadForCwd`)
- Modify: `server/src/engine/codex/codex-engine.ts:29`
- Modify: `server/src/engine/kimi/kimi-history.ts:31` (`latestSessionId`)
- Modify: `server/src/engine/kimi/kimi-engine.ts:39`
- Modify: `server/src/engine/opencode/opencode-engine.ts:44,52,103,119`
- Test: `server/test/claude-engine.test.ts`, `server/test/codex-rollout.test.ts`, `server/test/kimi-engine.test.ts`, `server/test/opencode-engine.test.ts`

**Interfaces:**
- Consumes: nada das tarefas anteriores.
- Produces: `Engine.latestConversationId(projectPath: string, exclude?: ReadonlySet<string>): string | null` nas quatro engines; `latestTranscriptId(dir, projectPath, exclude?)`; `latestThreadForCwd(root, cwd, exclude?)`; `latestSessionId(projectPath, exclude?)`.

- [ ] **Step 1: Escrever os testes que falham**

Em `server/test/claude-engine.test.ts`, dentro do `describe` que já existe (ele monta transcripts fake num `CLAUDE_CONFIG_DIR` temporário — siga o helper do arquivo para criar dois transcripts com mtime diferente):

```ts
  it('latestConversationId pula os ids excluídos (conversa do terminal vizinho)', () => {
    // Dois transcripts na MESMA pasta: o mais recente é do vizinho.
    const antigo = escreverTranscript('11111111-1111-1111-1111-111111111111', 1000)
    escreverTranscript('22222222-2222-2222-2222-222222222222', 2000)
    expect(claudeEngine.latestConversationId(PROJ)).toBe('22222222-2222-2222-2222-222222222222')
    expect(claudeEngine.latestConversationId(PROJ, new Set(['22222222-2222-2222-2222-222222222222']))).toBe(antigo)
  })

  it('excluir todos os ids devolve null (o terminal abre conversa nova)', () => {
    escreverTranscript('33333333-3333-3333-3333-333333333333', 1000)
    expect(claudeEngine.latestConversationId(PROJ, new Set(['33333333-3333-3333-3333-333333333333']))).toBeNull()
  })
```

> `escreverTranscript(id, mtime)` e `PROJ` são os helpers do próprio arquivo; se ele ainda não tiver um que ajuste mtime, crie-o com `utimesSync(file, mtime/1000, mtime/1000)` e faça-o devolver o `id`.

Em `server/test/codex-rollout.test.ts` (segue o helper de rollout do arquivo):

```ts
  it('latestThreadForCwd pula os threads excluídos', () => {
    // Dois rollouts com o mesmo cwd; o varredor visita do mais recente ao mais antigo.
    escreverRollout('thread-novo', CWD)
    escreverRollout('thread-velho', CWD)
    expect(latestThreadForCwd(ROOT, CWD, new Set(['thread-novo']))).toBe('thread-velho')
    expect(latestThreadForCwd(ROOT, CWD, new Set(['thread-novo', 'thread-velho']))).toBeNull()
  })
```

Em `server/test/kimi-engine.test.ts`:

```ts
  it('latestConversationId pula as sessões excluídas', () => {
    // O índice do Kimi é append-only: a última entrada da pasta é a mais recente.
    escreverIndice([{ sessionId: 'kimi-1', workDir: PROJ }, { sessionId: 'kimi-2', workDir: PROJ }])
    expect(kimiEngine.latestConversationId(PROJ)).toBe('kimi-2')
    expect(kimiEngine.latestConversationId(PROJ, new Set(['kimi-2']))).toBe('kimi-1')
  })
```

Em `server/test/opencode-engine.test.ts`, no `describe('latestConversationId (sqlite, determinístico)')`:

```ts
    it('pula as sessões excluídas', () => {
      inserirSessao('ses_vizinho', dir, 2000)
      inserirSessao('ses_meu', dir, 1000)
      expect(openCodeEngine.latestConversationId(dir)).toBe('ses_vizinho')
      expect(openCodeEngine.latestConversationId(dir, new Set(['ses_vizinho']))).toBe('ses_meu')
    })

    // Sem o exclude na chave, a primeira resposta cacheada valeria para a
    // pergunta seguinte — que é outra pergunta.
    it('o exclude entra na chave do cache: duas perguntas não se atropelam', () => {
      inserirSessao('ses_a', dir, 2000)
      inserirSessao('ses_b', dir, 1000)
      expect(openCodeEngine.latestConversationId(dir)).toBe('ses_a')
      expect(openCodeEngine.latestConversationId(dir, new Set(['ses_a']))).toBe('ses_b')
      expect(openCodeEngine.latestConversationId(dir)).toBe('ses_a')
    })

    it('invalidar a pasta limpa também as respostas com exclude', () => {
      inserirSessao('ses_a', dir, 2000)
      inserirSessao('ses_b', dir, 1000)
      expect(openCodeEngine.latestConversationId(dir, new Set(['ses_a']))).toBe('ses_b')
      inserirSessao('ses_c', dir, 3000)
      openCodeEngine.invalidateLatestConversation?.(dir)
      expect(openCodeEngine.latestConversationId(dir, new Set(['ses_a']))).toBe('ses_c')
    })
```

> `inserirSessao(id, directory, tempo)` é o helper que o arquivo já usa para popular o `opencode.db` fake; reaproveite-o com o nome que ele tiver lá.

- [ ] **Step 2: Rodar os testes e ver falhar**

Run: `npx vitest run test/claude-engine.test.ts test/codex-rollout.test.ts test/kimi-engine.test.ts test/opencode-engine.test.ts --root server`
Expected: FAIL — o TypeScript recusa o segundo argumento (`Expected 1 arguments, but got 2`).

- [ ] **Step 3: Mudar a assinatura na interface**

Em `server/src/engine/types.ts`, substituir a linha `latestConversationId(projectPath: string): string | null` por:

```ts
  /**
   * O id da conversa mais recente desta pasta, no storage da engine.
   *
   * `exclude` são conversas que pertencem a OUTRO terminal da mesma pasta. Duas
   * entradas da sidebar podem apontar para o mesmo diretório, e o storage da
   * engine é indexado por diretório: sem descartar os ids alheios, cada terminal
   * retomaria a conversa do vizinho. Quem chama sem o parâmetro — e toda pasta
   * com um único terminal — vê o comportamento de sempre.
   */
  latestConversationId(projectPath: string, exclude?: ReadonlySet<string>): string | null
```

- [ ] **Step 4: Claude**

Em `server/src/history.ts`:

```ts
export function latestTranscriptId(claudeConfigDir: string, projectPath: string, exclude?: ReadonlySet<string>): string | null {
  const dir = join(claudeConfigDir, 'projects', encodeCwd(projectPath))
  if (!existsSync(dir)) return null
  let best: { id: string; mtime: number } | null = null
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue
    const id = name.slice(0, -'.jsonl'.length)
    if (exclude?.has(id)) continue
    try {
      const mtime = statSync(join(dir, name)).mtimeMs
      if (!best || mtime > best.mtime) best = { id, mtime }
    } catch { /* arquivo sumiu no meio: ignora */ }
  }
  return best?.id ?? null
}
```

Em `server/src/engine/claude-engine.ts`:

```ts
  latestConversationId(projectPath: string, exclude?: ReadonlySet<string>): string | null {
    return latestTranscriptId(claudeConfigDir(), projectPath, exclude)
  },
```

- [ ] **Step 5: Codex**

Em `server/src/engine/codex/rollout.ts`:

```ts
export function latestThreadForCwd(root: string, cwd: string, exclude?: ReadonlySet<string>): string | null {
  for (const file of allRollouts(root)) {
    const first = readFirstLine(file)
    if (!first) continue
    try {
      const o = JSON.parse(first)
      if (o?.type === 'session_meta' && o.payload?.cwd === cwd) {
        const id = o.payload.id ?? null
        // Thread do vizinho: segue procurando em vez de devolver o primeiro achado.
        if (id && exclude?.has(id)) continue
        return id
      }
    } catch { /* ignora */ }
  }
  return null
}
```

Em `server/src/engine/codex/codex-engine.ts`:

```ts
  latestConversationId(projectPath: string, exclude?: ReadonlySet<string>): string | null {
    return latestThreadForCwd(sessionsRoot(), projectPath, exclude)
  },
```

- [ ] **Step 6: Kimi**

Em `server/src/engine/kimi/kimi-history.ts`:

```ts
export function latestSessionId(projectPath: string, exclude?: ReadonlySet<string>): string | null {
  const entries = readIndex(kimiHomeFor(projectPath))
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].workDir !== projectPath) continue
    if (exclude?.has(entries[i].sessionId)) continue
    return entries[i].sessionId
  }
  return null
}
```

Em `server/src/engine/kimi/kimi-engine.ts`:

```ts
  latestConversationId(projectPath: string, exclude?: ReadonlySet<string>): string | null {
    return latestSessionId(projectPath, exclude)
  },
```

- [ ] **Step 7: OpenCode (consulta, cache e invalidação)**

Em `server/src/engine/opencode/opencode-engine.ts`, trocar a consulta e a entrada da engine:

```ts
/** "Última conversa da pasta" no db do opencode, degradando graciosamente se o schema mudar. */
function queryLatestConversation(db: Database.Database, projectPath: string, exclude?: ReadonlySet<string>): string | null {
  // O schema do opencode evolui entre versões: só referencia a coluna quando ela
  // existe — um id aproximado ainda é melhor que preview nenhum.
  const cols = new Set((db.prepare('PRAGMA table_info(session)').all() as { name?: string }[]).map((c) => c?.name))
  // Subagentes criam sessões FILHAS (parent_id) no MESMO directory: sem filtrar,
  // a "última conversa" vira o transcript de um subagente em vez do que o
  // operador conversou no terminal — e o chat web mostrava a conversa errada.
  const where = [cols.has('parent_id') ? 'directory = ? AND parent_id IS NULL' : 'directory = ?']
  const params: unknown[] = [projectPath]
  // Conversas do terminal vizinho desta mesma pasta saem no SQL, não em JS: o
  // LIMIT 1 tem que valer para o que sobrou, não para o que foi descartado.
  if (exclude && exclude.size) {
    where.push(`id NOT IN (${[...exclude].map(() => '?').join(', ')})`)
    params.push(...exclude)
  }
  // time_updated, não time_created: retomar uma sessão no TUI não muda a data de
  // criação dela, e é ela (a recém-usada) que o terminal/chat deve reencontrar.
  const order = cols.has('time_updated') ? 'COALESCE(time_updated, time_created)' : 'time_created'
  const row = db.prepare(`SELECT id FROM session WHERE ${where.join(' AND ')} ORDER BY ${order} DESC LIMIT 1`).get(...params) as { id?: string } | undefined
  return row?.id ?? null
}

/**
 * Chave do cache. O `exclude` entra nela porque "a última da pasta" e "a última
 * da pasta que não seja a do vizinho" são perguntas DIFERENTES — com a mesma
 * chave, a resposta de uma valeria pela outra por até 30 s.
 */
function cacheKey(projectPath: string, exclude?: ReadonlySet<string>): string {
  return exclude && exclude.size ? `${projectPath} ${[...exclude].sort().join(',')}` : projectPath
}
```

E, dentro de `openCodeEngine`:

```ts
  latestConversationId(projectPath: string, exclude?: ReadonlySet<string>): string | null {
    // Lê direto do SQLite do opencode (read-only, sem subprocesso). Antes rodava
    // `opencode session list` + até 12 `opencode export` SÍNCRONOS dentro do
    // handler HTTP de histórico — pior caso ~56s congelando o servidor INTEIRO.
    const key = cacheKey(projectPath, exclude)
    const cached = latestConversationIdCache.get(key)
    if (cached && Date.now() - cached.at < LATEST_CONVERSATION_CACHE_TTL) return cached.value
    let result: string | null = null
    try {
      const db = new Database(opencodeDbPath(), { readonly: true, fileMustExist: true })
      try { result = queryLatestConversation(db, projectPath, exclude) } finally { db.close() }
    } catch { result = null } // db ausente/schema mudou/lock → sem preview (degradação graciosa)
    if (result) latestConversationIdCache.set(key, { at: Date.now(), value: result })
    return result
  },
  invalidateLatestConversation(projectPath: string): void {
    // Uma pasta tem várias entradas agora (uma por conjunto de exclusões): quem
    // invalida quer dizer "esta pasta mudou", e todas elas ficaram velhas juntas.
    for (const k of latestConversationIdCache.keys()) {
      if (k === projectPath || k.startsWith(`${projectPath} `)) latestConversationIdCache.delete(k)
    }
  },
```

- [ ] **Step 8: Rodar os testes das engines e ver passar**

Run: `npx vitest run test/claude-engine.test.ts test/codex-rollout.test.ts test/kimi-engine.test.ts test/opencode-engine.test.ts --root server`
Expected: PASS.

- [ ] **Step 9: Rodar a suíte do servidor**

Run: `npm test -w server`
Expected: PASS. Os dublês de engine em `test/engine-manager.test.ts:23` e `test/engine-registry.test.ts:10` usam `latestConversationId: () => null` — continuam válidos (o parâmetro é opcional); não mexa neles.

- [ ] **Step 10: Commit**

```bash
git add server/src/engine server/src/history.ts server/test
git commit -m "$(cat <<'EOF'
feat(engine): latestConversationId aceita ids a descartar

Duas entradas da sidebar podem apontar para a mesma pasta, e o storage
de cada engine é indexado por pasta. O parâmetro é opcional: pasta com
um terminal só não muda de comportamento. No OpenCode o exclude entra na
chave do cache — são perguntas diferentes.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: o terminal para de adotar a conversa do vizinho

Alimenta `project_threads` no único ponto que grava id de conversa, e corrige os pontos 3 e 4 do spec — `openInTerminal` e o `onExit`, que é o que hoje **grava** o id alheio no banco.

**Files:**
- Modify: `server/src/claude/manager.ts` (`persist` linha 156; `openInTerminal` linhas 558-567; `onExit` linhas 625-635)
- Test: `server/test/shared-folder.test.ts` (criar)

**Interfaces:**
- Consumes: `recordThread`, `foreignThreadIds` de `../project-threads.js` (Task 1); `latestConversationId(path, exclude)` (Task 3); `openDb` sem `UNIQUE` (Task 2).
- Produces: para as Tasks 5 e 6, `persist` passa a garantir que todo id gravado em `sessions` também está em `project_threads`.

- [ ] **Step 1: Escrever o teste que falha**

Criar `server/test/shared-folder.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type Db } from '../src/db.js'
import { createProjectsService } from '../src/projects.js'
import { createSessionManager } from '../src/claude/manager.js'
import { registerEngine, __resetRegistry } from '../src/engine/registry.js'
import type { Engine, EngineSession, EngineSessionOptions } from '../src/engine/types.js'
import { ownLatestThread } from '../src/project-threads.js'

/**
 * Dois terminais na mesma pasta.
 *
 * O storage de conversa das engines é indexado por PASTA, então tudo aqui gira
 * em torno de uma pergunta: quando o Claudinei pergunta "qual é a última
 * conversa desta pasta", ele aceita uma resposta que não é dele?
 */

/** Storage falso da engine: ids em ordem de uso, o mais recente por último. */
let storage: string[] = []
let abertas: EngineSessionOptions[] = []

/** Sessão inerte: o manager só precisa de status, sessionId e os dois eventos. */
class StubSession extends EventEmitter implements Partial<EngineSession> {
  status = 'starting' as any
  sessionId: string | undefined
  lastStderr = ''
  constructor(public opts: EngineSessionOptions) {
    super()
    // Espelha o Codex, que já conhece o id ao retomar (o Claude só no init).
    this.sessionId = opts.resumeSessionId
  }
  start(): void { this.status = 'idle'; this.emit('status', 'idle') }
  send(): void {}
  markRead(): void {}
  async interrupt(): Promise<void> {}
  async setModel(): Promise<void> {}
  async setPermissionMode(): Promise<void> {}
  async setEffort(): Promise<void> {}
  async stop(): Promise<void> { this.status = 'stopped'; this.emit('status', 'stopped') }
}

const fakeEngine: Engine = {
  id: 'fake' as any,
  bin: () => 'fake',
  createSession: (opts) => { abertas.push(opts); return new StubSession(opts) as unknown as EngineSession },
  readHistory: () => [],
  latestConversationId: (_p, exclude) => [...storage].reverse().find((id) => !exclude?.has(id)) ?? null,
  terminalCommand: (o) => ({ file: 'fake', args: o.resumeSessionId ? ['resume', o.resumeSessionId] : [] }),
  capabilities: () => ({ models: [], efforts: [], permissions: [], slashSource: 'none', label: 'Fake', icon: '?', slashCommands: [] }),
}

let db: Db
let pasta: string
let a: any
let b: any
let sozinho: any
let exits: Array<() => void>

beforeEach(() => {
  __resetRegistry()
  registerEngine(fakeEngine)
  storage = []
  abertas = []
  exits = []
  db = openDb(':memory:')
  const projects = createProjectsService(db)
  pasta = mkdtempSync(join(tmpdir(), 'juntos-'))
  a = projects.create({ name: 'A', path: pasta })
  b = projects.create({ name: 'B', path: pasta })
  sozinho = projects.create({ name: 'Só', path: mkdtempSync(join(tmpdir(), 'sozinho-')) })
})

afterEach(() => { __resetRegistry() })

const makeManager = () => createSessionManager({
  db,
  broadcast: () => {},
  terminalLauncher: (o) => { exits.push(o.onExit); return 'tok' },
})

const idNoBanco = (localId: string) =>
  (db.prepare('SELECT claude_session_id FROM sessions WHERE local_id=?').get(localId) as any)?.claude_session_id ?? null

describe('duas entradas na mesma pasta', () => {
  it('o id que a sessão grava passa a ser posse do projeto', async () => {
    const mgr = makeManager()
    const s = mgr.start(a, { engine: 'fake' })
    // A engine anuncia o id como o Codex faz: pelo status, via persist.
    db.prepare(`UPDATE sessions SET claude_session_id='conv-a' WHERE local_id=?`).run(s.localId)
    await mgr.openInTerminal(s.localId)
    expect(ownLatestThread(db, a.id, 'fake')).toBe('conv-a')
  })

  it('openInTerminal não retoma a conversa do vizinho', async () => {
    const mgr = makeManager()
    // O vizinho conversou: o id dele é o mais recente DA PASTA.
    const sb = mgr.start(b, { engine: 'fake' })
    db.prepare(`UPDATE sessions SET claude_session_id='conv-do-b' WHERE local_id=?`).run(sb.localId)
    await mgr.openInTerminal(sb.localId)
    storage.push('conv-do-b')

    // A nunca conversou: sem conversa própria, tem que abrir NOVA.
    const sa = mgr.start(a, { engine: 'fake' })
    await mgr.openInTerminal(sa.localId)
    expect(idNoBanco(sa.localId)).toBeNull()
  })

  it('onExit não grava no meu terminal o id do vizinho', async () => {
    const mgr = makeManager()
    const sa = mgr.start(a, { engine: 'fake' })
    db.prepare(`UPDATE sessions SET claude_session_id='conv-a' WHERE local_id=?`).run(sa.localId)
    await mgr.openInTerminal(sa.localId)
    storage.push('conv-a')

    const sb = mgr.start(b, { engine: 'fake' })
    db.prepare(`UPDATE sessions SET claude_session_id='conv-b' WHERE local_id=?`).run(sb.localId)
    await mgr.openInTerminal(sb.localId)
    storage.push('conv-b')

    // O terminal de A fecha DEPOIS de B ter conversado: a última conversa da
    // pasta é a de B, e é exatamente o que não pode entrar na linha de A.
    exits[0]()
    expect(idNoBanco(sa.localId)).toBe('conv-a')
  })

  it('sem conversa própria, onExit não inventa uma: preserva o que tinha (nada)', async () => {
    const mgr = makeManager()
    const sb = mgr.start(b, { engine: 'fake' })
    db.prepare(`UPDATE sessions SET claude_session_id='conv-b' WHERE local_id=?`).run(sb.localId)
    await mgr.openInTerminal(sb.localId)
    storage.push('conv-b')

    const sa = mgr.start(a, { engine: 'fake' })
    await mgr.openInTerminal(sa.localId)
    exits[1]()
    expect(idNoBanco(sa.localId)).toBeNull()
  })
})

describe('regressão: pasta com um terminal só', () => {
  it('openInTerminal ainda cai na última conversa da pasta quando não tem id', async () => {
    const mgr = makeManager()
    storage.push('conv-que-estava-la')
    const s = mgr.start(sozinho, { engine: 'fake' })
    await mgr.openInTerminal(s.localId)
    expect(idNoBanco(s.localId)).toBe('conv-que-estava-la')
  })

  it('onExit ainda adota o thread novo que o TUI criou', async () => {
    const mgr = makeManager()
    const s = mgr.start(sozinho, { engine: 'fake' })
    db.prepare(`UPDATE sessions SET claude_session_id='conv-velha' WHERE local_id=?`).run(s.localId)
    await mgr.openInTerminal(s.localId)
    // O TUI grava num transcript NOVO: é o que o chat web precisa passar a ler.
    storage.push('conv-do-tui')
    exits[0]()
    expect(idNoBanco(s.localId)).toBe('conv-do-tui')
  })
})
```

- [ ] **Step 2: Rodar o teste e ver falhar**

Run: `npx vitest run test/shared-folder.test.ts --root server`
Expected: FAIL — `ownLatestThread` volta `null` (nada alimenta `project_threads`) e os casos de vizinho gravam/retomam `conv-do-b`/`conv-b`.

- [ ] **Step 3: `persist` registra a posse**

Em `server/src/claude/manager.ts`, no topo, acrescentar ao bloco de imports:

```ts
import { recordThread, foreignThreadIds, ownLatestThread, isSharedPath } from '../project-threads.js'
```

> `ownLatestThread` e `isSharedPath` só são usados na Task 5; importe-os já para não tocar o bloco duas vezes.

Substituir `persist`:

```ts
  const persist = (localId: string, status: SessionStatus, engineSessionId: string | null) => {
    deps.db.prepare(
      `UPDATE sessions SET status=?, claude_session_id=COALESCE(?, claude_session_id), updated_at=datetime('now') WHERE local_id=?`,
    ).run(status, engineSessionId, localId)
    // Único lugar que grava um id de conversa em `sessions` (o UPDATE ... = NULL
    // de resolveResume só descarta id fantasma), e por isso o único lugar de onde
    // a posse do thread precisa sair. Vai para project_threads porque a linha da
    // sessão não sobrevive: a limpeza mantém só 5 finalizadas por projeto.
    if (!engineSessionId) return
    const row = deps.db.prepare('SELECT project_id, engine FROM sessions WHERE local_id=?').get(localId) as any
    if (row) recordThread(deps.db, row.project_id, row.engine ?? DEFAULT_ENGINE_ID, engineSessionId)
  }
```

- [ ] **Step 4: `openInTerminal` e `onExit` passam o `exclude`**

No fallback de `openInTerminal` (linhas 559-567), trocar a linha do `latestConversationId`:

```ts
      if (!resumeId) {
        try {
          const eng = getEngine(engineId)
          // O storage da engine muda fora do Claudinei (TUI cria sessão só na 1ª
          // mensagem): sem invalidar o cache, retomaríamos um id de até 30 s atrás.
          eng.invalidateLatestConversation?.(project.path)
          // Sem o exclude, "a última conversa desta pasta" seria a do terminal
          // vizinho — que é o caso em que ele acabou de conversar.
          resumeId = eng.latestConversationId(project.path, foreignThreadIds(deps.db, row.project_id, engineId))
        } catch { resumeId = null }
      }
```

No `onExit` (linhas 625-633), o mesmo:

```ts
              let latest: string | null = null
              try {
                const eng = getEngine(engineId)
                // O TUI ACABOU de gravar no storage da engine: sem invalidar o
                // cache (OpenCode cacheia por 30 s), releríamos o id de antes do
                // terminal e o chat não veria o que foi conversado lá.
                eng.invalidateLatestConversation?.(project.path)
                latest = eng.latestConversationId(project.path, foreignThreadIds(deps.db, row.project_id, engineId))
              } catch { latest = null }
              // `?? resumeId`: nada achado significa "não sei", não "adote o que
              // apareceu". Era aqui que o id do vizinho entrava no banco de forma
              // permanente — os outros pontos só mostravam conversa alheia.
              const nextId = latest ?? resumeId
```

- [ ] **Step 5: Rodar o teste e ver passar**

Run: `npx vitest run test/shared-folder.test.ts --root server`
Expected: PASS (6 casos).

- [ ] **Step 6: Rodar a suíte do servidor**

Run: `npm test -w server`
Expected: PASS — com atenção a `terminal-manager.test.ts`, `terminal-e2e.test.ts` e `session-stop-terminal.test.ts`, que exercitam esse mesmo caminho.

- [ ] **Step 7: Commit**

```bash
git add server/src/claude/manager.ts server/test/shared-folder.test.ts
git commit -m "$(cat <<'EOF'
fix(terminal): parar de adotar a conversa do terminal vizinho

O onExit re-resolvia "a última conversa da pasta" e PERSISTIA o
resultado: com dois terminais na mesma pasta, o id do vizinho entrava no
banco de forma permanente. Agora as duas resoluções por pasta descartam
os threads dos outros projetos do mesmo caminho, e persist registra a
posse em project_threads.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: em pasta compartilhada, `--continue` vira `--resume` do thread próprio

Pontos 1 e 2 do spec: `start` e `revive`. Não existe `--continue` que saiba dizer "a última desta pasta, exceto as do vizinho" — então em pasta compartilhada a intenção "continuar" passa a ser "retomar a minha última conversa", e sem nenhuma, conversa nova.

**Files:**
- Modify: `server/src/claude/manager.ts` (`start` linhas 343-372; `revive` linhas 456-468)
- Test: `server/test/shared-folder.test.ts` (acrescentar casos)

**Interfaces:**
- Consumes: `ownLatestThread`, `isSharedPath` (Task 1, importados na Task 4).
- Produces: `sessions.claude_session_id` já preenchido no `INSERT` quando a sessão nasce retomando o thread próprio — é o que a Task 6 usa para a prévia funcionar antes da primeira mensagem.

- [ ] **Step 1: Escrever os testes que falham**

Acrescentar a `server/test/shared-folder.test.ts`:

```ts
describe('continuar conversa em pasta compartilhada', () => {
  it('nenhum dos dois cards recebe --continue', () => {
    const mgr = makeManager()
    mgr.start(a, { engine: 'fake', continueLatest: true })
    mgr.start(b, { engine: 'fake', continueLatest: true })
    expect(abertas.map((o) => o.continueLatest)).toEqual([undefined, undefined])
  })

  it('sem thread próprio, o card nasce em conversa nova', () => {
    const mgr = makeManager()
    // A conversa que existe na pasta é do vizinho.
    storage.push('conv-do-b')
    const s = mgr.start(a, { engine: 'fake', continueLatest: true })
    expect(abertas[0].resumeSessionId).toBeUndefined()
    expect(idNoBanco(s.localId)).toBeNull()
  })

  it('com thread próprio, retoma o SEU por id', async () => {
    const mgr = makeManager()
    const primeira = mgr.start(a, { engine: 'fake' })
    db.prepare(`UPDATE sessions SET claude_session_id='conv-a' WHERE local_id=?`).run(primeira.localId)
    await mgr.openInTerminal(primeira.localId) // passa por persist → registra a posse
    storage.push('conv-a')
    // E o vizinho conversou DEPOIS: na pasta, a mais recente é a dele.
    storage.push('conv-do-b')
    db.prepare(`INSERT INTO project_threads (project_id, engine, thread_id, seq) VALUES (?, 'fake', 'conv-do-b', 99)`).run(b.id)

    const s = mgr.start(a, { engine: 'fake', continueLatest: true })
    expect(abertas.at(-1)!.resumeSessionId).toBe('conv-a')
    // Gravado já no INSERT: sem isso o chat ficaria vazio até a 1ª mensagem.
    expect(idNoBanco(s.localId)).toBe('conv-a')
  })

  it('revive sem id próprio retoma o thread do projeto, nunca a última da pasta', async () => {
    const mgr = makeManager()
    const s = mgr.start(a, { engine: 'fake' })
    db.prepare(`UPDATE sessions SET claude_session_id='conv-a' WHERE local_id=?`).run(s.localId)
    await mgr.openInTerminal(s.localId)
    storage.push('conv-a')
    storage.push('conv-do-b')
    // A linha perdeu o id (servidor antigo, turno que não gravou), mas a POSSE
    // ficou registrada: é para isso que project_threads existe.
    db.prepare(`UPDATE sessions SET claude_session_id=NULL, status='stopped', continue_latest=1 WHERE local_id=?`).run(s.localId)

    abertas = []
    mgr.revive(s.localId)
    expect(abertas[0].resumeSessionId).toBe('conv-a')
    expect(abertas[0].continueLatest).toBe(false)
  })
})

describe('regressão: continuar conversa em pasta com um terminal só', () => {
  it('start ainda pede --continue à engine', () => {
    const mgr = makeManager()
    mgr.start(sozinho, { engine: 'fake', continueLatest: true })
    expect(abertas[0].continueLatest).toBe(true)
    expect(abertas[0].resumeSessionId).toBeUndefined()
  })

  it('revive sem id próprio ainda preserva a intenção de continuar', () => {
    const mgr = makeManager()
    const s = mgr.start(sozinho, { engine: 'fake', continueLatest: true })
    db.prepare(`UPDATE sessions SET status='stopped' WHERE local_id=?`).run(s.localId)
    abertas = []
    mgr.revive(s.localId)
    expect(abertas[0].continueLatest).toBe(true)
  })
})
```

- [ ] **Step 2: Rodar os testes e ver falhar**

Run: `npx vitest run test/shared-folder.test.ts --root server`
Expected: FAIL nos quatro casos novos de pasta compartilhada (`continueLatest` chega `true`, `resumeSessionId` chega `undefined`).

- [ ] **Step 3: Extrair o resolvedor do thread próprio**

Em `server/src/claude/manager.ts`, logo depois de `resolveResume` (linha 154):

```ts
  /**
   * A conversa PRÓPRIA deste terminal, para usar no lugar do `--continue` quando
   * a pasta é compartilhada.
   *
   * Não passa por `resolveResume` porque aqui a sessão pode nem existir ainda no
   * banco (é chamada de dentro do `start`, antes do INSERT) — e não haveria linha
   * para o UPDATE de descarte. As duas defesas que importam continuam: formato,
   * porque o id vai virar argv; e existência, porque um transcript que sumiu faz
   * o `--resume` morrer com "No conversation found".
   */
  const ownResume = (projectId: number, engineId: EngineId, projectPath: string): string | undefined => {
    const own = ownLatestThread(deps.db, projectId, engineId)
    if (!own || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(own)) return undefined
    const eng = getEngine(engineId)
    if (eng.conversationExists && !eng.conversationExists(projectPath, own)) return undefined
    return own
  }
```

- [ ] **Step 4: `start` traduz a intenção**

Em `start`, depois do bloco que rejeita sessão já aberta no terminal (linha 353) e antes de `const permissionMode`:

```ts
      // Em pasta compartilhada não existe "--continue desta pasta": a conversa
      // mais recente pode ser a do vizinho, e não há flag que saiba excluí-la. A
      // regra é uniforme para todos os cards da pasta, sem card privilegiado —
      // privilegiar o mais antigo não funcionaria, porque assim que o vizinho
      // conversa é a conversa DELE que o --continue traria.
      const shared = isSharedPath(deps.db, project.id)
      const continueLatest = shared ? false : !!opts?.continueLatest
      const sharedResume = shared && opts?.continueLatest
        ? ownResume(project.id, engine, project.path)
        : undefined
```

Trocar a chamada de `makeSession` e o `INSERT`:

```ts
      const session = makeSession(engine, {
        projectPath: project.path,
        resumeSessionId: sharedResume,
        continueLatest: continueLatest || undefined,
        permissionMode,
        model,
        effort: opts?.effort,
        hermes: deps.hermes ? { ...deps.hermes, projectId: project.id, engine } : undefined,
      })
      // O id vai no INSERT (e não só quando a engine anunciar): é o que faz o
      // effectiveEngineSessionId conhecê-lo de imediato, e com ele a prévia do
      // chat mostra a conversa retomada antes da primeira mensagem.
      deps.db.prepare(
        `INSERT INTO sessions (local_id, project_id, engine, status, permission_mode, model, continue_latest, effort, claude_session_id) VALUES (?, ?, ?, 'starting', ?, ?, ?, ?, ?)`,
      ).run(localId, project.id, engine, permissionMode, model ?? null, continueLatest ? 1 : 0, opts?.effort ?? null, sharedResume ?? null)
```

> `continueLatest: continueLatest || undefined` preserva o `undefined` que as engines recebiam quando a opção não vinha — `false` explícito seria equivalente hoje, mas manter a forma evita ruído em diffs de teste.

- [ ] **Step 5: `revive` traduz a intenção**

Substituir as linhas 456-463:

```ts
      // Fantasma (transcript sumiu) é descartado aqui também: sem isto, reviver o
      // chat caía no mesmo "No conversation found" do terminal.
      let reviveResume = resolveResume(engine, project.path, localId, row.claude_session_id ?? null)
      // Sem conversa própria para retomar, preserva a intenção original: sessão
      // nascida com --continue revive continuando a última conversa da pasta —
      // não uma conversa nova em branco.
      let reviveContinue: boolean | undefined = reviveResume ? undefined : row.continue_latest !== 0
      if (!reviveResume && isSharedPath(deps.db, row.project_id)) {
        // Em pasta compartilhada, "a última da pasta" é uma resposta errada:
        // tenta o thread deste projeto e, sem ele, abre conversa nova.
        reviveResume = ownResume(row.project_id, engine, project.path) ?? null
        reviveContinue = false
      }
      wire(localId, row.project_id, engine, makeSession(engine, {
        projectPath: project.path,
        resumeSessionId: reviveResume ?? undefined,
        continueLatest: reviveContinue,
```

- [ ] **Step 6: Rodar o teste e ver passar**

Run: `npx vitest run test/shared-folder.test.ts --root server`
Expected: PASS (12 casos).

- [ ] **Step 7: Rodar a suíte do servidor**

Run: `npm test -w server`
Expected: PASS — `manager.test.ts`, `engine-manager.test.ts`, `session-control.test.ts` e `routes-sessions.test.ts` cobrem `start`/`revive` e são os que mais sentem essa mudança.

- [ ] **Step 8: Commit**

```bash
git add server/src/claude/manager.ts server/test/shared-folder.test.ts
git commit -m "$(cat <<'EOF'
feat(sessions): em pasta compartilhada, continuar = retomar o thread próprio

Não existe --continue que exclua as conversas do vizinho, então a
intenção "continuar conversa" passa a ser "retomar a minha última",
uniforme para todos os cards da pasta — e conversa nova quando o card
ainda não tem thread. Pasta com um terminal só segue com --continue.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: a prévia do chat mostra a conversa que a sessão vai retomar

Ponto 5 do spec. Último lugar que resolve conversa por pasta.

**Files:**
- Modify: `server/src/routes/sessions.ts:187-205`
- Test: `server/test/routes-sessions.test.ts`

**Interfaces:**
- Consumes: `ownLatestThread`, `isSharedPath` (Task 1).
- Produces: nada para tarefas seguintes.

- [ ] **Step 1: Escrever o teste que falha**

Em `server/test/routes-sessions.test.ts`, seguindo o helper de app do arquivo (ele já monta o Fastify com `db` e `manager`):

```ts
  it('prévia de histórico em pasta compartilhada não devolve a conversa do vizinho', async () => {
    // Dois projetos na mesma pasta; o vizinho tem conversa, este não.
    const b = projects.create({ name: 'B', path: project.path })
    const s = manager.start(project as any, { engine: 'fake', continueLatest: true })
    db.prepare(`UPDATE sessions SET claude_session_id=NULL, continue_latest=1 WHERE local_id=?`).run(s.localId)
    db.prepare(`INSERT INTO project_threads (project_id, engine, thread_id, seq) VALUES (?, 'fake', 'conv-do-b', 1)`).run(b.id)

    const res = await app.inject({ method: 'GET', url: `/api/sessions/${s.localId}/history` })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
  })

  it('prévia de histórico em pasta compartilhada mostra o thread PRÓPRIO', async () => {
    projects.create({ name: 'B', path: project.path })
    const s = manager.start(project as any, { engine: 'fake', continueLatest: true })
    db.prepare(`UPDATE sessions SET claude_session_id=NULL, continue_latest=1 WHERE local_id=?`).run(s.localId)
    db.prepare(`INSERT INTO project_threads (project_id, engine, thread_id, seq) VALUES (?, 'fake', 'conv-minha', 1)`).run(project.id)

    const res = await app.inject({ method: 'GET', url: `/api/sessions/${s.localId}/history` })
    // O dublê de engine devolve um evento por id pedido — a asserção é sobre QUAL
    // id chegou ao readHistory.
    expect(lidos).toEqual(['conv-minha'])
  })
```

> Use o dublê de engine do próprio arquivo; se ele ainda não registrar o que `readHistory` recebeu, acrescente `readHistory: (_p, id) => { lidos.push(id); return [{ kind: 'user', message: { role: 'user', content: [{ type: 'text', text: id }] } } as any] }` e declare `let lidos: string[]` zerado no `beforeEach`. Um caso de regressão para pasta com um terminal só (`latestConversationId` da pasta continua sendo usado) já existe no arquivo — confirme que continua verde em vez de escrever outro.

- [ ] **Step 2: Rodar o teste e ver falhar**

Run: `npx vitest run test/routes-sessions.test.ts --root server`
Expected: FAIL — a rota chama `latestConversationId(project.path)` e devolve a conversa do vizinho.

- [ ] **Step 3: Implementar**

Em `server/src/routes/sessions.ts`, acrescentar ao bloco de imports:

```ts
import { ownLatestThread, isSharedPath } from '../project-threads.js'
```

E no ramo de prévia da rota de histórico:

```ts
    if (!info.engineSessionId) {
      // Preview: sessão iniciada com --continue ainda não emitiu o init (só vem
      // com a 1ª mensagem), mas o operador precisa se contextualizar. Mostra a
      // conversa que a sessão vai DE FATO retomar.
      const row = deps.db.prepare('SELECT continue_latest FROM sessions WHERE local_id=?').get(localId) as any
      if (!row?.continue_latest) return []
      // Em pasta compartilhada, "a mais recente da pasta" pode ser a do terminal
      // vizinho — e a sessão não vai retomá-la. Sem conversa própria, vazio é a
      // resposta honesta.
      const prev = isSharedPath(deps.db, info.projectId)
        ? ownLatestThread(deps.db, info.projectId, info.engine)
        : engine.latestConversationId(project.path)
      return prev ? (await engine.readHistory(project.path, prev)).slice(-HISTORY_EVENT_LIMIT) : []
    }
```

- [ ] **Step 4: Rodar o teste e ver passar**

Run: `npx vitest run test/routes-sessions.test.ts --root server`
Expected: PASS.

- [ ] **Step 5: Rodar a suíte do servidor**

Run: `npm test -w server`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/sessions.ts server/test/routes-sessions.test.ts
git commit -m "$(cat <<'EOF'
fix(history): prévia mostra a conversa que a sessão vai retomar

Em pasta compartilhada a prévia lia "a mais recente da pasta" — que pode
ser a do vizinho e não é o que a sessão retoma. Agora lê o thread do
próprio projeto, e vazio quando não há.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: criar terminal em pasta já usada passa a avisar, não a falhar

Hoje o modal mostra o erro cru do SQLite. Com o `UNIQUE` fora, o `INSERT` já passa; falta trocar o silêncio por um aviso de uma linha.

**Files:**
- Modify: `web/src/components/NewProjectModal.tsx`
- Modify: `web/src/i18n/en.ts`, `web/src/i18n/es.ts`, `web/src/i18n/pt-BR.ts` (bloco `modal`)
- Test: `web/src/test/new-project-modal.test.tsx`

**Interfaces:**
- Consumes: `useStore((s) => s.projects)` — `Project.path` já existe em `web/src/types.ts`.
- Produces: chave i18n `modal.sharedPathWarning`.

- [ ] **Step 1: Escrever o teste que falha**

Acrescentar a `web/src/test/new-project-modal.test.tsx`:

```ts
import { useStore } from '../store'
```

```ts
  it('pasta que já tem terminal: avisa, mas deixa criar', async () => {
    useStore.setState({ projects: [{ id: 9, name: 'Existente', path: '/home/u', color: '#fff', icon: '📁' } as any] })
    render(<NewProjectModal onClose={() => {}} />)
    fireEvent.change(screen.getByPlaceholderText('Nome do projeto'), { target: { value: 'Segundo' } })
    fireEvent.click(screen.getByText('Escolher pasta…'))
    await waitFor(() => screen.getByText('Selecionar esta pasta'))
    fireEvent.click(screen.getByText('Selecionar esta pasta'))
    await waitFor(() => screen.getByText(/já tem um terminal/i))
    // Aviso, não erro: o botão continua ativo.
    expect((screen.getByText('Criar') as HTMLButtonElement).disabled).toBe(false)
    useStore.setState({ projects: [] })
  })

  it('pasta livre não mostra aviso nenhum', async () => {
    useStore.setState({ projects: [{ id: 9, name: 'Outro', path: '/outro/lugar', color: '#fff', icon: '📁' } as any] })
    render(<NewProjectModal onClose={() => {}} />)
    fireEvent.click(screen.getByText('Escolher pasta…'))
    await waitFor(() => screen.getByText('Selecionar esta pasta'))
    fireEvent.click(screen.getByText('Selecionar esta pasta'))
    expect(screen.queryByText(/já tem um terminal/i)).toBeNull()
    useStore.setState({ projects: [] })
  })
```

- [ ] **Step 2: Rodar o teste e ver falhar**

Run: `npx vitest run src/test/new-project-modal.test.tsx --root web`
Expected: FAIL — o texto do aviso não existe na tela.

- [ ] **Step 3: Textos nos três idiomas**

`web/src/i18n/pt-BR.ts`, no bloco `modal`:

```ts
    sharedPathWarning: 'Esta pasta já tem um terminal. O novo começa em uma conversa nova, com contexto separado.',
```

`web/src/i18n/en.ts`:

```ts
    sharedPathWarning: 'This folder already has a terminal. The new one starts a fresh conversation, with separate context.',
```

`web/src/i18n/es.ts`:

```ts
    sharedPathWarning: 'Esta carpeta ya tiene un terminal. El nuevo empieza en una conversación nueva, con contexto separado.',
```

- [ ] **Step 4: Mostrar o aviso no modal**

Em `web/src/components/NewProjectModal.tsx`, junto dos outros `useStore`:

```ts
  // O banco não recusa mais pasta repetida (dois terminais na mesma pasta são
  // dois projetos). Quem cria duplicata por engano descobre aqui, e quem quer de
  // propósito só segue em frente.
  const pastaJaUsada = useStore((s) => !editProject && !!path && s.projects.some((p) => p.path === path))
```

E acima do `{error && ...}`:

```ts
          {pastaJaUsada && (
            <span style={{ color: 'var(--warn, #e0a83c)', fontSize: 13 }}>{t('modal.sharedPathWarning')}</span>
          )}
```

> Confirme em `web/src/styles.css` se `--warn` existe; se não, use `var(--text-dim)` em vez de inventar um token.

- [ ] **Step 5: Rodar o teste e ver passar**

Run: `npx vitest run src/test/new-project-modal.test.tsx --root web`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/NewProjectModal.tsx web/src/i18n web/src/test/new-project-modal.test.tsx
git commit -m "$(cat <<'EOF'
feat(web): avisa em vez de recusar pasta que já tem terminal

Dois terminais na mesma pasta agora são possíveis, então o modal troca o
erro cru do SQLite por um aviso de uma linha: o botão continua ativo.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: indicador de pasta compartilhada no cabeçalho do chat

Para o operador nunca se perguntar se está no card certo.

**Files:**
- Modify: `web/src/components/ChatView.tsx` (cabeçalho, por volta da linha 221)
- Modify: `web/src/styles.css`
- Modify: `web/src/i18n/{en,es,pt-BR}.ts` (bloco `chat`)
- Test: `web/src/test/chatview.test.tsx`

**Interfaces:**
- Consumes: `useStore((s) => s.projects)`.
- Produces: chaves i18n `chat.sharedPath` e `chat.sharedPathTitle`.

- [ ] **Step 1: Escrever o teste que falha**

Acrescentar a `web/src/test/chatview.test.tsx` (reaproveitando o helper de montagem do arquivo, que já popula `projects` e `sessions` no store):

```ts
  it('mostra o indicador quando outro terminal aponta para a mesma pasta', () => {
    montarChat({ projects: [
      { id: 1, name: 'A', path: '/tmp/juntos', color: '#fff', icon: '📁' },
      { id: 2, name: 'B', path: '/tmp/juntos', color: '#fff', icon: '📁' },
    ] })
    expect(screen.getByTestId('shared-path')).toBeTruthy()
  })

  it('pasta com um terminal só não mostra indicador', () => {
    montarChat({ projects: [{ id: 1, name: 'A', path: '/tmp/sozinho', color: '#fff', icon: '📁' }] })
    expect(screen.queryByTestId('shared-path')).toBeNull()
  })
```

> `montarChat` é o helper do arquivo; se ele fixar os projetos internamente, dê-lhe um parâmetro opcional que sobrescreva `projects` no `useStore.setState`.

- [ ] **Step 2: Rodar o teste e ver falhar**

Run: `npx vitest run src/test/chatview.test.tsx --root web`
Expected: FAIL — `Unable to find an element by: [data-testid="shared-path"]`.

- [ ] **Step 3: Textos nos três idiomas**

`pt-BR.ts`, bloco `chat`:

```ts
    sharedPath: 'pasta compartilhada',
    sharedPathTitle: 'Outro terminal aponta para esta mesma pasta. As conversas são separadas; os arquivos, não.',
```

`en.ts`:

```ts
    sharedPath: 'shared folder',
    sharedPathTitle: 'Another terminal points at this same folder. The conversations are separate; the files are not.',
```

`es.ts`:

```ts
    sharedPath: 'carpeta compartida',
    sharedPathTitle: 'Otro terminal apunta a esta misma carpeta. Las conversaciones son separadas; los archivos, no.',
```

- [ ] **Step 4: Implementar o indicador**

Em `web/src/components/ChatView.tsx`, junto dos outros `useStore` do componente:

```ts
  // Contagem, não `filter`: um selector que devolve array novo re-renderiza o
  // chat a cada atualização do store.
  const pastaCompartilhada = useStore((s) => s.projects.filter((p) => p.path === project?.path).length > 1)
```

> `project` é resolvido acima no componente; se a linha ficar antes dele, mova-a para depois — o `?.` cobre o intervalo em que ainda é `undefined`.

Dentro do `<span className="chat-header__project">`, depois do `<strong>`:

```tsx
          {pastaCompartilhada && (
            <span className="chat-header__shared" data-testid="shared-path" title={t('chat.sharedPathTitle')}>
              ⫽ {t('chat.sharedPath')}
            </span>
          )}
```

Em `web/src/styles.css`, junto de `.chat-header__project`:

```css
/* Discreto de propósito: é orientação, não alerta — a pasta compartilhada foi
   pedida pelo operador. */
.chat-header__shared { font-size: 11px; color: var(--text-dim); white-space: nowrap; }
```

- [ ] **Step 5: Rodar o teste e ver passar**

Run: `npx vitest run src/test/chatview.test.tsx --root web`
Expected: PASS.

- [ ] **Step 6: Rodar a suíte do web**

Run: `npm test -w web`
Expected: PASS.

- [ ] **Step 7: Verificar o build de tipos do web**

Run: `npx tsc --noEmit -p web`
Expected: sem erros — é o que pega chave i18n presente em `pt-BR.ts` e ausente de `en.ts`.

- [ ] **Step 8: Commit**

```bash
git add web/src/components/ChatView.tsx web/src/styles.css web/src/i18n web/src/test/chatview.test.tsx
git commit -m "$(cat <<'EOF'
feat(web): indicador de pasta compartilhada no cabeçalho do chat

Com dois cards apontando para a mesma pasta, o nome do terminal não basta
para o operador saber onde está.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: verificação de ponta a ponta, na máquina

O spec pede prova real: dois terminais na mesma pasta, conversa distinta em cada um, sobrevivendo a um reinício do serviço. Nenhuma suíte cobre isso — o que se testa aqui é o comportamento das CLIs de verdade.

**Files:**
- Nenhum arquivo de produção. Se algo falhar, a correção volta para a tarefa correspondente (com teste), não para cá.

**Interfaces:**
- Consumes: tudo das Tasks 1-8.

- [ ] **Step 1: Suíte completa e tipos**

```bash
npm test
npx tsc --noEmit -p web
```
Expected: PASS nas duas. A única falha aceitável é a intermitente de `routes-orchestrator.test.ts`; confirme rodando o arquivo isolado.

- [ ] **Step 2: Pedir autorização antes de tocar no serviço**

Empacotar, instalar em `release/` e reiniciar o serviço são três permissões distintas, e nenhuma está concedida de antemão — o restart mata o trabalho de outros agentes na máquina. Pergunte ao Danilo e espere a resposta. Se ele não autorizar agora, a tarefa para aqui: as Tasks 1-8 estão completas e testadas, e a verificação fica pendente.

- [ ] **Step 3: Subir a versão nova (só depois do "sim")**

Com autorização, siga o procedimento do projeto (`npm run package` → instalar em `release/` → reiniciar). Para achar o processo, `ss -ltnp | grep ':9177'` e use o PID — `pkill -f "tsx src/index.ts"` mata o próprio comando.

- [ ] **Step 4: Migração: conferir no banco de verdade**

```bash
node -e "const D=require('better-sqlite3');const db=new D(process.env.HOME+'/.claudinei/claudinei.db',{readonly:true});console.log(db.prepare('PRAGMA index_list(projects)').all());console.log(db.prepare('SELECT COUNT(*) n FROM projects').get());"
```
Expected: nenhum índice com `origin: 'u'` sobre `path`; `idx_projects_path` presente; a contagem de projetos igual à de antes. Confirme também que apareceu um arquivo `claudinei.db.bak-*` ao lado do banco.

> Ajuste o caminho do banco se a instalação usar outro (veja `config` do servidor). `sqlite3` não existe nesta máquina — o `node -e` acima é o caminho.

- [ ] **Step 5: Dois terminais, duas conversas (Playwright MCP)**

1. Abra a interface e crie um terminal novo apontando para uma pasta que já tem terminal. Confirme o aviso do modal e que o botão Criar funciona.
2. Confirme os dois cards na sidebar e o indicador `pasta compartilhada` no cabeçalho dos dois.
3. Converse no card 1 ("meu nome é UM, repita"), depois no card 2 ("meu nome é DOIS, repita").
4. Volte ao card 1 e pergunte "qual é o meu nome?". Expected: **UM**. No card 2, **DOIS**.
5. Abra o card 1 no terminal, converse lá, feche. Volte ao chat: o histórico do card 1 tem o que foi dito no terminal, e o card 2 segue intacto.
6. Reinicie o serviço (mesma autorização do passo 2) e repita o passo 4. Expected: cada card continua com o seu nome.

Screenshots do Playwright MCP só podem ser escritos dentro de `/home/coppi/Projects/61-Claudinei/claudinei`.

- [ ] **Step 6: Relatar**

Relate o que foi medido, com o resultado de cada passo. Falha em qualquer um volta para a tarefa de origem como teste novo — não conserte só na mão.

---

## Auto-revisão

**Cobertura do spec:** os cinco pontos de mistura estão nas Tasks 4 (3 e 4), 5 (1 e 2) e 6 (5). Migração, backup, detecção por estado, `foreign_key_check`, índice substituto e falha que não derruba o boot: Task 2. `project_threads`, `exclude` e `ownLatest`: Tasks 1 e 3. Interface (aviso, indicador, três idiomas): Tasks 7 e 8. Os quatro grupos de teste do spec: Tasks 2 (migração), 4-6 (isolamento, com regressão de pasta única), 7-8 (interface) e 9 (verificação real). Nada da seção "Fora de escopo" entrou.

**Dois desvios do spec, deliberados, e o porquê:**

1. **`project_threads` tem uma coluna `seq`** além de `seen_at`, e é `seq` que ordena. O spec ordenava por `seen_at DESC`, mas `datetime('now')` tem resolução de um segundo: dois registros no mesmo segundo empatam e "meu último thread" fica indefinido — em teste, intermitente. `seen_at` fica para leitura humana.
2. **`start` grava o id retomado no `INSERT` da sessão.** O spec não dizia isso, e sem ele a prévia do chat ficaria vazia até a primeira mensagem justamente nos cards que retomam por `--resume`. De brinde, o ponto 5 fica mais simples: a rota nem chega ao ramo de prévia quando há id.

**Premissa medida antes de escrever o plano:** o procedimento da Task 2 foi executado num SQLite em memória com o DDL real de `projects` (incluindo as colunas vindas de `ALTER TABLE`) e uma tabela filha com `ON DELETE CASCADE`. Resultado: o índice único desaparece, `PRAGMA foreign_key_check` volta vazio, a filha não perde linha, a FK dela continua escrita como `REFERENCES projects(id)` e o próximo id nasce acima do maior existente (`sqlite_sequence` atualizado pelo `INSERT` com id explícito). O que a medição também revelou está anotado no código do passo 4.

**Sem placeholders:** todo passo de código traz o código. Onde um teste depende de helper que já existe no arquivo (transcripts do Claude, rollouts do Codex, índice do Kimi, `opencode.db` fake, `montarChat`), o passo diz qual é e o que fazer se ele não existir ainda — escrever um helper fixo aqui arriscaria divergir do que está no arquivo.

**Consistência de nomes:** `recordThread`, `ownLatestThread`, `foreignThreadIds`, `isSharedPath` (Task 1) são usados com exatamente esses nomes nas Tasks 4, 5 e 6. `latestConversationId(projectPath, exclude?)` tem a mesma assinatura na interface, nas quatro engines e nos dois pontos de chamada. `ownResume` é interno ao manager e só a Task 5 o usa. `idx_projects_path` aparece com o mesmo nome no bloco de schema, na migração e no teste.
