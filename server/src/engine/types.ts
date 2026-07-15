import type { EventEmitter } from 'node:events'
import type { ClaudeEvent } from '../claude/events.js'
import type { SessionStatus, HermesOptions } from '../claude/session.js'

/** Id de engine — aberto; a validade é "está registrado no registry?", nunca um union fechado. */
export type EngineId = string

/** Evento normalizado de agente. Hoje idêntico ao shape do Claude; o Codex normaliza para cá (SP-B). */
export type AgentEvent = ClaudeEvent

/** Opções genéricas para criar uma sessão de qualquer engine. */
export interface EngineSessionOptions {
  projectPath: string
  resumeSessionId?: string
  continueLatest?: boolean
  model?: string
  effort?: string
  permissionMode?: string
  hermes?: HermesOptions
  /** Binário da engine (Claude: config.claudeBin). Ausente → default da engine. */
  bin?: string
  /** Somente testes: substitui TODOS os args do processo (aponta para o fake). */
  extraArgsOverride?: string[]
}

/** Uma sessão viva. EventEmitter: o manager assina 'status' e 'event' e chama start(). */
export interface EngineSession extends EventEmitter {
  status: SessionStatus
  sessionId?: string
  readonly lastStderr: string
  start(): void
  send(text: string): void
  markRead(): void
  interrupt(): Promise<void>
  setModel(model: string): Promise<void>
  setPermissionMode(mode: string): Promise<void>
  setEffort(effort: string): Promise<void>
  stop(): Promise<void>
}

export interface EngineCapabilities {
  models: string[]
  efforts: string[]
  permissions: string[]
  slashSource: 'protocol' | 'curated' | 'none'
  label: string
  icon: string
  slashCommands: string[]
  /** Comando de instalação da CLI (mostrado na UI quando o binário não está no PATH). */
  installHint?: string
}

/** Uma engine (registrada uma vez). */
export interface Engine {
  id: EngineId
  /** Binário da CLI desta engine (resolvido de env) — usado p/ sondar disponibilidade no PATH. */
  bin(): string
  createSession(opts: EngineSessionOptions): EngineSession
  readHistory(projectPath: string, engineSessionId: string): AgentEvent[]
  latestConversationId(projectPath: string): string | null
  /** Comando do terminal interativo. resumeSessionId ausente/null → sessão NOVA (fresh), sem retomar. */
  terminalCommand(opts: { resumeSessionId?: string | null; projectPath: string; bin?: string }): { file: string; args: string[] }
  capabilities(): EngineCapabilities
}
