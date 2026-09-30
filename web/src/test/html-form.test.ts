import { describe, it, expect } from 'vitest'
import { htmlFormTools, validHtmlFields } from '../../../shared/html-form'
import { saveHtmlFields } from '../editor/html-form'

const parse = (source: string) => new DOMParser().parseFromString(source, 'text/html')
const source = `<!doctype html><html><head><title>Relatório</title><style>p{color:red}</style></head><body>
<input id="check" type="checkbox"><input name="who" value="antes">
<input name="priority" type="radio" value="low" checked><input name="priority" type="radio" value="high">
<textarea id="notes"></textarea><select id="status"><option value="a">A</option><option value="b">B</option></select>
<select id="multi" multiple><option value="a">A</option><option value="b">B</option><option value="c">C</option></select>
<input id="secret" type="password"><input type="file"><div id="edit" contenteditable="true">Inicial</div>
<script>const original = 'mantido';</script></body></html>`

describe('preencher relatórios HTML', () => {
  it('persiste checkbox, rádio, input, textarea, select múltiplo e contenteditable no arquivo', () => {
    const doc = parse(source)
    ;(doc.querySelector('#check') as HTMLInputElement).checked = true
    ;(doc.querySelector('[name=who]') as HTMLInputElement).value = 'Ana <Coppi>'
    ;(doc.querySelector('[value=high]') as HTMLInputElement).checked = true
    ;(doc.querySelector('#notes') as HTMLTextAreaElement).value = 'Relatório\n</script><b>Texto</b>'
    ;(doc.querySelector('#status') as HTMLSelectElement).value = 'b'
    for (const option of (doc.querySelector('#multi') as HTMLSelectElement).options) option.selected = option.value !== 'b'
    doc.querySelector('#edit')!.innerHTML = '<strong>Observação</strong>'
    const values = htmlFormTools(doc).read()
    const saved = parse(saveHtmlFields(source, values))
    expect(htmlFormTools(saved).read()).toEqual(values)
    expect(JSON.parse(saved.getElementById('claudinei-form-values')!.textContent!)).toEqual(values)
    expect(saved.querySelector('script:not([id])')!.textContent).toBe("const original = 'mantido';")
    expect(saved.querySelector('style')!.textContent).toBe('p{color:red}')
    expect(saved.doctype?.name).toBe('html')
    expect(saved.querySelector('meta[charset]')!.getAttribute('charset')).toBe('utf-8')
  })
  it('não copia senha nem seleção de arquivo para o estado salvo', () => {
    const doc = parse(source)
    ;(doc.querySelector('#secret') as HTMLInputElement).value = 'senha-preenchida'
    const values = htmlFormTools(doc).read()
    expect(values.some(field => ['password', 'file'].includes(field.type))).toBe(false)
    expect(saveHtmlFields(source, values)).not.toContain('senha-preenchida')
  })
  it('salvar novamente atualiza o estado sem duplicar scripts e conserva campos de seções ausentes', () => {
    const doc = parse(source)
    const field = doc.createElement('input'); field.id = 'dinamico'; field.value = 'preenchido'; doc.body.append(field)
    const saved = saveHtmlFields(source, htmlFormTools(doc).read())
    const again = parse(saveHtmlFields(saved, htmlFormTools(parse(source)).read()))
    expect(again.querySelectorAll('#claudinei-form-values')).toHaveLength(1)
    expect(again.querySelectorAll('#claudinei-form-restore')).toHaveLength(1)
    expect(JSON.parse(again.getElementById('claudinei-form-values')!.textContent!).some((value: {value: string}) => value.value === 'preenchido')).toBe(true)
  })
  it('recusa mensagens com formato inválido ou tamanho exagerado', () => {
    expect(validHtmlFields([{key:'x',tag:'input',type:'text',value:3}])).toBe(false)
    expect(validHtmlFields(Array.from({length:5001}, () => ({key:'x',tag:'input',type:'text',value:''})))).toBe(false)
  })
})
