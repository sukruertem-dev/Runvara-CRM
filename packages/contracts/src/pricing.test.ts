import { describe, expect, it } from 'vitest';
import { minorDigits, priceQuote, type PricingLine } from './pricing';

const line = (over: Partial<PricingLine> = {}): PricingLine => ({ quantity: '1', unitPrice: '100', listPrice: '100', discountPercent: '0', taxPercent: '20', ...over });

describe('priceQuote (ADR-0021)', () => {
  it('discounts, then rounds the line, then taxes the rounded line', () => {
    const r = priceQuote([line({ quantity: '3', unitPrice: '33.3333', listPrice: '33.3333', discountPercent: '10' })], '5', 'TRY');
    expect(r.lines[0]).toEqual({ gross: '100.00', net: '85.50', tax: '17.10', total: '102.60' });
    expect(r.totals).toEqual({ subtotal: '100.00', discount: '14.50', net: '85.50', tax: '17.10', total: '102.60' });
  });

  it('rounds half to even', () => {
    expect(['0.125', '0.135', '0.145'].map((p) => priceQuote([line({ unitPrice: p, taxPercent: '0' })], '0', 'TRY').totals.net)).toEqual(['0.12', '0.14', '0.14']);
  });

  it('uses the minor unit of the currency', () => {
    expect([minorDigits('JPY'), minorDigits('TRY'), minorDigits('KWD')]).toEqual([0, 2, 3]);
    expect(priceQuote([line({ unitPrice: '100.5' })], '0', 'JPY').totals.net).toBe('100');
  });

  it('asks approval for the deepest line against its list price, rounded up', () => {
    expect(priceQuote([line(), line({ unitPrice: '80', discountPercent: '10' })], '0', 'TRY').approvalPercent).toBe('28.00');
    expect(priceQuote([line({ unitPrice: '99.9999' })], '0', 'TRY').approvalPercent).toBe('0.01');
    expect(priceQuote([line({ unitPrice: '120' })], '0', 'TRY').approvalPercent).toBe('0.00');
    expect(priceQuote([line({ unitPrice: '50', listPrice: null })], '4', 'TRY').approvalPercent).toBe('4.00');
  });

  it('totals are the sums of the lines and of the tax rates (property)', () => {
    let seed = 7;
    const rnd = (n: number): number => {
      seed = (seed * 48271) % 2147483647;
      return seed % n;
    };
    const cents = (s: string): bigint => BigInt(s.replace('.', ''));
    for (let i = 0; i < 300; i += 1) {
      const lines = Array.from({ length: 1 + rnd(8) }, () => line({
        quantity: `${String(1 + rnd(99))}.${String(rnd(1000)).padStart(3, '0')}`,
        unitPrice: `${String(rnd(100000))}.${String(rnd(10000)).padStart(4, '0')}`,
        discountPercent: String(rnd(101)),
        taxPercent: ['0', '1', '10', '20'][rnd(4)] ?? '0',
      }));
      const r = priceQuote(lines, String(rnd(101)), 'TRY');
      expect(r.lines.reduce((a, l) => a + cents(l.total), 0n)).toBe(cents(r.totals.total));
      expect(r.taxes.reduce((a, x) => a + cents(x.tax), 0n)).toBe(cents(r.totals.tax));
      expect(cents(r.totals.subtotal) - cents(r.totals.discount)).toBe(cents(r.totals.net));
    }
  });

  it('refuses what is not a decimal', () => {
    expect(() => priceQuote([line({ quantity: '-1' })], '0', 'TRY')).toThrow(RangeError);
    expect(() => priceQuote([line()], '100.001', 'TRY')).toThrow(RangeError);
  });
});
