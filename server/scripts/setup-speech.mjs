// Baixa (1×) o modelo Parakeet v3 int8 e o libstdc++ portátil para ~/.claudinei/speech.
// Idempotente e atômico: baixa e extrai num diretório temporário DENTRO do destino-pai
// (mesmo filesystem), valida os arquivos essenciais e só então faz o rename final —
// uma extração interrompida nunca deixa um destino meio-instalado que passe no check.
// Requer curl e tar (validados na máquina alvo).
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'

const SPEECH_DIR = process.env.CLAUDINEI_SPEECH ?? join(homedir(), '.claudinei', 'speech')
const MODEL_URL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2'
const STDCXX_URL = 'https://conda.anaconda.org/conda-forge/linux-64/libstdcxx-ng-12.2.0-h46fd767_19.tar.bz2'
const MODEL_DIR = join(SPEECH_DIR, 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8')
const STDCXX_DIR = join(SPEECH_DIR, 'stdcxx')
const STDCXX_LIB = join(STDCXX_DIR, 'lib', 'libstdc++.so.6')

// Tudo que o transcriber exige (server/src/speech/paths.ts). A idempotência e a
// validação pós-extração checam TODOS — só tokens.txt aprovaria extração interrompida.
const MODEL_FILES = ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt']

mkdirSync(SPEECH_DIR, { recursive: true })

/** Baixa `url` p/ um tmp ao lado de `destDir`, extrai com flags defensivas, valida
 *  `expectedFiles` e faz rename atômico p/ `destDir`. Em falha, limpa o tmp e relança.
 *  `wrapper`: nome do dir de topo dentro do tarball (null = conteúdo solto na raiz). */
function installTarball({ url, curlExtra, wrapper, destDir, expectedFiles }) {
  const tmp = mkdtempSync(`${destDir}.tmp-`)
  try {
    const tarball = join(tmp, 'download.tar.bz2')
    execSync(`curl -L --fail ${curlExtra} -o "${tarball}" "${url}"`, { stdio: 'inherit' })
    // Quando houver hash confiável p/ fixar, um SHA-256 pinado do tarball entra
    // aqui (verificar ANTES de extrair; divergiu → falha sem tocar o destino).
    console.log('📦 extraindo…')
    const extractDir = wrapper ? tmp : join(tmp, 'extracted')
    if (!wrapper) mkdirSync(extractDir)
    execSync(`tar xjf "${tarball}" --no-same-owner --no-same-permissions -C "${extractDir}"`, { stdio: 'inherit' })
    rmSync(tarball)
    const extracted = wrapper ? join(tmp, wrapper) : extractDir
    const missing = expectedFiles.filter((f) => !existsSync(join(extracted, f)))
    if (missing.length > 0) throw new Error(`extração incompleta de ${url}: faltam ${missing.join(', ')}`)
    rmSync(destDir, { recursive: true, force: true }) // restos de tentativa antiga interrompida
    renameSync(extracted, destDir) // atômico: o tmp vive ao lado do destino (mesmo filesystem)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

if (MODEL_FILES.every((f) => existsSync(join(MODEL_DIR, f)))) {
  console.log(`✓ modelo já instalado em ${MODEL_DIR}`)
} else {
  console.log('⬇ baixando o modelo Parakeet v3 int8 (~630MB — só desta vez)…')
  installTarball({ url: MODEL_URL, curlExtra: '--progress-bar', wrapper: basename(MODEL_DIR), destDir: MODEL_DIR, expectedFiles: MODEL_FILES })
  console.log(`✓ modelo instalado em ${MODEL_DIR}`)
}

if (existsSync(STDCXX_LIB)) {
  console.log('✓ libstdc++ portátil já instalado')
} else {
  console.log('⬇ baixando libstdc++ portátil (GLIBCXX_3.4.30, p/ o runtime do sherpa)…')
  installTarball({ url: STDCXX_URL, curlExtra: '-s', wrapper: null, destDir: STDCXX_DIR, expectedFiles: [join('lib', 'libstdc++.so.6')] })
  console.log('✓ libstdc++ instalado')
}

console.log('🎤 setup de fala completo.')
