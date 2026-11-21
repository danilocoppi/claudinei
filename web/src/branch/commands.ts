import { fetchProjects } from '../api'
import { progressKey, useStore } from '../store'
import { forkTerminal, openSide } from './api'
import { setSideInfo, useSideStore } from './sideStore'

/**
 * `/side` e `/btw`: a conversa lateral. `/fork`: o terminal irmão com a cópia.
 * Comandos do Claudinei, não do motor: o campo os reconhece e chama a rota na
 * hora, sem fila e sem turno — inclusive no meio de um turno do Kimi ou do
 * OpenCode e com Alt+Enter. Sozinhos ou seguidos de espaço (não `/sidebar`).
 */
export const SIDE_COMMAND = /^\/(side|btw)(\s|$)/
export const FORK_COMMAND = /^\/fork(\s|$)/

export type BranchCommand = { kind: 'side'; text: string } | { kind: 'fork'; name: string }

/** O comando no texto já aparado do campo, ou null quando é mensagem comum. */
export function parseBranchCommand(text: string): BranchCommand | null {
  const side = SIDE_COMMAND.exec(text)
  if (side) return { kind: 'side', text: text.slice(side[1].length + 1).trim() }
  if (FORK_COMMAND.test(text)) return { kind: 'fork', name: text.slice('/fork'.length).trim() }
  return null
}

/**
 * Chama a rota do comando. Não lança: a recusa vai ao chat da principal como
 * saída de comando com erro, no idioma da tela. O `side_exists` é a exceção:
 * vira `replaceAsk`, e a coluna pergunta se fecha a lateral atual e abre outra.
 * Devolve `false` quando o comando falhou (o campo devolve o texto digitado).
 */
export async function runBranchCommand(cmd: BranchCommand, ctx: { localId: string; projectId: number; engine: string }): Promise<boolean> {
  const { localId, projectId, engine } = ctx
  try {
    if (cmd.kind === 'side') {
      const info = await openSide(projectId, engine, cmd.text.trim() ? cmd.text : undefined)
      // O `side_state` sai antes da resposta e costuma chegar primeiro, já mais
      // novo que ela. A resposta só entra quando o WebSocket não trouxe esta lateral.
      if (useSideStore.getState().sides[progressKey(projectId, engine)]?.info.id !== info.id) setSideInfo(info)
      return true
    }
    const { project, session } = await forkTerminal(projectId, engine, cmd.name.trim() || undefined)
    const { projects, setProjects, openSession } = useStore.getState()
    setProjects([...projects.filter((p) => p.id !== project.id), project])
    openSession(session.localId)
    // O ramo nasce logo abaixo do original e empurra as posições seguintes: a
    // lista do servidor traz a ordem nova. Sem ela, ao menos o ramo já está na lista.
    fetchProjects().then((list) => useStore.getState().setProjects(list)).catch(() => {})
    return true
  } catch (err) {
    const e = err as Error & { code?: string }
    if (cmd.kind === 'side' && e.code === 'side_exists') {
      // O texto fica com a pergunta da coluna, não volta ao campo.
      useSideStore.setState({ replaceAsk: { projectId, engine, text: cmd.text } })
      return true
    }
    useStore.getState().addLocalItem(localId, { kind: 'command_output', text: e.message, isError: true })
    return false
  }
}
