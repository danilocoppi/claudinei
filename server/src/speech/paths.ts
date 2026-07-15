import { existsSync } from 'node:fs'
import { join } from 'node:path'

export const MODEL_DIR_NAME = 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8'

/** Caminhos dos artefatos de fala dentro do speechDir (~/.claudinei/speech). */
export function speechPaths(speechDir: string) {
  const modelDir = join(speechDir, MODEL_DIR_NAME)
  return {
    modelDir,
    encoder: join(modelDir, 'encoder.int8.onnx'),
    decoder: join(modelDir, 'decoder.int8.onnx'),
    joiner: join(modelDir, 'joiner.int8.onnx'),
    tokens: join(modelDir, 'tokens.txt'),
    stdcxxLib: join(speechDir, 'stdcxx', 'lib', 'libstdc++.so.6'),
  }
}

/** Todos os artefatos necessários já foram baixados? */
export function speechInstalled(speechDir: string): boolean {
  const p = speechPaths(speechDir)
  return [p.encoder, p.decoder, p.joiner, p.tokens, p.stdcxxLib].every((f) => existsSync(f))
}
