import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { WsContext } from '../wsContext'
import { queueSeqOf, useStore, useEngineFor, useSessionSlashCommands, type FileMenuAction } from '../store'
import { addToQueue, checkUploads, uploadFile } from '../api'
import type { QueueVia } from '../types'
import { SessionControls } from './SessionControls'
import { GOAL_COMMAND, filterCommands } from '../slash'
import { readDraft, saveDraft } from '../drafts'
import { readStash, pushStash, takeStash, stashKey, type StashEntry } from '../stash'
import { StashMenu } from './StashMenu'
import { SlashMenu } from './SlashMenu'
import { MentionMenu } from './MentionMenu'
import { FileMentionMenu } from './FileMentionMenu'
import { applyFileMention, applyMention, dropFileMention, mentionAt } from '../mentions'
import { MicButton, type MicButtonHandle, type MicDeps } from './MicButton'
import { inShortcutScope, matchShortcut, useShortcutLabel } from '../shortcuts/active'
import { isLargePaste, pasteFileName } from '../paste'
import { mergeTranscript } from '../speech/insert'
import { lastUserTexts, historyStep } from '../chat/history'

/**
 * Tela estreita (o mesmo limiar do @media do CSS).
 *
 * Existe por UM motivo: escolher o placeholder. O texto de desktop termina em
 * "(arraste ou cole arquivos)" — dica que no celular nem se aplica — e ele
 * quebra em duas linhas num campo estreito. Como o campo usa
 * `field-sizing: content`, quem manda na altura do campo VAZIO é o placeholder:
 * o resultado era uma caixa de duas linhas antes de digitar qualquer coisa.
 */
function useTelaEstreita(): boolean {
  const mq = () => (typeof window !== 'undefined' ? window.matchMedia?.('(max-width: 768px)') : undefined)
  const [estreita, setEstreita] = useState(() => !!mq()?.matches)
  useEffect(() => {
    const m = mq()
    if (!m?.addEventListener) return
    const onChange = () => setEstreita(m.matches)
    m.addEventListener('change', onChange)
    return () => m.removeEventListener('change', onChange)
  }, [])
  return estreita
}

/** Token inline que marca a posição do anexo no texto até o envio. */
const token = (name: string) => `[📎 ${name}]`
/** O nome de dentro do token (`[📎 nome]` → `nome`). */
const tokenName = (tok: string) => /^\[📎 (.*)\]$/u.exec(tok)?.[1] ?? tok
/** Teto do POST /api/uploads/check; um guardado tem bem menos anexos que isso. */
const CHECK_MAX = 200

