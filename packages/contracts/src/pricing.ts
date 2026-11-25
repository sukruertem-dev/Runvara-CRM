// The one place where quote totals are computed (ADR-0021, docs/p9-plan.md §3): the API, the PDF and the editor use
// it, so they cannot disagree. Integer arithmetic on decimal strings; no floats.
// Order: quantity × unit price → line discount → quote discount → round (half-even, the currency's minor unit) →
// tax of the rounded line → round. Totals are sums of rounded lines.

export interface PricingLine {
  quantity: string;
  unitPrice: string;
  /** Null when the catalogue has no price: the typed price is its own reference. */
  listPrice: string | null;
  discountPercent: string;
  taxPercent: string;
}
export interface PricedLine { gross: string; net: string; tax: string; total: string }
export interface Priced {
  lines: PricedLine[];
  totals: { subtotal: string; discount: string; net: string; tax: string; total: string };
  taxes: { percent: string; base: string; tax: string }[];
  approvalPercent: string;
}

const NO_MINOR = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);
const THREE_MINOR = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);
export const minorDigits = (currency: string): number => (NO_MINOR.has(currency) ? 0 : THREE_MINOR.has(currency) ? 3 : 2);

/** Decimal string → integer scaled by 10^digits. Extra digits are refused, not dropped. */
function scaled(v: string, digits: number): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(v);
  if (!m?.[1]) throw new RangeError(`not a decimal: ${v}`);
  const frac = (m[2] ?? '').replace(/0+$/, '');
  if (frac.length > digits) throw new RangeError(`too many decimals: ${v}`);
  return BigInt(m[1] + frac.padEnd(digits, '0'));
}

/** n / d rounded half to even (n ≥ 0, d > 0). */
function halfEven(n: bigint, d: bigint): bigint {
  const q = n / d;
  const twice = (n % d) * 2n;
  return twice > d || (twice === d && q % 2n === 1n) ? q + 1n : q;
}

function text(v: bigint, digits: number): string {
  if (digits === 0) return v.toString();
  const s = v.toString().padStart(digits + 1, '0');
  return `${s.slice(0, -digits)}.${s.slice(-digits)}`;
}

/** 100 % with three decimals. */
const HUNDRED = 100_000n;

export function priceQuote(lines: readonly PricingLine[], discountPercent: string, currency: string): Priced {
  const digits = minorDigits(currency);
  const minor = BigInt(10 ** digits);
  const whole = HUNDRED - scaled(discountPercent, 3);
  if (whole < 0n) throw new RangeError('discount above 100 %');
  let subtotal = 0n;
  let net = 0n;
  let tax = 0n;
  let approval = 0n;
  const byRate = new Map<string, { base: bigint; tax: bigint }>();
  const out = lines.map((l) => {
    const qty = scaled(l.quantity, 3);
    const price = scaled(l.unitPrice, 4);
    const kept = HUNDRED - scaled(l.discountPercent, 3);
    if (kept < 0n) throw new RangeError('discount above 100 %');
    const rate = scaled(l.taxPercent, 3);
    const gross = halfEven(qty * price * minor, 10_000_000n);
    const lineNet = halfEven(qty * price * kept * whole * minor, 10_000_000n * HUNDRED * HUNDRED);
    const lineTax = halfEven(lineNet * rate, HUNDRED);
    subtotal += gross;
    net += lineNet;
    tax += lineTax;
    const key = text(rate, 3);
    const sum = byRate.get(key) ?? { base: 0n, tax: 0n };
    byRate.set(key, { base: sum.base + lineNet, tax: sum.tax + lineTax });
    // Discount of the line against its list price, in hundredths of a percent, rounded up.
    const ref = scaled(l.listPrice ?? l.unitPrice, 4) * HUNDRED * HUNDRED;
    const asked = price * kept * whole;
    if (ref > asked) {
      const p = ((ref - asked) * 10_000n + ref - 1n) / ref;
      if (p > approval) approval = p;
    }
    return { gross: text(gross, digits), net: text(lineNet, digits), tax: text(lineTax, digits), total: text(lineNet + lineTax, digits) };
  });
  return {
    lines: out,
    totals: { subtotal: text(subtotal, digits), discount: text(subtotal - net, digits), net: text(net, digits), tax: text(tax, digits), total: text(net + tax, digits) },
    taxes: [...byRate].map(([percent, v]) => ({ percent, base: text(v.base, digits), tax: text(v.tax, digits) })).sort((a, b) => Number(a.percent) - Number(b.percent)),
    approvalPercent: text(approval, 2),
  };
}
