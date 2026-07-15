import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { speechPaths, speechInstalled } from '../src/speech/paths.js'
import { createSpeechService, type SpeechService } from '../src/speech/transcriber.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const FAKE_WORKER = join(__dirname, 'fake-speech-worker.mjs')

/**
 * Caminho real do libstdc++.so.6 usado por este próprio `node` (via `ldd`), se houver.
 * O transcriber.ts coloca o diretório do stdcxxLib do fixture no início do LD_LIBRARY_PATH
 * do worker filho; como o `node` deste ambiente é linkado dinamicamente contra libstdc++,
 * um arquivo vazio nesse caminho quebra o carregamento do PRÓPRIO node (mesmo no fake worker,
 * que não usa sherpa). Por isso o fixture usa uma cópia de uma lib real quando disponível.
 */
function findSystemLibstdcxx(): string | null {
  try {
    const out = execSync(`ldd ${process.execPath}`, { encoding: 'utf8' })
    const m = out.match(/libstdc\+\+\.so\.6 => (\S+)/)
    if (m && existsSync(m[1])) return m[1]
  } catch { /* ldd indisponível (ex.: não-Linux) */ }
  return null
}

const systemLibstdcxx = findSystemLibstdcxx()

/** Cria uma árvore speechDir completa (arquivos vazios) num tmp. */
function makeInstalled(): string {
  const dir = mkdtempSync(join(tmpdir(), 'speech-'))
  const p = speechPaths(dir)
  mkdirSync(p.modelDir, { recursive: true })
  mkdirSync(dirname(p.stdcxxLib), { recursive: true })
  for (const f of [p.encoder, p.decoder, p.joiner, p.tokens]) writeFileSync(f, '')
  // stdcxxLib precisa ser uma lib carregável de verdade (ver findSystemLibstdcxx acima).
  if (systemLibstdcxx) copyFileSync(systemLibstdcxx, p.stdcxxLib)
  else writeFileSync(p.stdcxxLib, '')
  return dir
}

const services: SpeechService[] = []
afterEach(async () => { for (const s of services.splice(0)) await s.stop() })

function makeService(speechDir: string, workerArgs: string[] = [], timeoutMs = 3000) {
  const svc = createSpeechService({
    speechDir,
    serverDir: join(__dirname, '..'),
    workerPath: FAKE_WORKER,
    nodeBin: process.execPath,
    timeoutMs,
    workerArgs,
  })
  services.push(svc)
  return svc
}

describe('speechPaths/speechInstalled', () => {
  it('monta os caminhos esperados', () => {
    const p = speechPaths('/base')
    expect(p.modelDir).toBe('/base/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8')
    expect(p.encoder).toBe(`${p.modelDir}/encoder.int8.onnx`)
    expect(p.decoder).toBe(`${p.modelDir}/decoder.int8.onnx`)
    expect(p.joiner).toBe(`${p.modelDir}/joiner.int8.onnx`)
    expect(p.tokens).toBe(`${p.modelDir}/tokens.txt`)
    expect(p.stdcxxLib).toBe('/base/stdcxx/lib/libstdc++.so.6')
  })
  it('instalado quando todos os arquivos existem; não instalado quando falta algum', () => {
    const dir = makeInstalled()
    expect(speechInstalled(dir)).toBe(true)
    rmSync(speechPaths(dir).tokens)
    expect(speechInstalled(dir)).toBe(false)
  })
})

describe('createSpeechService (com fake worker)', () => {
  it('transcreve: spawna o worker, espera ready e devolve o texto', async () => {
    const svc = makeService(makeInstalled())
    await expect(svc.transcribe('/tmp/a.wav')).resolves.toBe('transcrito:/tmp/a.wav')
  })
  it('serializa: duas chamadas concorrentes resolvem na ordem', async () => {
    const svc = makeService(makeInstalled())
    const [a, b] = await Promise.all([svc.transcribe('/t/1.wav'), svc.transcribe('/t/2.wav')])
    expect(a).toBe('transcrito:/t/1.wav')
    expect(b).toBe('transcrito:/t/2.wav')
  })
  it('erro do worker numa requisição rejeita só ela', async () => {
    const svc = makeService(makeInstalled())
    await expect(svc.transcribe('/t/ERRO.wav')).rejects.toThrow(/falha proposital/)
    await expect(svc.transcribe('/t/ok.wav')).resolves.toBe('transcrito:/t/ok.wav')
  })
  it('morte do filho rejeita pendentes e a próxima chamada re-spawna', async () => {
    const svc = makeService(makeInstalled())
    await expect(svc.transcribe('/t/MORRE.wav')).rejects.toThrow()
    await expect(svc.transcribe('/t/depois.wav')).resolves.toBe('transcrito:/t/depois.wav')
  })
  it('spawna o worker com PKG_EXECPATH=\'\' no env (regressão: evita que o pkg trate --speech-worker como caminho de arquivo — ver comentário em transcriber.ts)', async () => {
    const svc = makeService(makeInstalled())
    await expect(svc.transcribe('/t/ENV.wav')).resolves.toBe('pkgExecPath:')
  })
  it('installed() reflete o speechDir', () => {
    expect(makeService(makeInstalled()).installed()).toBe(true)
    expect(makeService(mkdtempSync(join(tmpdir(), 'vazio-'))).installed()).toBe(false)
  })
  it('requisição que nunca responde estoura o timeout e a fila segue viva', async () => {
    const svc = makeService(makeInstalled(), [], 300)
    await expect(svc.transcribe('/t/PENDURA.wav')).rejects.toThrow(/tempo limite/)
    await expect(svc.transcribe('/t/ok.wav')).resolves.toBe('transcrito:/t/ok.wav')
  })
  it('timeout de boot mata o filho e a próxima chamada re-spawna (não fica travado)', async () => {
    const dir = makeInstalled()
    const flag = join(dir, 'pronto.flag')
    const svc = makeService(dir, ['--ready-flag', flag], 400)
    // 1ª chamada: worker nunca fica pronto → timeout de boot (mensagem mapeia 504 na rota)
    await expect(svc.transcribe('/t/a.wav')).rejects.toThrow(/tempo limite/)
    // destrava o "modelo" e tenta de novo: sem o reset do estado, isto reusaria a
    // readyPromise rejeitada para sempre e falharia
    writeFileSync(flag, '')
    await expect(svc.transcribe('/t/b.wav')).resolves.toBe('transcrito:/t/b.wav')
  })
})
