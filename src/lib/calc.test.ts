import { describe, expect, it } from 'vitest'
import { boqTotals, itemAmount, payroll, stockAfter, variance } from './calc'

describe('BOQ calculations', () => {
  it('Amount = Quantity × Unit Rate, rounded to cents', () => {
    expect(itemAmount(12.5, 18500)).toBe(231250)
    expect(itemAmount('3.333', '1000.10')).toBe(3333.33)
    expect(itemAmount('', 100)).toBe(0)
  })

  it('section totals, subtotal, taxes and grand total', () => {
    const t = boqTotals(
      [
        { section_id: 'A', quantity: 10, rate: 1000 },
        { section_id: 'A', quantity: 2, rate: 250.5 },
        { section_id: 'B', quantity: 1, rate: 5000 },
      ],
      [{ name: 'VAT', rate: 18 }],
    )
    expect(t.sections).toEqual({ A: 10501, B: 5000 })
    expect(t.subtotal).toBe(15501)
    expect(t.taxes[0].amount).toBe(2790.18)
    expect(t.taxTotal).toBe(2790.18)
    expect(t.grandTotal).toBe(18291.18)
  })

  it('supports multiple and zero taxes', () => {
    const items = [{ section_id: 'A', quantity: 1, rate: 1000 }]
    expect(boqTotals(items, []).grandTotal).toBe(1000)
    expect(boqTotals(items, [{ name: 'VAT', rate: 18 }, { name: 'Levy', rate: 2 }]).grandTotal).toBe(1200)
  })
})

describe('variance', () => {
  it('flags over-budget work', () => {
    expect(variance(1000, 1200)).toEqual({ variance: -200, percent: -20, overBudget: true })
    expect(variance(1000, 800).overBudget).toBe(false)
    expect(variance(0, 50).percent).toBe(0)
  })
})

describe('stock & payroll', () => {
  it('stock movements', () => {
    expect(stockAfter(100, 'receipt', 20)).toBe(120)
    expect(stockAfter(100, 'issue', 30)).toBe(70)
    expect(stockAfter(10, 'issue', 30)).toBe(-20)
  })
  it('payroll gross and net', () => {
    expect(payroll(500000, 45000, 50000, 60000)).toEqual({ gross: 595000, net: 535000 })
  })
})
