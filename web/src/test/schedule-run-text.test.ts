import { describe, it, expect, afterAll } from 'vitest'
import i18n from '../i18n'
import { runErrorLabel } from '../scheduleRunText'
import { SCHEDULE_RUN_TEXTS } from '../../../shared/schedule-run'

/**
 * O agendador grava o motivo de pular (ou do erro que não conta falha) em
 * português; a tela de agendamentos mostra na língua da interface. Texto
 * desconhecido (erro do motor) aparece como veio.
 */
describe('motivo gravado da execução, na língua da interface', () => {
  afterAll(async () => { await i18n.changeLanguage('pt-BR') })

  it('em inglês e espanhol, cada motivo fixo traduzido; o desconhecido como veio', async () => {
    await i18n.changeLanguage('en')
    const t = i18n.t.bind(i18n)
    expect(runErrorLabel(t, SCHEDULE_RUN_TEXTS.previousRunning)).toBe('previous run still running')
    expect(runErrorLabel(t, SCHEDULE_RUN_TEXTS.noticeHeld)).toBe('a notice is waiting for the operator')
    expect(runErrorLabel(t, 'limite de uso do Claude — a janela reabre às 15:40')).toBe('Claude usage limit — the window reopens at 15:40')
    expect(runErrorLabel(t, 'Error: spawn claude ENOENT')).toBe('Error: spawn claude ENOENT')
    for (const texto of Object.values(SCHEDULE_RUN_TEXTS)) expect(runErrorLabel(t, texto)).not.toBe(texto)
    await i18n.changeLanguage('es')
    expect(runErrorLabel(t, SCHEDULE_RUN_TEXTS.sessionBusy)).toBe('la sesión está ocupada')
  })

  it('em português, o mesmo texto de sempre', async () => {
    await i18n.changeLanguage('pt-BR')
    const t = i18n.t.bind(i18n)
    for (const texto of Object.values(SCHEDULE_RUN_TEXTS)) expect(runErrorLabel(t, texto)).toBe(texto)
    expect(runErrorLabel(t, 'limite de uso do Claude')).toBe('limite de uso do Claude')
  })
})
