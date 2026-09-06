export interface BackgroundTask {
  id: string
  description: string
  /** Especialidade do subagente (Explore, general-purpose...), quando houver. */
  type: string
  prompt: string
  /** Tipo nativo da tarefa: local_agent, local_bash, local_workflow, etc. */
  taskType?: string
  ambient?: boolean
}

export function isBackgroundAgent(task: BackgroundTask): boolean {
  // Compatibilidade com snapshots anteriores, que só continham subagent_type.
  return !task.taskType || ['local_agent', 'remote_agent', 'in_process_teammate'].includes(task.taskType)
}
