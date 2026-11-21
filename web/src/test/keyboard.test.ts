import { describe, it, expect, afterEach } from 'vitest'
import { inScope, shouldOpenFind } from '../keyboard'
import { simulateMac } from './mac'
import type { ShortcutScope } from '../shortcuts/registry'

/**
 * A combinação de buscar (aqui a padrão, Ctrl+F; ⌘F no Mac) abre a busca do
 * Claudinei com o foco no chat, no campo de mensagem ou em nada. Em outro campo de
 * texto, num modal, no editor de arquivo ou no terminal interativo, fica a do
 * navegador. Com a barra aberta, a segunda vez também é do navegador.
 */
const tecla = (target: EventTarget | null, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }> = { ctrlKey: true }, key = 'f') =>
  ({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods, target })

const montar = (html: string) => {
  const box = document.createElement('div')
  box.innerHTML = html
  document.body.appendChild(box)
  return box
}
afterEach(() => { document.body.innerHTML = '' })

describe('shouldOpenFind', () => {
  it('campo do chat abre; busca da lateral, modal, editor e terminal não; barra aberta não intercepta', () => {
    const box = montar(`
      <div class="chat-main">
        <div class="chat-scroll"><button id="no-chat">copiar</button></div>
        <textarea id="campo" class="chat-compose__area"></textarea>
      </div>
      <aside><input id="busca-lateral" type="search" /></aside>
      <div role="dialog"><button id="no-modal">ok</button><input id="campo-modal" /></div>
      <div class="cm-editor"><div id="editor" contenteditable="true">código</div></div>
      <div class="xterm"><textarea id="xterm-entrada" class="xterm-helper-textarea"></textarea><div id="xterm-tela"></div></div>
      <div data-terminal><div id="terminal-tela"></div></div>
    `)
    const el = (id: string) => box.querySelector<HTMLElement>(`#${id}`)!
    const campo = el('campo')

    // Abre: campo de mensagem, um botão no chat, foco em nada (body).
    expect(shouldOpenFind(tecla(campo), campo, false)).toBe(true)
    expect(shouldOpenFind(tecla(el('no-chat')), campo, false)).toBe(true)
    expect(shouldOpenFind(tecla(document.body), campo, false)).toBe(true)
    expect(shouldOpenFind(tecla(null), campo, false)).toBe(true)
    // F maiúsculo (Caps Lock) também; e ⌘+F no Mac.
    expect(shouldOpenFind(tecla(document.body, { ctrlKey: true }, 'F'), campo, false)).toBe(true)
    const desfazerMac = simulateMac()
    expect(shouldOpenFind(tecla(document.body, { metaKey: true }), campo, false)).toBe(true)
    desfazerMac()

    // Fica o do navegador: outro campo, modal (inclusive num botão dele), editor, terminal.
    expect(shouldOpenFind(tecla(el('busca-lateral')), campo, false)).toBe(false)
    expect(shouldOpenFind(tecla(el('no-modal')), campo, false)).toBe(false)
    expect(shouldOpenFind(tecla(el('campo-modal')), campo, false)).toBe(false)
    expect(shouldOpenFind(tecla(el('editor')), campo, false)).toBe(false)
    expect(shouldOpenFind(tecla(el('xterm-entrada')), campo, false)).toBe(false)
    expect(shouldOpenFind(tecla(el('xterm-tela')), campo, false)).toBe(false)
    expect(shouldOpenFind(tecla(el('terminal-tela')), campo, false)).toBe(false)

    // Barra aberta: o segundo Ctrl+F é do navegador, de onde quer que venha.
    expect(shouldOpenFind(tecla(campo), campo, true)).toBe(false)
    expect(shouldOpenFind(tecla(document.body), campo, true)).toBe(false)
  })

  it('só Ctrl/⌘+F, sem Shift nem Alt', () => {
    expect(shouldOpenFind(tecla(document.body, {}), null, false)).toBe(false)
    expect(shouldOpenFind(tecla(document.body, { ctrlKey: true, shiftKey: true }), null, false)).toBe(false)
    expect(shouldOpenFind(tecla(document.body, { ctrlKey: true, altKey: true }), null, false)).toBe(false)
    expect(shouldOpenFind(tecla(document.body, { ctrlKey: true }, 'g'), null, false)).toBe(false)
  })

  it('sem o campo do chat montado (terminal parado), o textarea qualquer continua sendo de outro', () => {
    const box = montar('<textarea id="t"></textarea>')
    expect(shouldOpenFind(tecla(box.querySelector('#t')), null, false)).toBe(false)
  })
})

