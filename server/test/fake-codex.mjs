#!/usr/bin/env node
// App Server fake: um processo, vários turnos, notificações intercaladas com RPC.
import { createInterface } from 'node:readline'
let threadId = 'THREAD-FAKE', turn = 0, current, total = 0, context = 0
let timer
let steered = []
const writerConflict = process.argv.find((a) => a.startsWith('--writer-conflict='))?.split('=')[1]
let refusals = 0
// Turnos da conversa em memória (thread/turns/list, thread/revert) e os pedidos de volta (test/calls).
let turns = [], forks = 0
const calls = []
const pageSize = Number(process.argv.find((a) => a.startsWith('--page-size='))?.split('=')[1]) || 0
const userItem = (text) => ({ type: 'userMessage', id: `u-${turn}-${Math.random().toString(36).slice(2, 8)}`, clientId: null, content: [{ type: 'text', text, text_elements: [] }] })
const out = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')
const reply = (id, result) => out({ id, result })
const notify = (method, params) => out({ method, params: { threadId, ...params } })
const counts = (n) => ({ totalTokens: n, inputTokens: n - 10, cachedInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 3 })
const usage = () => notify('thread/tokenUsage/updated', { tokenUsage: { total: counts(total), last: counts(context), modelContextWindow: 400000 } })
const started = () => { current = `turn-${++turn}`; turns.push({ id: current, items: [] }); notify('turn/started', { turn: { id: current, status: 'inProgress' } }); return current }
const completed = (status = 'completed', error) => { notify('turn/completed', { turn: { id: current, status, error } }); current = undefined }
const answerSteer = (text) => {
  notify('item/completed', { item: { id: 'steered', type: 'agentMessage', text } })
  completed()
}
// developerInstructions da thread (Claudinei passa a regra do terminal errado por aqui).
let developerInstructions = null
createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params: p } = JSON.parse(line)
  if (method === 'initialize') reply(id, { userAgent: 'fake' })
  else if (method === 'config/read') reply(id, { config: { model: 'default-model', model_reasoning_effort: 'medium', ...(process.argv.includes('--dev-instructions') ? { developer_instructions: 'INSTRUÇÕES DO OPERADOR' } : {}) } })
  else if (method === 'thread/start' || method === 'thread/resume') {
    // Outro Codex com a conversa aberta: a CLI real recusa a retomada até soltá-la.
    if (method === 'thread/resume' && writerConflict && (writerConflict === 'always' || refusals < Number(writerConflict))) {
      refusals++
      out({ id, error: { code: -32600, message: `thread ${p.threadId} already has an active writer` } }); return
    }
    if (method === 'thread/resume' && process.argv.includes('--resume-missing')) {
      out({ id, error: { code: -32600, message: `no rollout found for thread id ${p.threadId}` } }); return
    }
    if (p.threadId) threadId = p.threadId
    developerInstructions = p.developerInstructions ?? null
    reply(id, { thread: { id: threadId }, model: p.model ?? 'default-model' })
    if (method === 'thread/resume') { total = 900000; context = 120000; usage() }
  } else if (method === 'turn/start') {
    const text = p.input[0].text
    if (text === '__crash__') { process.exit(1); return }
    const tid = started()
    turns.at(-1).items.push(userItem(text))
    reply(id, { turn: { id: tid } })
    if (text === '__hang__' || text === '__wait_for_steer__') return
    if (text === '__fail__') { completed('failed', { message: 'test turn failed' }); return }
    // Dados de subagente nunca pertencem à thread principal.
    out({ method: 'thread/tokenUsage/updated', params: { threadId: 'CHILD', tokenUsage: { total: counts(9999999), last: counts(999999), modelContextWindow: 1 } } })
    const answer = text === '__options__' ? JSON.stringify({ model: p.model, effort: p.effort })
      : text === '__instructions__' ? JSON.stringify(developerInstructions)
      : `echo:${text}`
    notify('item/agentMessage/delta', { delta: answer })
    notify('item/completed', { item: { id: 'answer', type: 'agentMessage', text: answer } })
    context = text === '__large__' ? 300000 : 120000
    total += context
    usage(); completed()
  } else if (method === 'turn/steer') {
    if (process.argv.includes('--crash-steer')) { process.exit(1); return }
    if (!current || p.expectedTurnId !== current) {
      out({ id, error: { code: -32600, message: 'no matching active turn' } }); return
    }
    if (process.argv.includes('--reject-steer-race')) {
      completed()
      out({ id, error: { code: -32600, message: 'turn already completed' } }); return
    }
    if (process.argv.includes('--reject-steer')) {
      out({ id, error: { code: -32601, message: 'steer unavailable' } })
      timer = setTimeout(() => completed(), 60); return
    }
    const tid = current
    steered.push(p.input[0].text)
    turns.find((t) => t.id === tid)?.items.push(userItem(p.input[0].text))
    const acknowledge = () => reply(id, { turnId: tid })
    if (process.argv.includes('--delayed-steer-ack')) {
      answerSteer(JSON.stringify(steered)); setTimeout(acknowledge, 60); return
    }
    acknowledge()
    if (p.input[0].text !== 'first') answerSteer(JSON.stringify(steered))
  } else if (method === 'thread/compact/start') {
    if (process.argv.includes('--compact-error')) { out({ id, error: { code: -32601, message: 'compaction unavailable' } }); return }
    started(); reply(id, {})
    notify('item/started', { item: { id: 'compact', type: 'contextCompaction' } })
    if (process.argv.includes('--hang-compact')) return
    timer = setTimeout(() => {
      context = process.argv.includes('--keep-large') ? 300000 : 30000
      total += 1000
      if (process.argv.includes('--usage-before-complete')) usage()
      notify('item/completed', { item: { id: 'compact', type: 'contextCompaction' } })
      if (!process.argv.includes('--usage-before-complete')) usage()
      completed()
    }, 80)
  } else if (method === 'turn/interrupt') {
    clearTimeout(timer); reply(id, {}); completed('interrupted')
  } else if (method === 'thread/turns/list') {
    calls.push({ method, params: p })
    const desc = [...turns].reverse()
    const start = p.cursor ? Number(p.cursor) : 0
    const size = pageSize || p.limit || 20
    const data = desc.slice(start, start + size).map((t) => ({ id: t.id, items: p.itemsView === 'full' ? t.items : [], itemsView: p.itemsView ?? 'summary', status: 'completed', error: null }))
    reply(id, { data, nextCursor: start + size < desc.length ? String(start + size) : null, backwardsCursor: null })
  } else if (method === 'thread/revert') {
    calls.push({ method, params: p })
    // Conversa do formato antigo: a CLI real recusa o revert.
    if (process.argv.includes('--refuse-revert')) { out({ id, error: { code: -32600, message: 'thread/revert requires a paginated thread' } }); return }
    const at = turns.findIndex((t) => t.id === p.beforeTurnId)
    if (at < 0) { out({ id, error: { code: -32600, message: `turn ${p.beforeTurnId} not found` } }); return }
    turns = turns.slice(0, at)
    reply(id, { thread: { id: threadId, turns: [] }, turnsBackwardsCursor: null, itemsBackwardsCursor: null })
    notify('thread/reverted', {})
  } else if (method === 'thread/fork') {
    calls.push({ method, params: p })
    // CLI 0.159.2: conversa paginada só aceita fork com excludeTurns.
    if (!p.excludeTurns) { out({ id, error: { code: -32600, message: 'ephemeral paginated thread/fork requires `excludeTurns: true`' } }); return }
    reply(id, { thread: { id: `FORK-${++forks}`, turns: [] }, model: 'default-model' })
  } else if (method === 'test/calls') reply(id, calls)
  else if (method === 'test/pid') reply(id, { pid: process.pid })
})
