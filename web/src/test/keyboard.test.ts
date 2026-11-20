import { describe, it, expect, afterEach } from 'vitest'
import { shouldOpenFind } from '../keyboard'

/**
 * Ctrl+F (⌘+F) abre a busca do Claudinei com o foco no chat, no campo de
 * mensagem ou em nada. Em outro campo de texto, num modal, no editor de arquivo
 * ou no terminal interativo, fica o do navegador. Com a barra aberta, o segundo
 * Ctrl+F também é do navegador.
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
    // ⌘+F no Mac e F maiúsculo (Caps Lock) também.
    expect(shouldOpenFind(tecla(document.body, { metaKey: true }), campo, false)).toBe(true)
    expect(shouldOpenFind(tecla(document.body, { ctrlKey: true }, 'F'), campo, false)).toBe(true)

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
