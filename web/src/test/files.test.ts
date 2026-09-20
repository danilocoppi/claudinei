import { describe, it, expect, vi, afterEach } from 'vitest'
import { extractCandidatePaths, resolveFiles, fileContentUrl, fetchTextFile, saveFileContent } from '../files'

const okJson = (body: object, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

afterEach(() => vi.restoreAllMocks())

describe('extractCandidatePaths', () => {
  it('acha path absoluto', () => {
    expect(extractCandidatePaths('veja /home/user/a.ts por favor')).toEqual(['/home/user/a.ts'])
  })

  it('acha path com ~', () => {
    expect(extractCandidatePaths('abre ~/docs/notas.md')).toEqual(['~/docs/notas.md'])
  })

  it('acha path relativo com pasta', () => {
    expect(extractCandidatePaths('em src/components/App.tsx tem um bug')).toEqual(['src/components/App.tsx'])
  })

  it('acha path absoluto dentro de subpasta', () => {
    expect(extractCandidatePaths('salvei em /tmp/x/img.png agora')).toEqual(['/tmp/x/img.png'])
  })

  it('acha múltiplos candidatos distintos', () => {
    const text = 'compara /home/user/a.ts com src/components/App.tsx e ~/docs/notas.md'
    expect(extractCandidatePaths(text).sort()).toEqual(
      ['/home/user/a.ts', 'src/components/App.tsx', '~/docs/notas.md'].sort(),
    )
  })

  it('ignora URLs https', () => {
    expect(extractCandidatePaths('veja https://site.com/logo.png')).toEqual([])
  })

  it('ignora URLs http', () => {
    expect(extractCandidatePaths('veja http://example.com/a/b/c.js')).toEqual([])
  })

  it('ignora palavras comuns sem path/extensão', () => {
    expect(extractCandidatePaths('isso é muito importante e legal')).toEqual([])
  })

  it('ignora e-mails', () => {
    expect(extractCandidatePaths('me escreve em danilo.coppi@gmail.com por favor')).toEqual([])
  })

  it('ignora trechos tipo a/b sem extensão', () => {
    expect(extractCandidatePaths('a relação entre a/b não é um path')).toEqual([])
  })

  it('ignora path absoluto sem extensão', () => {
    expect(extractCandidatePaths('olha em /usr e /home/user/docs')).toEqual([])
  })

  it('dedup: mesmo path repetido vira 1 candidato', () => {
    const text = '/home/user/a.ts é igual a /home/user/a.ts'
    expect(extractCandidatePaths(text)).toEqual(['/home/user/a.ts'])
  })

  it('não estoura em texto grande/estranho', () => {
    const big = 'blah '.repeat(50000) + '/home/user/a.ts' + ' blah'.repeat(50000)
    expect(() => extractCandidatePaths(big)).not.toThrow()
    expect(extractCandidatePaths(big)).toContain('/home/user/a.ts')
  })

  it('texto vazio devolve array vazio', () => {
    expect(extractCandidatePaths('')).toEqual([])
  })
})

describe('resolveFiles', () => {
  it('POSTa paths e projectId, devolve o array de resultados', async () => {
    const results = [{ path: '/home/user/a.ts', exists: true, inScope: true, kind: 'code', size: 10 }]
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson(results))
    await expect(resolveFiles(['/home/user/a.ts'], 1)).resolves.toEqual(results)
    expect(spy.mock.calls[0][0]).toBe('/api/files/resolve')
    const opts = spy.mock.calls[0][1] as RequestInit
    expect(opts.method).toBe('POST')
    expect(JSON.parse(opts.body as string)).toEqual({ paths: ['/home/user/a.ts'], projectId: 1 })
  })

  it('funciona sem projectId', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson([]))
    await expect(resolveFiles(['/a.ts'])).resolves.toEqual([])
  })
})

describe('fileContentUrl', () => {
  it('monta URL com path codificado e projectId', () => {
    expect(fileContentUrl('/home/user/a.ts', 1)).toBe('/api/files/content?path=%2Fhome%2Fuser%2Fa.ts&projectId=1')
  })

  it('monta URL sem projectId quando omitido', () => {
    expect(fileContentUrl('/home/user/a.ts')).toBe('/api/files/content?path=%2Fhome%2Fuser%2Fa.ts')
  })

  it('codifica caracteres especiais no path', () => {
    expect(fileContentUrl('/tmp/a b.md')).toBe('/api/files/content?path=%2Ftmp%2Fa%20b.md')
  })
})

import { resolvedKey } from '../files'
describe('resolvedKey (chave do cache de resolução)', () => {
  it('relativo carrega o projeto; absoluto e ~/ são globais', () => {
    expect(resolvedKey('docs/spec.md', 7)).toBe('7:docs/spec.md')
    expect(resolvedKey('/home/u/a.png', 7)).toBe('/home/u/a.png')
    expect(resolvedKey('~/notas.md', 7)).toBe('~/notas.md')
  })
  it('sem projeto, relativo fica como está (não há contra o que resolver)', () => {
    expect(resolvedKey('docs/spec.md')).toBe('docs/spec.md')
  })
})

describe('fetchTextFile', () => {
  it('sucesso: devolve texto e hash do header', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('# oi', {
      status: 200, headers: { 'X-Content-Hash': 'abc123' },
    }))
    expect(await fetchTextFile('/api/files/content?path=a.md')).toEqual({ ok: true, text: '# oi', hash: 'abc123' })
  })

  it('sem o header: hash null (o arquivo fica só de leitura)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('texto', { status: 200 }))
    expect(await fetchTextFile('/api/files/content?path=a.md')).toEqual({ ok: true, text: 'texto', hash: null })
  })

  it('erro HTTP: devolve o código', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 413 }))
    expect(await fetchTextFile('/api/files/content?path=a.md')).toEqual({ ok: false, code: 413 })
  })

  it('falha de rede: código 0', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'))
    expect(await fetchTextFile('/api/files/content?path=a.md')).toEqual({ ok: false, code: 0 })
  })
})

describe('saveFileContent', () => {
  it('manda path, projeto, conteúdo e baseHash, e devolve o hash novo', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({ hash: 'novo' }))
    const r = await saveFileContent({ path: 'doc.md', projectId: 3, content: 'texto', baseHash: 'velho' })
    expect(r).toEqual({ hash: 'novo' })
    const [url, init] = spy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/files/write')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ path: 'doc.md', projectId: 3, content: 'texto', baseHash: 'velho' })
  })

  it('409 vira Error com a mensagem stale', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({ error: 'stale' }, 409))
    await expect(saveFileContent({ path: 'doc.md', projectId: 3, content: 'x', baseHash: 'v' }))
      .rejects.toThrow('stale')
  })
})
