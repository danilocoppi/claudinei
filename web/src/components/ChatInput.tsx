import { useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { WsContext } from '../wsContext'
import { useStore, useEngineFor, useSessionSlashCommands } from '../store'
import { uploadFile } from '../api'
import { SessionControls } from './SessionControls'
import { filterCommands } from '../slash'
import { readDraft, saveDraft } from '../drafts'
import { SlashMenu } from './SlashMenu'
import { MentionMenu } from './MentionMenu'
import { applyMention, mentionAt } from '../mentions'
import { MicButton, type MicDeps } from './MicButton'
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

  const editRequest = useStore((s) => s.editRequest)
  useEffect(() => {
    if (!editRequest || editRequest.localId !== localId) return
    setText(editRequest.text)
    histIdxRef.current = null
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
  const [activeIndex, setActiveIndex] = useState(0)
  /** Aberta pelo `@@`: com quem este terminal vai falar. */
  const [mencaoAberta, setMencaoAberta] = useState(false)
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

  const send = () => {
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
      attachments.current.clear()
      return
    }

    if (disabled) return
    ws?.send({ type: 'send_message', localId, text: trimmed })
    addLocalUserText(localId, trimmed)
    setText('')
    histIdxRef.current = null
    setUploadError(null)
    attachments.current.clear()
  }

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

  const slashQuery = /^\/\S*$/.test(text) ? text.slice(1) : null
  const slashMatches = slashQuery !== null ? filterCommands(slashCommands, slashQuery) : []
  const slashOpen = !disabled && !slashDismissed && histIdxRef.current === null && slashMatches.length > 0
  const pickSlash = (cmd: string) => {
    setText(`/${cmd} `)
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
  const startMic = () => { captureMicBase(); setMicError(null) }

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
  const endMic = () => { micBase.current = null }

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
        <textarea
          ref={areaRef}
          className={`chat-compose__area ${dragOver ? 'drag-over' : ''}`}
          rows={1}
          placeholder={
            uploading > 0 ? t('chat.placeholderUploading')
            : session?.status === 'working' ? t('chat.placeholderWorking')
            : t(telaEstreita ? 'chat.placeholderShort' : 'chat.placeholder', { engine: engine?.label ?? 'Claude Code' })
          }
          value={text}
          disabled={disabled}
          onChange={(e) => {
            setText(e.target.value)
            setSlashDismissed(false); setActiveIndex(0); histIdxRef.current = null
            // `@@` recém-digitado convoca a lista de terminais. A conferência é
            // pela POSIÇÃO DO CURSOR, não pelo texto inteiro: um `@@` mais atrás
            // na frase já foi resolvido ou foi descartado, e reabrir a lista por
            // causa dele atrapalharia quem só está escrevendo.
            if (mentionAt(e.target.value, e.target.selectionStart ?? 0) !== null) setMencaoAberta(true)
          }}
          // clicar fora fecha o menu; a seleção usa onMouseDown+preventDefault,
          // então clicar num item NÃO dispara este blur antes do pick.
          onBlur={() => setSlashDismissed(true)}
          onKeyDown={(e) => {
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
                return
              }
            }
            if (e.key === 'Escape' && session?.status === 'working') { e.preventDefault(); stopTurn(); return }
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
          }}
          onPaste={(e) => {
            if (e.clipboardData?.files?.length) { e.preventDefault(); void attachFiles(e.clipboardData.files) }
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
        <MicButton
          disabled={disabled}
          onText={applyTranscript}
          onDone={endMic}
          onError={setMicError}
          onStart={startMic}
          deps={micDeps}
        />
        {session && <SessionControls session={session} />}
        <button className="chat-send" onClick={send} disabled={disabled || uploading > 0}>{t('common.send')}</button>
      </div>
      {(uploadError || micError) && (
        <div style={{ color: 'var(--err)', fontSize: 12, marginTop: 6 }}>⚠ {uploadError ?? micError}</div>
      )}
    </div>
  )
}
