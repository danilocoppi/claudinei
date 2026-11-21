import { describe, it, expect } from 'vitest'
import {
  CONVERSATION_REWOUND_NOTE, CONVERSATION_REWOUND_PREFIX, FILES_REVERTED_PREFIX,
  filesRevertedNote, stripNotes, turnKey, withNote,
} from '../../shared/undo.js'

describe('textos ao agente', () => {
  it('filesRevertedNote lista os caminhos separados por vírgula', () => {
    expect(filesRevertedNote(['a.ts', 'dir/b.ts'])).toBe(
      `${FILES_REVERTED_PREFIX}: The operator reverted the file changes of an earlier turn: a.ts, dir/b.ts. Re-read them before editing.`,
    )
  })

  it('filesRevertedNote com 31 caminhos termina em "and 1 more"', () => {
    const paths = Array.from({ length: 31 }, (_, i) => `f${i}.ts`)
    const note = filesRevertedNote(paths)
    expect(note).toContain(`f29.ts and 1 more. Re-read them before editing.`)
    expect(note).not.toContain('f30.ts')
    expect(note.split(', ')).toHaveLength(30)
  })

  it('CONVERSATION_REWOUND_NOTE tem o texto fixo', () => {
    expect(CONVERSATION_REWOUND_NOTE).toBe(`${CONVERSATION_REWOUND_PREFIX}: Files still contain changes made after this point.`)
  })

  it('withNote põe a nota na frente separada por linha em branco', () => {
    expect(withNote('N', 'texto')).toBe('N\n\ntexto')
  })
})

describe('stripNotes', () => {
  it('tira uma ou mais notas do começo, na ordem', () => {
    const files = filesRevertedNote(['a.ts', 'b c/-x.ts'])
    const text = withNote(CONVERSATION_REWOUND_NOTE, withNote(files, 'faça y\n\nmais'))
    expect(stripNotes(text)).toEqual({
      notes: [
        { kind: 'conversation_rewound', body: CONVERSATION_REWOUND_NOTE },
        { kind: 'files_reverted', body: files },
      ],
      rest: 'faça y\n\nmais',
    })
  })

  it('texto sem nota fica como está', () => {
    expect(stripNotes('oi')).toEqual({ notes: [], rest: 'oi' })
  })

  it('a menção no meio da mensagem do operador não é nota', () => {
    const text = `veja o que o "${FILES_REVERTED_PREFIX}" faz\n\n${CONVERSATION_REWOUND_NOTE}\n\nfim`
    expect(stripNotes(text)).toEqual({ notes: [], rest: text })
  })

  it('o prefixo sozinho, sem o texto exato da nota, não é nota', () => {
    const text = `${FILES_REVERTED_PREFIX}: eu escrevi isto\n\noutra coisa`
    expect(stripNotes(text)).toEqual({ notes: [], rest: text })
    const rew = `${CONVERSATION_REWOUND_PREFIX}: outra frase\n\nx`
    expect(stripNotes(rew)).toEqual({ notes: [], rest: rew })
  })

  it('nota sem a linha em branco depois não é nota', () => {
    expect(stripNotes(CONVERSATION_REWOUND_NOTE).notes).toEqual([])
    expect(stripNotes(`${CONVERSATION_REWOUND_NOTE}\nx`).notes).toEqual([])
  })

  it('a nota de arquivos com "and n more" é reconhecida', () => {
    const note = filesRevertedNote(Array.from({ length: 40 }, (_, i) => `f${i}`))
    expect(stripNotes(withNote(note, 'z'))).toEqual({ notes: [{ kind: 'files_reverted', body: note }], rest: 'z' })
  })
})

describe('turnKey', () => {
  it('turnKey igual para "[Task from X]: faça y" e o corpo "faça y"', () => {
    expect(turnKey('[Task from X]: faça y')).toBe(turnKey('faça y'))
    expect(turnKey('faça y')).toBe('faça y')
  })

  it('tira só um envelope', () => {
    expect(turnKey('[Agendamento: diário #3] [Claudinei: goal]: z')).toBe('[Claudinei: goal]: z')
  })

  it('turnKey tira a nota files reverted e a conversation rewound', () => {
    const body = 'arrume o teste'
    const both = withNote(CONVERSATION_REWOUND_NOTE, withNote(filesRevertedNote(['a.ts']), body))
    expect(turnKey(both)).toBe(turnKey(body))
    expect(turnKey(withNote(filesRevertedNote(['a.ts']), `[Task from X]: ${body}`))).toBe(body)
  })

  it('turnKey de texto do operador começando com "[WIP]" bate dos dois lados', () => {
    const sent = '[WIP] corrigir o login'
    // Lado do servidor (o que foi enviado, às vezes com a nota) e lado do motor/web.
    expect(turnKey(withNote(CONVERSATION_REWOUND_NOTE, sent))).toBe(turnKey(sent))
    expect(turnKey(sent)).toBe('corrigir o login')
  })

  it('junta espaços, apara e corta em 300 caracteres', () => {
    expect(turnKey('  a \n\n b\t c  ')).toBe('a b c')
    expect(turnKey('x'.repeat(500))).toHaveLength(300)
  })

  it('envelope com quebra de linha ou mais de 200 caracteres fica', () => {
    expect(turnKey('[a\nb] c')).toBe('[a b] c')
    const long = `[${'y'.repeat(201)}] c`
    expect(turnKey(long)).toBe(long)
  })
})
