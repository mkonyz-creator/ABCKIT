/**
 * Pure calculation helpers shared by the UI. The database computes the same
 * values (generated columns / views) — these mirror them for instant feedback.
 */

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

/** Amount = Quantity × Unit Rate (rounded to cents, like the DB generated column) */
export function itemAmount(quantity: number | string, rate: number | string) {
  const q = Number(quantity) || 0
  const r = Number(rate) || 0
  return round2(q * r)
}

export interface TaxLine {
  name: string
  rate: number
}

export interface BoqTotals {
  sections: Record<string, number>
  subtotal: number
  taxes: Array<TaxLine & { amount: number }>
  taxTotal: number
  grandTotal: number
}

/** Grand Total = Subtotal + Σ(Subtotal × tax rate) */
export function boqTotals(items: Array<{ section_id: string; quantity: number | string; rate: number | string }>, taxes: TaxLine[]): BoqTotals {
  const sections: Record<string, number> = {}
  let subtotal = 0
  for (const i of items) {
    const a = itemAmount(i.quantity, i.rate)
    sections[i.section_id] = round2((sections[i.section_id] ?? 0) + a)
    subtotal = round2(subtotal + a)
  }
  const taxLines = (taxes ?? []).map((t) => ({ ...t, rate: Number(t.rate) || 0, amount: round2((subtotal * (Number(t.rate) || 0)) / 100) }))
  const taxRate = taxLines.reduce((s, t) => s + t.rate, 0)
  // match the DB view: tax computed on the combined rate, rounded once
  const taxTotal = round2((subtotal * taxRate) / 100)
  return { sections, subtotal, taxes: taxLines, taxTotal, grandTotal: round2(subtotal + taxTotal) }
}

/** Variance = Estimate − Actual. Positive => under budget. */
export function variance(estimate: number, actual: number) {
  const v = round2((Number(estimate) || 0) - (Number(actual) || 0))
  const pct = estimate ? round2((v / estimate) * 100) : 0
  return { variance: v, percent: pct, overBudget: v < 0 }
}

/** Stock balance after a movement; mirrors public.inventory_apply() */
export function stockAfter(current: number, type: string, qty: number) {
  const inbound = ['receipt', 'return', 'adjustment_in', 'opening'].includes(type)
  return round2((Number(current) || 0) + (inbound ? 1 : -1) * (Number(qty) || 0))
}

/** Payroll gross / net (mirrors payroll_records generated columns) */
export function payroll(basic: number, overtime: number, allowances: number, deductions: number) {
  const gross = round2(basic + overtime + allowances)
  return { gross, net: round2(gross - deductions) }
}
