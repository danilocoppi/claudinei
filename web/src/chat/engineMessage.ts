// Só chamado para mensagens cuja autoria já foi identificada pela engine.
// Não altera o texto guardado no histórico e preserva exemplos dentro de código.
const ENVELOPES = /<\/?(?:skills_instructions|multi_agent_role|multi_agent_mode|recommended_plugins|environment_context|permissions|collaboration_mode|collaboration_instructions|environment_instructions)(?:\s[^>]*)?>/g

export function formatEngineMessage(text: string): string {
  let fence: { char: string; length: number } | undefined
  return text.split('\n').map((line) => {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/)
    if (marker) {
      if (!fence) fence = { char: marker[1][0], length: marker[1].length }
      else if (marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined
      return line
    }
    if (fence) return line
    // As tags de dados do ambiente ficam legíveis, sem perder valores ou paths.
    return line.replace(ENVELOPES, '\n')
      .replace(/<([a-z_]+)>([^<>]+)<\/\1>/g, (_all, name, value) => `${name}: ${value}`)
  }).join('\n').trim()
}

/** Fecha a cerca na prévia para que as reticências não fiquem dentro do código. */
export function collapseMarkdown(lines: string[], limit: number): string {
  const preview = lines.slice(0, limit)
  let fence: string | undefined
  let fenceStart = -1
  for (const [i, line] of preview.entries()) {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/)
    if (!marker) continue
    if (!fence) { fence = marker[1]; fenceStart = i }
    else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined
  }
  // A captura multi_agent_role corta justamente na abertura da cerca. Não
  // desenhar um bloco de código vazio nessa prévia.
  if (fence && preview.slice(fenceStart + 1).every((line) => !line.trim())) {
    preview.splice(fenceStart)
    fence = undefined
  }
  return preview.join('\n') + (fence ? `\n${fence}` : '') + '\n\n…'
}
