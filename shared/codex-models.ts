import type { ModelCatalog, ModelOptions } from './engine-options.js'

/** Valores aceitos pela configuração da CLI; "auto" significa omitir o override. */
export const CODEX_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']

const regular = ['low', 'medium', 'high', 'xhigh']
const extended = [...regular, 'max']
const delegated = [...extended, 'ultra']
const modelOptions: Record<string, ModelOptions> = {
  'gpt-6-astra': { displayName: 'GPT-6-Astra', efforts: delegated, defaultEffort: 'medium' },
  'gpt-6-sol': { displayName: 'GPT-6-Sol', efforts: delegated, defaultEffort: 'medium' },
  'gpt-6-luna': { displayName: 'GPT-6-Luna', efforts: extended, defaultEffort: 'medium' },
  'gpt-5.6-sol': { displayName: 'GPT-5.6-Sol', efforts: delegated, defaultEffort: 'low' },
  'gpt-5.6-terra': { displayName: 'GPT-5.6-Terra', efforts: delegated, defaultEffort: 'medium' },
  'gpt-5.6-luna': { displayName: 'GPT-5.6-Luna', efforts: extended, defaultEffort: 'medium' },
  'gpt-5.5': { displayName: 'GPT-5.5', efforts: regular, defaultEffort: 'medium' },
}

/** Fallback verificado com model/list do codex-cli 0.156.1 em 2026-09-23.
 * A lista da conta/CLI prevalece, inclusive para modelos antigos ainda disponíveis.
 * https://learn.chatgpt.com/docs/models
 */
export const CODEX_FALLBACK_CATALOG: ModelCatalog = {
  models: ['', ...Object.keys(modelOptions)],
  efforts: ['auto', ...delegated],
  modelOptions,
  defaultModel: 'gpt-6-astra',
}
