// Baixa (1×) o modelo Parakeet v3 int8 e o libstdc++ portátil para ~/.claudinei/speech.
// Idempotente: pula o que já existe. Requer curl e tar (validados na máquina alvo).
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const SPEECH_DIR = process.env.CLAUDINEI_SPEECH ?? join(homedir(), '.claudinei', 'speech')
const MODEL_URL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2'
const STDCXX_URL = 'https://conda.anaconda.org/conda-forge/linux-64/libstdcxx-ng-12.2.0-h46fd767_19.tar.bz2'
const MODEL_DIR = join(SPEECH_DIR, 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8')
const STDCXX_LIB = join(SPEECH_DIR, 'stdcxx', 'lib', 'libstdc++.so.6')

mkdirSync(SPEECH_DIR, { recursive: true })

if (existsSync(join(MODEL_DIR, 'tokens.txt'))) {
  console.log(`✓ modelo já instalado em ${MODEL_DIR}`)
} else {
  console.log('⬇ baixando o modelo Parakeet v3 int8 (~630MB — só desta vez)…')
  execSync(`curl -L --fail --progress-bar -o model.tar.bz2 "${MODEL_URL}"`, { cwd: SPEECH_DIR, stdio: 'inherit' })
  console.log('📦 extraindo…')
  execSync('tar xjf model.tar.bz2 && rm model.tar.bz2', { cwd: SPEECH_DIR, stdio: 'inherit' })
  console.log(`✓ modelo instalado em ${MODEL_DIR}`)
}

if (existsSync(STDCXX_LIB)) {
  console.log('✓ libstdc++ portátil já instalado')
} else {
  console.log('⬇ baixando libstdc++ portátil (GLIBCXX_3.4.30, p/ o runtime do sherpa)…')
  mkdirSync(join(SPEECH_DIR, 'stdcxx'), { recursive: true })
  execSync(`curl -L --fail -s -o stdcxx.tar.bz2 "${STDCXX_URL}"`, { cwd: SPEECH_DIR, stdio: 'inherit' })
  execSync('tar xjf stdcxx.tar.bz2 -C stdcxx && rm stdcxx.tar.bz2', { cwd: SPEECH_DIR, stdio: 'inherit' })
  console.log('✓ libstdc++ instalado')
}

console.log('🎤 setup de fala completo.')
