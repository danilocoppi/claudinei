export interface ModelOptions {
  efforts: string[]
  defaultEffort: string
}

export interface ModelCatalog {
  models: string[]
  efforts: string[]
  modelOptions?: Record<string, ModelOptions>
  /** Modelo usado quando a sessão deixa a escolha para a configuração da CLI. */
  defaultModel?: string
}

export function effortsForModel(catalog: ModelCatalog | undefined, model?: string | null): string[] {
  const options = catalog?.modelOptions?.[model || catalog.defaultModel || '']
  return options ? ['auto', ...options.efforts] : catalog?.efforts ?? []
}
