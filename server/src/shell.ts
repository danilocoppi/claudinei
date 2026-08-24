import { spawn } from 'node:child_process'
import { desktopEnv } from './localApps.js'

/**
 * O `!comando` do chat: um atalho para olhar a pasta sem pedir à engine.
 *
 * Não amplia o que já era possível — os agentes rodam com
 * `--dangerously-skip-permissions`, então quem consegue conversar com um terminal
 * já consegue pedir "roda ls" e obter o mesmo. O que muda é a fricção. Ainda
 * assim a rota só aceita da máquina do servidor, e aqui há dois tetos, porque uma
 * conversa não é um terminal: ela não tem como você apertar Ctrl-C.
 */
export interface ShellResult {
  /** stdout e stderr juntos, na ordem em que saíram — como se lê num terminal. */
  output: string
  isError: boolean
  truncated: boolean
  timedOut: boolean
}

/** Um `cat` de arquivo grande não pode virar uma mensagem de dezenas de MB. */
export const MAX_OUTPUT = 64 * 1024
/** Sem isto, um `tail -f` prenderia a conversa até alguém reiniciar o serviço. */
const TIMEOUT_MS = 30_000

export interface ShellDeps {
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
}

export async function runShell(command: string, cwd: string, deps: ShellDeps = {}): Promise<ShellResult> {
  const cmd = command.trim()
  if (!cmd) return { output: 'comando vazio', isError: true, truncated: false, timedOut: false }

  const platform = deps.platform ?? process.platform
  // Shell de VERDADE: pipe, glob e `&&` são o motivo de o atalho existir. O
  // comando vai como UM argumento, então não há concatenação a escapar — quem
  // digita já está digitando shell, conscientemente.
  const [bin, flag] = platform === 'win32' ? ['cmd.exe', '/c'] : ['/bin/bash', '-lc']

  return await new Promise<ShellResult>((resolve) => {
    const child = spawn(bin, [flag, cmd], {
      cwd,
      // Grupo próprio: `bash -lc` cria filhos, e no timeout é o GRUPO que precisa
      // morrer — senão o `sleep` fica órfão segurando os canos. Sem `detached`, o
      // filho ficaria no grupo do SERVIDOR e o `kill(-pid)` não teria alvo certo.
      detached: true,
      // Ambiente do SISTEMA: o libstdc++ portátil que o Claudinei carrega é mais
      // velho que o do sistema, e herdá-lo mata programas gráficos no arranque
      // (ver desktopEnv — foi o que fazia "Abrir terminal" não abrir nada).
      env: desktopEnv(deps.env ?? process.env),
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let saida = ''
    let truncated = false
    let timedOut = false

    const junta = (b: Buffer) => {
      if (truncated) return
      saida += b.toString()
      if (saida.length > MAX_OUTPUT) {
        saida = `${saida.slice(0, MAX_OUTPUT)}\n… (saída cortada em ${Math.round(MAX_OUTPUT / 1024)} KB)`
        truncated = true
        child.kill('SIGKILL')
      }
    }
    child.stdout.on('data', junta)
    child.stderr.on('data', junta)

    const relogio = setTimeout(() => {
      timedOut = true
      // SIGKILL no GRUPO: `bash -lc` cria filhos, e matar só o shell deixaria o
      // `sleep` órfão segurando os canos abertos.
      try { process.kill(-child.pid!, 'SIGKILL') } catch { child.kill('SIGKILL') }
    }, deps.timeoutMs ?? TIMEOUT_MS)

    const fim = (code: number | null) => {
      clearTimeout(relogio)
      if (timedOut) saida += `\n… (interrompido: passou de ${Math.round((deps.timeoutMs ?? TIMEOUT_MS) / 1000)}s)`
      resolve({
        output: saida.trim() || (code === 0 ? '(sem saída)' : `(sem saída — código ${code})`),
        isError: timedOut || (code !== 0 && !truncated),
        truncated,
        timedOut,
      })
    }
    child.once('close', fim)
    child.once('error', (e: Error) => {
      clearTimeout(relogio)
      resolve({ output: e.message, isError: true, truncated: false, timedOut: false })
    })
  })
}
