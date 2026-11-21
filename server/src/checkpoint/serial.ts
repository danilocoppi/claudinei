/**
 * Fila única por chave (o repositório): as tarefas da mesma chave rodam uma
 * por vez, na ordem em que entraram; chaves diferentes rodam em paralelo. Uma
 * tarefa que falha não trava as seguintes.
 */
export function createSerialQueue() {
  // Última tarefa de cada chave, já "assentada" (nunca rejeita).
  const tails = new Map<string, Promise<void>>()

  function run<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    const prev = tails.get(key) ?? Promise.resolve()
    // fn() dentro do then: exceção síncrona vira rejeição desta tarefa.
    const job = prev.then(() => fn())
    const tail = job.then(() => undefined, () => undefined)
    tails.set(key, tail)
    void tail.then(() => { if (tails.get(key) === tail) tails.delete(key) })
    return job
  }

  /** Espera a chave (ou todas) esvaziar, inclusive o que entrar enquanto espera. */
  async function idle(key?: string): Promise<void> {
    if (key !== undefined) {
      for (let tail = tails.get(key); tail; tail = tails.get(key)) await tail
      return
    }
    while (tails.size) await Promise.all(tails.values())
  }

  return { run, idle }
}