describe('inScope', () => {
  // Onde cada escopo escuta, alvo a alvo. `corpo` é o foco em nada (body).
  const ESPERADO: Record<ShortcutScope, Record<string, boolean>> = {
    field: { campo: true, 'no-chat': false, 'busca-lateral': false, 'no-modal': false, editor: false, 'xterm-entrada': false, corpo: false },
    page: { campo: true, 'no-chat': true, 'busca-lateral': false, 'no-modal': false, editor: false, 'xterm-entrada': false, corpo: true },
    conversation: { campo: true, 'no-chat': true, 'busca-lateral': false, 'no-modal': false, editor: false, 'xterm-entrada': false, corpo: true },
    outsideFields: { campo: false, 'no-chat': true, 'busca-lateral': false, 'no-modal': true, editor: false, 'xterm-entrada': false, corpo: true },
    outsideFieldsAndModals: { campo: false, 'no-chat': true, 'busca-lateral': false, 'no-modal': false, editor: false, 'xterm-entrada': false, corpo: true },
    allButTerminal: { campo: true, 'no-chat': true, 'busca-lateral': true, 'no-modal': true, editor: true, 'xterm-entrada': false, corpo: true },
  }

  it('cada escopo nos alvos de sempre', () => {
    const box = montar(`
      <div class="chat-main">
        <div class="chat-scroll"><button id="no-chat">copiar</button></div>
        <textarea id="campo" class="chat-compose__area"></textarea>
      </div>
      <aside><input id="busca-lateral" type="search" /></aside>
      <div role="dialog"><button id="no-modal">ok</button></div>
      <div class="cm-editor"><div id="editor" contenteditable="true">código</div></div>
      <div class="xterm"><textarea id="xterm-entrada" class="xterm-helper-textarea"></textarea></div>
    `)
    const campo = box.querySelector<HTMLElement>('#campo')!
    const alvo = (nome: string): EventTarget => (nome === 'corpo' ? document.body : box.querySelector(`#${nome}`)!)
    const obtido: Record<string, Record<string, boolean>> = {}
    for (const [scope, linha] of Object.entries(ESPERADO)) {
      obtido[scope] = Object.fromEntries(Object.keys(linha).map((nome) => [nome, inScope(scope as ShortcutScope, alvo(nome), campo)]))
    }
    expect(obtido).toEqual(ESPERADO)
  })

  it('page: dentro de um diálogo ou modal não escuta; no campo, na conversa e na lateral, sim', () => {
    const box = montar(`
      <div class="chat-main">
        <div class="chat-scroll"><button id="no-chat">copiar</button></div>
        <textarea id="campo" class="chat-compose__area"></textarea>
      </div>
      <aside class="side-col"><button id="na-lateral">ok</button></aside>
      <div role="dialog"><button id="no-dialogo">ok</button><div id="no-dialogo-fundo" tabindex="-1"></div></div>
    `)
    const campo = box.querySelector<HTMLElement>('#campo')!
    const el = (id: string) => box.querySelector<HTMLElement>(`#${id}`)!
    // Só o diálogo não modal na página: fora dele, vale; dentro, não.
    for (const id of ['no-dialogo', 'no-dialogo-fundo']) expect(inScope('page', el(id), campo), id).toBe(false)
    for (const id of ['campo', 'no-chat', 'na-lateral']) expect(inScope('page', el(id), campo), id).toBe(true)
    expect(inScope('page', document.body, campo)).toBe(true)

    box.insertAdjacentHTML('beforeend', `
      <div role="dialog" aria-modal="true"><button id="no-modal-aria">ok</button></div>
      <div aria-modal="true"><button id="so-aria-modal">ok</button></div>
      <div class="modal-overlay"><div class="glass"><button id="no-overlay">ok</button></div></div>
    `)
    for (const id of ['no-dialogo', 'no-dialogo-fundo', 'no-modal-aria', 'so-aria-modal', 'no-overlay']) {
      expect(inScope('page', el(id), campo), id).toBe(false)
    }
    // O campo de mensagem continua valendo sempre.
    expect(inScope('page', campo, campo)).toBe(true)
  })

  // Vários modais não puxam o foco para dentro (o ConfirmDialog, por exemplo): o
  // foco fica no botão que o abriu ou cai no body. Com um modal aberto na página,
  // a tecla é dele, mesmo com o foco fora; só o campo de mensagem escapa.
  describe('com um modal aberto na página e o foco fora dele', () => {
    const PAGINA = `
      <div class="chat-main">
        <div class="chat-scroll"><button id="no-chat">copiar</button></div>
        <textarea id="campo" class="chat-compose__area"></textarea>
      </div>
      <aside class="side-col"><button id="na-lateral">⇄</button></aside>
    `
    const ESCOPOS_SEM_MODAL: ShortcutScope[] = ['page', 'conversation', 'outsideFieldsAndModals']

    for (const [nome, modal] of [
      ['.modal-overlay', '<div class="modal-overlay"><div class="glass"><button>ok</button></div></div>'],
      ['[aria-modal="true"]', '<div class="undo-panel-backdrop"><div class="undo-dialog" role="dialog" aria-modal="true"><button>ok</button></div></div>'],
    ] as const) {
      it(`${nome}: page, conversation e outsideFieldsAndModals ficam fora; o campo de mensagem e os demais escopos seguem`, () => {
        const box = montar(PAGINA + modal)
        const campo = box.querySelector<HTMLElement>('#campo')!
        const el = (id: string) => box.querySelector<HTMLElement>(`#${id}`)!
        for (const scope of ESCOPOS_SEM_MODAL) {
          for (const [alvo, t] of [['corpo', document.body], ['nada', null], ['no-chat', el('no-chat')], ['na-lateral', el('na-lateral')]] as const) {
            expect(inScope(scope, t, campo), `${scope} em ${alvo}`).toBe(false)
          }
        }
        expect(inScope('page', campo, campo)).toBe(true)
        expect(inScope('conversation', campo, campo)).toBe(true)
        // Os escopos que não excluem modal não mudam.
        expect(inScope('outsideFields', document.body, campo)).toBe(true)
        expect(inScope('allButTerminal', document.body, campo)).toBe(true)
      })
    }

    it('um role="dialog" sem aria-modal (o menu de menção de arquivo, preso ao campo) não fecha a página', () => {
      const box = montar(PAGINA + '<div class="file-mention" role="dialog" aria-labelledby="t"><span id="t">Arquivos</span><button id="na-mencao">a.ts</button></div>')
      const campo = box.querySelector<HTMLElement>('#campo')!
      for (const scope of ESCOPOS_SEM_MODAL) {
        expect(inScope(scope, document.body, campo), scope).toBe(true)
        expect(inScope(scope, box.querySelector('#no-chat'), campo), scope).toBe(true)
        // Dentro dele, continua de fora (é um diálogo).
        expect(inScope(scope, box.querySelector('#na-mencao'), campo), scope).toBe(false)
      }
    })

    it('ao fechar o modal, volta a valer', () => {
      const box = montar(PAGINA + '<div class="modal-overlay" id="m"><button>ok</button></div>')
      const campo = box.querySelector<HTMLElement>('#campo')!
      expect(inScope('page', document.body, campo)).toBe(false)
      box.querySelector('#m')!.remove()
      expect(inScope('page', document.body, campo)).toBe(true)
    })
  })

  it('sem o campo do chat montado, nada é o campo', () => {
    const box = montar('<textarea id="t"></textarea>')
    const t = box.querySelector('#t')
    expect(inScope('field', t, null)).toBe(false)
    expect(inScope('field', document.body, null)).toBe(false)
    expect(inScope('field', null, null)).toBe(false)
    expect(inScope('page', t, null)).toBe(false)
    expect(inScope('conversation', t, null)).toBe(false)
    expect(inScope('page', null, null)).toBe(true)
  })
})
