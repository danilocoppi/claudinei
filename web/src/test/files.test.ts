import { describe, it, expect, vi, afterEach } from 'vitest'
import { extractCandidatePaths, resolveFiles, fileContentUrl } from '../files'

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
