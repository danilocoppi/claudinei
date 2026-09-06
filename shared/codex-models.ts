import type { ModelCatalog, ModelOptions } from './engine-options.js'

/** Valores aceitos pela configuração da CLI; "auto" significa omitir o override. */
export const CODEX_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']

const regular = ['low', 'medium', 'high', 'xhigh']
const extended = [...regular, 'max']
const delegated = [...extended, 'ultra']
const modelOptions: Record<string, ModelOptions> = {
  'gpt-6-astra': { efforts: delegated, defaultEffort: 'low' },
  'gpt-5.6-sol': { efforts: delegated, defaultEffort: 'low' },
  'gpt-5.6-terra': { efforts: delegated, defaultEffort: 'medium' },
  'gpt-5.6-luna': { efforts: extended, defaultEffort: 'medium' },
  'gpt-5.5': { efforts: regular, defaultEffort: 'medium' },
  'gpt-5.4-mini': { efforts: regular, defaultEffort: 'medium' },
}

/** Fallback verificado com codex-cli 0.153.4 em 2026-09-06. model/list prevalece. */
export const CODEX_FALLBACK_CATALOG: ModelCatalog = {
  models: ['', ...Object.keys(modelOptions)],
  efforts: ['auto', ...delegated],
  modelOptions,
  defaultModel: 'gpt-6-astra',
}
