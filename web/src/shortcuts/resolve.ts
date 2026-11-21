/**
 * O que cada combinação pode ser e o que vale ao juntar as escolhas guardadas
 * com os padrões. Tudo puro: nada aqui grava, e toda comparação é pela forma
 * canônica da plataforma (fora do Mac, `Ctrl` é o próprio `Mod`).
 */
import { canonicalCombo, parseCombo, sameCombo } from './combo'
import {
  BROWSER_WARN,
  EDITABLE,
  FIXED,
  RESERVED,
  SCOPE_PLACES,
  editableById,
  isShortcutId,
  type ShortcutId,
} from './registry'

/** As escolhas do usuário: só as diferenças do padrão; `null` = sem atalho. */
export type Overrides = Record<string, string | null>

export type Refusal = 'invalid' | 'needsModifier' | 'altGr' | 'reserved' | 'fixed'

export type Verdict = { ok: true; warn?: 'browser' } | { ok: false; reason: Refusal; fixedId?: string }

/**
 * `reverted`: por que a escolha guardada não vale (a ação voltou ao padrão);
 * `unbound`: quem ocupa o padrão (a ação ficou sem atalho).
 */
export interface BindingNotice { reverted?: Refusal | 'taken'; unbound?: ShortcutId }

export interface ResolvedBindings {
  resolved: Record<ShortcutId, string | null>
  notices: Partial<Record<ShortcutId, BindingNotice>>
}

/** A lista está entre as combinações desta plataforma (pela forma canônica). */
function inList(canon: string, list: readonly string[], mac: boolean): boolean {
  return list.some((c) => canonicalCombo(c, mac) === canon)
}

/**
 * Se a ação pode usar a combinação. A ordem das recusas é fixa: gramática →
 * AltGr (Mod/Ctrl + Alt fora do Mac) → modificador obrigatório → reservada →
 * fixo no mesmo lugar. Aceita, pode trazer o aviso de que o navegador usa a tecla.
 */
export function checkCombo(id: ShortcutId, combo: string, mac: boolean): Verdict {
  const c = typeof combo === 'string' ? parseCombo(combo) : null
  if (!c) return { ok: false, reason: 'invalid' }
  // No Windows Ctrl+Alt é o AltGr, que no ABNT2 escreve "/", "?", "°".
  if (!mac && (c.mod || c.ctrl) && c.alt) return { ok: false, reason: 'altGr' }
  // Letra, dígito, Enter ou Espaço sem Ctrl, ⌘ ou Alt roubariam a digitação; F1–F12 podem ir sozinhas.
  if (!c.mod && !c.ctrl && !c.alt && !/^F\d+$/.test(c.key)) return { ok: false, reason: 'needsModifier' }
  const canon = canonicalCombo(combo, mac)!
  if (inList(canon, mac ? RESERVED.mac : RESERVED.other, mac)) return { ok: false, reason: 'reserved' }
  const places = SCOPE_PLACES[editableById(id).scope]
  for (const f of FIXED) {
    if (f.platform === 'mac' && !mac) continue
    if (!f.places.some((p) => places.includes(p))) continue
    if (inList(canon, f.combos, mac)) return { ok: false, reason: 'fixed', fixedId: f.id }
  }
  if (inList(canon, mac ? BROWSER_WARN.mac : BROWSER_WARN.other, mac)) return { ok: true, warn: 'browser' }
  return { ok: true }
}

/**
 * Junta as escolhas guardadas com os padrões, sem gravar nada:
 * 1. as escolhas, na ordem do registro: `null` deixa sem atalho; a recusada ou já
 *    ocupada por uma escolha anterior volta ao padrão, com o porquê;
 * 2. os padrões de quem não escolheu (ou voltou), na mesma ordem: padrão ocupado
 *    deixa a ação sem atalho, dizendo quem o ocupa.
 * Ids fora do registro são ignorados. A ação só de administrador, para quem não
 * é, fica sem atalho, sem aviso, e não ocupa a combinação.
 */
export function resolveBindings(overrides: Overrides, opts: { mac: boolean; admin: boolean }): ResolvedBindings {
  const { mac, admin } = opts
  const resolved = {} as Record<ShortcutId, string | null>
  const notices: Partial<Record<ShortcutId, BindingNotice>> = {}
  const taken = new Map<string, ShortcutId>()
  const pending: ShortcutId[] = []

  for (const e of EDITABLE) {
    resolved[e.id] = null
    if (e.adminOnly && !admin) continue
    const choice = Object.hasOwn(overrides, e.id) ? overrides[e.id] : undefined
    if (choice === undefined) { pending.push(e.id); continue }
    if (choice === null) continue
    const verdict = checkCombo(e.id, choice, mac)
    if (!verdict.ok) {
      notices[e.id] = { reverted: verdict.reason }
      pending.push(e.id)
      continue
    }
    const canon = canonicalCombo(choice, mac)!
    if (taken.has(canon)) {
      notices[e.id] = { reverted: 'taken' }
      pending.push(e.id)
      continue
    }
    taken.set(canon, e.id)
    resolved[e.id] = choice
  }

  for (const id of pending) {
    const def = editableById(id).default
    const owner = taken.get(canonicalCombo(def, mac) ?? '')
    if (owner) {
      notices[id] = { ...notices[id], unbound: owner }
      continue
    }
    // Padrão recusado aqui seria erro do registro (o teste dos padrões cobre): fica sem atalho.
    if (!checkCombo(id, def, mac).ok) continue
    taken.set(canonicalCombo(def, mac)!, id)
    resolved[id] = def
  }

  return { resolved, notices }
}

/** Qual outra ação já usa a combinação nesta plataforma, ou null. */
export function findOwner(
  combo: string,
  resolved: Record<ShortcutId, string | null>,
  except: ShortcutId,
  mac: boolean,
): ShortcutId | null {
  for (const e of EDITABLE) {
    if (e.id === except) continue
    const c = resolved[e.id]
    if (c && sameCombo(combo, c, mac)) return e.id
  }
  return null
}

/**
 * Só o que vale guardar: ids do registro e escolhas diferentes do padrão. `null`
 * fica. A conta é a mesma no Mac e fora dele, então a escolha só sai quando é o
 * padrão nos dois sistemas: compara como no Mac, onde Ctrl e ⌘ são teclas
 * diferentes. Assim um `Ctrl+Enter` gravado no Mac (⌃↩) não some ao salvar no
 * Linux, onde ele seria igual ao `Mod+Enter`.
 */
export function pruneOverrides(o: Overrides): Overrides {
  const out: Overrides = {}
  for (const [id, v] of Object.entries(o)) {
    if (!isShortcutId(id)) continue
    if (typeof v === 'string' && sameCombo(v, editableById(id).default, true)) continue
    out[id] = v
  }
  return out
}

/** As mesmas escolhas, em qualquer ordem de chaves. */
export function sameOverrides(a: Overrides, b: Overrides): boolean {
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  return ka.every((k) => Object.hasOwn(b, k) && a[k] === b[k])
}