export function ChatInput({
  localId,
  disabled,
  micDeps,
}: {
  localId: string
  disabled: boolean
  /** Override de teste para as dependências do MicButton (deps reais por default). */
  micDeps?: MicDeps
}) {
  const { t } = useTranslation()
  const telaEstreita = useTelaEstreita()
  const ws = useContext(WsContext)
  const addLocalUserText = useStore((s) => s.addLocalUserText)
  const session = useStore((s) => s.sessions[localId])
  // Começa no que ficou escrito da última vez neste terminal. O componente é
  // remontado a cada troca (key={localId} no ChatView), então é aqui que o
  // rascunho volta.
  const [text, setText] = useState(() => readDraft(localId))
  const [uploading, setUploading] = useState(0)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [micError, setMicError] = useState<string | null>(null)
  const micBase = useRef<{ before: string; after: string } | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const areaRef = useRef<HTMLTextAreaElement>(null)
  // token → path; apagar o token do texto simplesmente deixa a entrada sem uso
  const attachments = useRef(new Map<string, string>())
  // índice atual no histórico de mensagens do usuário (↑/↓); null = fora do modo histórico
  const histIdxRef = useRef<number | null>(null)

  /**
   * Prompts guardados pela combinação de guardar. A chave é o TERMINAL (projeto
   * + motor), não a sessão: um /clear ou uma retomada trocam a sessão, e o
   * guardado fica.
   */
  const termKey = session ? stashKey(session.projectId, session.engine) : null
  const [stash, setStash] = useState<StashEntry[]>(() => (termKey ? readStash(termKey) : []))
  useEffect(() => { setStash(termKey ? readStash(termKey) : []) }, [termKey])
  const [stashOpen, setStashOpen] = useState(false)
  const [stashError, setStashError] = useState<string | null>(null)
  // A fila recusou o texto (cheia, grande demais): o texto volta ao campo e o motivo aparece.
  const [queueError, setQueueError] = useState<string | null>(null)
  const stashBtnRef = useRef<HTMLButtonElement>(null)
  // as dicas da tela mostram a combinação que está valendo (null: ação sem atalho)
  const atalhoEnviar = useShortcutLabel('chat.send')
  const atalhoFila = useShortcutLabel('chat.queue')
  const atalhoGuardar = useShortcutLabel('chat.stash')
  const dicaEnviar = [
    t('chat.sendHintEnter'),
    atalhoEnviar !== null && t('chat.sendHintAnywhere', { combo: atalhoEnviar }),
    atalhoFila !== null && t('chat.sendHintQueue', { combo: atalhoFila }),
  ].filter(Boolean).join(' · ')
  const dicaGuardados = atalhoGuardar === null
    ? t('stash.buttonNoKey', { count: stash.length })
    : t('stash.button', { count: stash.length, combo: atalhoGuardar })
  // checagem dos anexos de um guardado em andamento: outro guardar espera
  const restoring = useRef(false)
  const vivo = useRef(true)
  useEffect(() => { vivo.current = true; return () => { vivo.current = false } }, [])

  const editRequest = useStore((s) => s.editRequest)
  useEffect(() => {
    if (!editRequest || editRequest.localId !== localId) return
    setText(editRequest.text)
    histIdxRef.current = null
    setStashError(null)
    requestAnimationFrame(() => {
      const el = areaRef.current
      el?.focus()
      el?.setSelectionRange(el.value.length, el.value.length)
    })
  }, [editRequest?.seq])

  // Auto-resize: cresce de 1 até 10 linhas conforme o conteúdo; passou disso, rola.
  //
  // Era o MAIOR custo isolado do app (CPU profile na base real): `height='auto'`
  // seguido de `scrollHeight` força um reflow SÍNCRONO da página inteira — 2.000
  // nós e 29 blurs — e este componente é remontado a cada troca de terminal. Três
  // saídas, em ordem:
  //  1. Navegador com `field-sizing: content` dimensiona sozinho, via CSS (ver
  //     .chat-compose__area). Aqui o JS nem entra.
  //  2. Vazio ou de uma linha — o caso de toda troca de terminal — cabe numa linha
  //     por definição: nada a medir.
  //  3. Só com quebra de linha (ou texto que pode dobrar) é que se mede.
  const MAX_LINES = 10
  const LINE_H = 24
  useEffect(() => {
    const el = areaRef.current
    if (!el) return
    if ('fieldSizing' in el.style) return
    if (!text.includes('\n') && text.length < 80) {
      el.style.height = ''
      el.style.overflowY = 'hidden'
      return
    }
    el.style.height = 'auto'
    const max = LINE_H * MAX_LINES + 20 // + padding vertical
    const h = el.scrollHeight
    el.style.height = `${Math.min(h, max)}px`
    el.style.overflowY = h > max ? 'auto' : 'hidden'
  }, [text])
  // Fonte da lista dirigida pela engine da sessão: protocolo (Claude), curada
  // (ex.: Codex) ou nenhuma — ver useSessionSlashCommands (store.ts).
  const slashCommands = useSessionSlashCommands(session)
  const engine = useEngineFor(session)
  /**
   * Fila do operador deste terminal. Kimi e OpenCode recusam mensagem no meio
   * do turno: trabalhando, o Enter deles vai para a fila. No Claude e no Codex o
   * Enter continua entrando no turno atual — mensagem nova é ACRÉSCIMO, nunca
   * cancelamento — e quem quer a fila usa a combinação da fila.
   */
  const termQueue = useStore((s) => (termKey ? s.queues[termKey] : undefined))
  const enterQueues = session?.status === 'working' && !engine?.midTurnInput
  const [activeIndex, setActiveIndex] = useState(0)
  /** Aberta pelo `@@`: com quem este terminal vai falar. */
  const [mencaoAberta, setMencaoAberta] = useState(false)
  const [fileCursor, setFileCursor] = useState<number | null>(null)
  const fileSelection = useRef<number | null>(null)
  // Ctrl+Shift+V: até este instante (Date.now), o próximo paste entra como
  // texto, por maior que seja. O evento paste não diz que tecla o disparou,
  // então o keydown marca e o paste consome.
  const colarComoTexto = useRef(0)
  useLayoutEffect(() => {
    if (fileSelection.current === null || fileCursor !== null) return
    const cursor = fileSelection.current
    fileSelection.current = null
    const el = areaRef.current
    // Restaura após o commit, antes de outra digitação poder mudar a seleção.
    el?.focus({ preventScroll: true }); el?.setSelectionRange(cursor, cursor)
  }, [text, fileCursor])
  const [slashDismissed, setSlashDismissed] = useState(false)

  const addLocalItem = useStore((s) => s.addLocalItem)

  /**
   * Grava o rascunho a cada mudança — de qualquer origem: digitação, ditado,
   * anexo, histórico, slash. São sete caminhos que mexem no texto, e pendurar a
   * gravação em cada um deles seria esquecer um.
   *
   * Campo vazio APAGA o rascunho (ver drafts.ts), então enviar já limpa sozinho:
   * o envio zera o texto, e isto grava o zerado.
   */
  useEffect(() => { saveDraft(localId, text) }, [localId, text])

  /**
   * Põe na fila do terminal o texto já pronto (tokens trocados pelos caminhos).
   * O campo limpa na hora; se a fila recusar, o texto e os anexos voltam.
   * `via`: a combinação da fila (de propósito) ou Enter com o motor ocupado
   * (sai como mensagem do operador e pausa o goal).
   */
  const enqueue = (out: string, via: QueueVia) => {
    if (!session) return
    const { projectId, engine: motor } = session
    const antes = { text, anexos: [...attachments.current] }
    setText('')
    histIdxRef.current = null
    setUploadError(null); setQueueError(null); setStashError(null)
    attachments.current.clear()
    // Um `operator_queue` que chegue antes da resposta é mais novo que ela: a resposta fica de fora.
    const seq = queueSeqOf(projectId, motor)
    addToQueue(projectId, motor, out, via)
      .then((q) => useStore.getState().applyQueueReply({ ...q, projectId, engine: motor }, seq))
      .catch((err) => {
        // Campo desmontado no meio: o texto volta como rascunho, para não se perder.
        if (!vivo.current) {
          if (!readDraft(localId).trim()) saveDraft(localId, antes.text)
          return
        }
        for (const [tok, path] of antes.anexos) attachments.current.set(tok, path)
        setText((atual) => (atual.trim() ? `${antes.text}\n${atual}` : antes.text))
        setQueueError((err as Error).message)
      })
  }

  /** `viaQueue`: a combinação da fila, que manda para a fila em qualquer motor. */
  const send = (viaQueue = false) => {
    let out = text
    for (const [tok, path] of attachments.current) out = out.split(tok).join(path)
    const trimmed = out.trim()
    if (!trimmed || uploading > 0) return

    // `!ls` é comando de terminal, não recado para a engine: roda na pasta do
    // terminal e a saída volta aqui, sem gastar um turno (nem token, nem espera).
    // Quem precisa começar a frase com "!" põe um espaço antes — o `out` cru é que
    // manda, porque o trim comeria justamente esse espaço.
    if (out.startsWith('!')) {
      const comando = trimmed.slice(1).trim()
      if (!comando) return
      ws?.send({ type: 'shell', localId, command: comando })
      addLocalItem(localId, { kind: 'local_command', command: comando })
      setText('')
      histIdxRef.current = null
      setStashError(null)
      attachments.current.clear()
      return
    }

    if (disabled) return
    if (viaQueue || enterQueues) { enqueue(trimmed, viaQueue ? 'alt-enter' : 'enter-busy'); return }
    ws?.send({ type: 'send_message', localId, text: trimmed })
    // O `/goal` é do Claudinei: o servidor o intercepta antes do agente, e nada
    // vai à conversa. Um balão otimista aqui seria falso (e sumiria no reload).
    if (!GOAL_COMMAND.test(trimmed)) addLocalUserText(localId, trimmed)
    setText('')
    histIdxRef.current = null
    setUploadError(null); setStashError(null)
    attachments.current.clear()
  }

  /**
   * Enviar — pelo Enter, pela combinação de enviar (de qualquer ponto da tela)
   * ou pelo botão.
   *
   * Ditando, a transcrição final ainda não está no campo: mandar agora levaria só
   * o parcial, e o final cairia depois no campo vazio, repetindo o que foi dito.
   * Então encerra a gravação e o envio sai quando o microfone termina (efeito
   * abaixo). Se a transcrição falhar, o envio é cancelado e o texto fica no campo.
   */
  const micRef = useRef<MicButtonHandle>(null)
  const [micBusy, setMicBusy] = useState(false)
  // O envio que espera o ditado terminar: 'queue' é a combinação da fila.
  const [enviarAposDitado, setEnviarAposDitado] = useState<false | 'send' | 'queue'>(false)
  const submit = (viaQueue = false) => {
    if (!micBusy) { send(viaQueue); return }
    setEnviarAposDitado(viaQueue ? 'queue' : 'send')
    micRef.current?.finish()
  }
  useEffect(() => {
    if (!enviarAposDitado || micBusy) return
    const viaQueue = enviarAposDitado === 'queue'
    setEnviarAposDitado(false)
    send(viaQueue)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `send` é recriado a cada render; o que importa é o render com o texto final
  }, [enviarAposDitado, micBusy])

  /**
   * Traz de volta o guardado do índice (ordem guardada: 0 = o mais antigo).
   *
   * Os anexos podem ter sumido (a rotação dos uploads apaga os antigos): antes de
   * devolver, pergunta ao servidor. O que sumiu volta MARCADO no texto e fica fora
   * do mapa de anexos — vai como texto, e o envio não quebra. Só tira o guardado
   * da lista depois da resposta: se o campo for desmontado no meio, nada se perde.
   */
  const restaurar = async (index: number) => {
    if (!termKey) return
    const entry = readStash(termKey)[index]
    if (!entry) return
    let missing = new Set<string>()
    const paths = [...new Set(entry.attachments.map(([, path]) => path))].slice(0, CHECK_MAX)
    if (paths.length) {
      restoring.current = true
      try {
        missing = new Set((await checkUploads(paths)).missing)
      } catch {
        // Sem resposta do servidor: devolve como estava. Na pior das hipóteses o
        // agente recebe um caminho que não existe — melhor que perder o anexo.
      } finally {
        restoring.current = false
      }
      if (!vivo.current) return
    }
    const atual = readStash(termKey)
    const i = atual.findIndex((e) => e.savedAt === entry.savedAt && e.text === entry.text)
    if (i < 0) return // outra aba já o tirou
    takeStash(termKey, i)
    setStash(readStash(termKey))

    let out = entry.text
    for (const [tok, path] of entry.attachments) {
      if (missing.has(path)) out = out.split(tok).join(`[📎 ${tokenName(tok)} — ${t('stash.missing')}]`)
      else attachments.current.set(tok, path)
    }
    // Campo com texto (escolha pelo menu, ou digitação durante a checagem): o
    // guardado entra depois, sem apagar o que já estava escrito.
    setText((atualTxt) => (atualTxt.trim() ? `${atualTxt}\n${out}` : out))
    histIdxRef.current = null
    requestAnimationFrame(() => {
      const el = areaRef.current
      el?.focus()
      el?.setSelectionRange(el.value.length, el.value.length)
    })
  }

  /**
   * A combinação de guardar no campo: com texto, guarda (com os anexos) e
   * limpa; vazio, traz o último. Com upload ou ditado em andamento não faz
   * nada — o texto ainda teria token sem caminho, ou a transcrição cairia depois
   * no campo já limpo. Quem chama já barrou a tecla no navegador.
   */
  const guardarOuTrazer = () => {
    if (!termKey || uploading > 0 || micBusy || restoring.current) return
    if (!text.trim()) {
      const lista = readStash(termKey)
      if (lista.length) void restaurar(lista.length - 1)
      return
    }
    // Só os anexos cujo token ainda está no texto: apagar o token não limpa o mapa.
    const anexos = [...attachments.current].filter(([tok]) => text.includes(tok))
    // Não gravou (armazenamento cheio ou bloqueado): o campo fica como está, com
    // os anexos valendo. Limpar aqui seria perder o texto sem rastro.
    if (!pushStash(termKey, { text, attachments: anexos, savedAt: Date.now() })) {
      setStashError(t('stash.saveFailed'))
      return
    }
    setStashError(null)
    setStash(readStash(termKey))
    setText('')
    histIdxRef.current = null
    attachments.current.clear()
  }

  // A combinação de enviar, de qualquer ponto da tela (escopo do registro). No
  // próprio campo quem trata é o onKeyDown, e pular aqui evita enviar duas
  // vezes; num outro campo de digitação o atalho é dele.
  const submitRef = useRef(submit)
  submitRef.current = submit
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!matchShortcut(e, 'chat.send')) return
      const campo = areaRef.current
      if (e.target === campo || !inShortcutScope('chat.send', e.target, campo)) return
      e.preventDefault()
      submitRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const stopTurn = () => { if (session?.status === 'working') ws?.send({ type: 'interrupt', localId }) }

  const attachFiles = async (files: FileList | File[]) => {
    const list = Array.from(files)
    if (!list.length) return
    // posição do cursor no momento do gesto — os tokens entram ali
    let pos = areaRef.current?.selectionStart ?? text.length
    for (const file of list) {
      setUploading((n) => n + 1)
      try {
        // imagem colada do clipboard vem com nome genérico — dá um nome útil
        const isPastedImage = file.name === 'image.png' || file.name === ''
        const name = isPastedImage ? `colado-${new Date().toTimeString().slice(0, 8).replace(/:/g, '')}.png` : undefined
        const saved = await uploadFile(file, name)
        const tok = token(saved.name)
        attachments.current.set(tok, saved.path)
        setText((t) => {
          const at = Math.min(pos, t.length)
          const next = `${t.slice(0, at)}${tok}${t.slice(at)}`
          pos = at + tok.length
          return next
        })
        setUploadError(null)
      } catch (err) {
        setUploadError((err as Error).message)
      } finally {
        setUploading((n) => n - 1)
      }
    }
  }

  /**
   * Os terminais que dá para referenciar: todos, menos este.
   *
   * Mandar tarefa para si mesmo não é colaboração — é uma volta ao próprio
   * terminal, e o servidor a entregaria à sessão que a pediu.
   */
  // Os dois valores vêm CRUS do store e o filtro acontece aqui. Filtrar dentro do
  // seletor devolveria um array novo a cada leitura, e o zustand — que compara por
  // identidade — entenderia "mudou" para sempre: render infinito.
  const todosProjetos = useStore((s) => s.projects)
  const meuProjeto = useStore((s) => (localId ? s.sessions[localId]?.projectId : undefined))
  const projetosParaMencao = useMemo(
    () => todosProjetos.filter((p) => p.id !== meuProjeto),
    [todosProjetos, meuProjeto],
  )

  const escolheMencao = (nome: string) => {
    const el = areaRef.current
    const cursor = el?.selectionStart ?? text.length
    const r = applyMention(el?.value ?? text, cursor, nome)
    setText(r.text)
    setMencaoAberta(false)
    // O cursor tem de ir para depois da referência: sem isto ele volta ao fim do
    // texto, e quem estava escrevendo no meio da frase perde o lugar.
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(r.cursor, r.cursor)
    })
  }

  const closeFiles = (restoreFocus: boolean) => {
    setFileCursor(null)
    if (restoreFocus) areaRef.current?.focus({ preventScroll: true })
  }
  const chooseFile = (path: string) => {
    if (fileCursor === null) return
    const el = areaRef.current
    const next = applyFileMention(el?.value ?? text, fileCursor, path)
    fileSelection.current = next.cursor
    setText(next.text)
    setFileCursor(null)
  }
  /** Abriu ou copiou o arquivo pelo seletor: nada foi referenciado, o `@!` sai. */
  const fileActionDone = (action: FileMenuAction) => {
    if (fileCursor === null) return
    const el = areaRef.current
    const next = dropFileMention(el?.value ?? text, fileCursor)
    // O popup leva o foco; nos outros casos o cursor volta para onde estava o `@!`.
    if (action !== 'popup') fileSelection.current = next.cursor
    setText(next.text)
    setFileCursor(null)
  }
  const openReference = (value: string, cursor: number) => {
    if (mentionAt(value, cursor, '@!') !== null && meuProjeto !== undefined) {
      setMencaoAberta(false); setFileCursor(cursor)
    } else if (mentionAt(value, cursor) !== null) {
      setFileCursor(null); setMencaoAberta(true)
    }
  }

  const slashQuery = /^\/\S*$/.test(text) ? text.slice(1) : null
  const slashMatches = slashQuery !== null ? filterCommands(slashCommands, slashQuery) : []
  const slashOpen = !disabled && !slashDismissed && histIdxRef.current === null && slashMatches.length > 0
  const pickSlash = (cmd: string) => {
    setText(`/${cmd} `)
    setStashError(null)
    setSlashDismissed(true)
    areaRef.current?.focus()
  }

  // captura a base (texto + cursor) a partir do valor VIVO do textarea — evita
  // base stale entre gravações rápidas (o MicButton reabilita antes do onDone
  // anterior) e é usada tanto no início de cada gravação quanto no fallback
  // defensivo de applyTranscript (nunca a partir do `text` do closure, que pode
  // estar desatualizado).
  const captureMicBase = () => {
    const el = areaRef.current
    const val = el?.value ?? text
    const pos = el?.selectionStart ?? val.length
    micBase.current = { before: val.slice(0, pos), after: val.slice(pos) }
  }
  const startMic = () => { captureMicBase(); setMicError(null); setMicBusy(true) }

  // Os trechos transcritos substituem a mesma região da base, crescendo ao vivo.
  // A base normalmente já foi fixada por startMic (onStart); o guard abaixo é só
  // um fallback defensivo caso, por algum motivo, onStart não tenha rodado.
  // endMic zera para a próxima gravação.
  const applyTranscript = (tx: string) => {
    if (!micBase.current) captureMicBase() // fallback defensivo, também do valor vivo
    const { before, after } = micBase.current!
    setText(mergeTranscript(before, after, tx))
    setMicError(null)
  }
  const endMic = () => { micBase.current = null; setMicBusy(false) }

  /**
   * O rodapé publica a própria altura para quem flutua por cima da tela.
   *
   * A pílula da ação minimizada mora no canto inferior direito, que é exatamente
   * onde ficam o campo, o 🎤, o ⚙ e o Send — e ela caía em cima deles. Um `bottom`
   * cravado não resolveria: este rodapé CRESCE conforme se digita, então numa
   * mensagem de várias linhas a colisão voltaria. Publicando a altura medida, quem
   * está por cima se afasta na medida certa, e acompanha o campo crescendo.
   */
  const footRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = footRef.current
    if (!el) return
    const publica = () => document.documentElement.style.setProperty('--chat-foot-h', `${el.offsetHeight}px`)
    publica()
    const obs = new ResizeObserver(publica)
    obs.observe(el)
    // Some ao desmontar: fora do chat não há rodapé, e uma altura fantasma deixaria
    // a pílula flutuando no meio do nada.
    return () => { obs.disconnect(); document.documentElement.style.removeProperty('--chat-foot-h') }
  }, [])

  return (
    <div ref={footRef} className="chat-foot">
      {/* Classe, não `style` inline: no celular esta linha precisa QUEBRAR (campo
          em cima, botões embaixo), e regra inline vence media query — com o
          estilo aqui dentro o mobile não tinha como reorganizar nada. */}
      <div className="chat-compose">
        {slashOpen && (
          <SlashMenu items={slashMatches} activeIndex={Math.min(activeIndex, slashMatches.length - 1)} onPick={pickSlash} />
        )}
        {mencaoAberta && (
          <MentionMenu
            projects={projetosParaMencao}
            onPick={escolheMencao}
            onClose={() => { setMencaoAberta(false); areaRef.current?.focus() }}
          />
        )}
        {fileCursor !== null && meuProjeto !== undefined && !disabled && (
          <FileMentionMenu projectId={meuProjeto}
            projectName={todosProjetos.find(project => project.id === meuProjeto)?.name ?? './'}
            localId={localId} anchorRef={areaRef} onPick={chooseFile} onAction={fileActionDone} onClose={closeFiles} />
        )}
        <textarea
          ref={areaRef}
          className={`chat-compose__area ${dragOver ? 'drag-over' : ''}`}
          rows={1}
          placeholder={
            uploading > 0 ? t('chat.placeholderUploading')
            // Pergunta pendente ANTES de "working": o turno ainda está aberto
            // enquanto ela espera, mas o lugar certo pra responder é o painel acima.
            : session?.pendingQuestion ? t('chat.placeholderQuestion')
            : enterQueues && termQueue?.paused ? t('queue.placeholderPaused')
            : enterQueues ? t('queue.placeholderQueue')
            : session?.status === 'working' ? t('chat.placeholderWorking')
            : t(telaEstreita ? 'chat.placeholderShort' : 'chat.placeholder', { engine: engine?.label ?? 'Claude Code' })
          }
          value={text}
          disabled={disabled}
          onChange={(e) => {
            setText(e.target.value)
            setSlashDismissed(false); setActiveIndex(0); histIdxRef.current = null
            setStashError(null); setQueueError(null)
            // `@@` abre terminais; `@!` abre arquivos. A conferência é pela
            // POSIÇÃO DO CURSOR, não pelo texto inteiro: um gatilho mais atrás
            // na frase já foi resolvido ou foi descartado, e reabrir a lista por
            // causa dele atrapalharia quem só está escrevendo.
            if (!(e.nativeEvent as InputEvent).isComposing) openReference(e.target.value, e.target.selectionStart ?? 0)
          }}
          onCompositionEnd={(e) => openReference(e.currentTarget.value, e.currentTarget.selectionStart)}
          // clicar fora fecha o menu; a seleção usa onMouseDown+preventDefault,
          // então clicar num item NÃO dispara este blur antes do pick.
          onBlur={() => setSlashDismissed(true)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return
            // Guardar: sempre barra a tecla (no padrão, o "salvar página"), mesmo quando ignorado.
            if (matchShortcut(e, 'chat.stash')) {
              e.preventDefault(); guardarOuTrazer(); return
            }
            // Ctrl+Shift+V: só marca; o navegador cola (sem preventDefault).
            if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'v') {
              colarComoTexto.current = Date.now() + 1000; return
            }
            if (slashOpen) {
              if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIndex((i) => (i + 1) % slashMatches.length); return }
              if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIndex((i) => (i - 1 + slashMatches.length) % slashMatches.length); return }
              if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') { e.preventDefault(); pickSlash(slashMatches[Math.min(activeIndex, slashMatches.length - 1)]); return }
              if (e.key === 'Escape') { e.preventDefault(); setSlashDismissed(true); return }
            }
            if (!slashOpen && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
              const inHistory = histIdxRef.current !== null
              if ((text === '' && e.key === 'ArrowUp') || inHistory) {
                e.preventDefault()
                const list = lastUserTexts(useStore.getState().chat[localId] ?? [], 5)
                const step = historyStep(list, histIdxRef.current, e.key === 'ArrowUp' ? 'up' : 'down')
                histIdxRef.current = step.index
                setText(step.text)
                setStashError(null)
                return
              }
            }
            if (e.key === 'Escape' && session?.status === 'working') { e.preventDefault(); stopTurn(); return }
            // A combinação da fila: para a fila, em qualquer motor. Com upload em
            // andamento o send ignora (o texto ainda teria token sem caminho), como o Enter.
            if (matchShortcut(e, 'chat.queue')) { e.preventDefault(); submit(true); return }
            if (matchShortcut(e, 'chat.send')) { e.preventDefault(); submit(); return }
            // Enter puro (sem Ctrl, ⌘, Alt nem Shift) envia. Com modificador e fora
            // das combinações acima, não: com a fila em outra tecla, o Alt+Enter
            // antigo não manda a mensagem na hora sem querer.
            if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) { e.preventDefault(); submit() }
          }}
          onPaste={(e) => {
            const comoTexto = Date.now() <= colarComoTexto.current
            colarComoTexto.current = 0 // vale para um paste só
            if (e.clipboardData?.files?.length) { e.preventDefault(); void attachFiles(e.clipboardData.files); return }
            if (comoTexto) return
            // texto grande vira anexo .txt; o campo recebe só o token
            const colado = e.clipboardData?.getData('text/plain') ?? ''
            if (isLargePaste(colado)) {
              e.preventDefault()
              void attachFiles([new File([colado], pasteFileName(), { type: 'text/plain' })])
            }
          }}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault(); setDragOver(false)
            if (e.dataTransfer?.files?.length) void attachFiles(e.dataTransfer.files)
          }}
        />
        {session?.status === 'working' && (
          <button type="button" className="input-action stop-btn"
                  aria-label={t('chat.stop')} title={t('chat.stop')} onClick={stopTurn}>■</button>
        )}
        {stash.length > 0 && (
          <button ref={stashBtnRef} type="button" className="input-action stash-btn" data-testid="stash-btn"
                  aria-haspopup="menu" aria-expanded={stashOpen} disabled={disabled}
                  aria-label={dicaGuardados} title={dicaGuardados}
                  onClick={() => {
                    // relê: outra aba pode ter guardado ou tirado algum
                    if (termKey) setStash(readStash(termKey))
                    setStashOpen((o) => !o)
                  }}>
            🗂<span className="stash-btn__count">{stash.length}</span>
          </button>
        )}
        {stashOpen && stash.length > 0 && (
          <StashMenu
            entries={stash}
            anchorRef={stashBtnRef}
            onPick={(i) => {
              setStashOpen(false)
              if (uploading > 0 || micBusy || restoring.current) return
              void restaurar(i)
            }}
            onClose={() => { setStashOpen(false); areaRef.current?.focus() }}
          />
        )}
        <MicButton
          ref={micRef}
          disabled={disabled}
          onText={applyTranscript}
          onDone={endMic}
          onError={(msg) => { setMicError(msg); setEnviarAposDitado(false) }}
          onStart={startMic}
          field={areaRef}
          deps={micDeps}
        />
        {session && <SessionControls session={session} />}
        <button className="chat-send" onClick={() => submit()} disabled={disabled || uploading > 0}
                title={dicaEnviar}>{t('common.send')}</button>
      </div>
      {(uploadError || micError || stashError || queueError) && (
        <div style={{ color: 'var(--err)', fontSize: 12, marginTop: 6 }}>⚠ {uploadError ?? micError ?? stashError ?? queueError}</div>
      )}
    </div>
  )
}
