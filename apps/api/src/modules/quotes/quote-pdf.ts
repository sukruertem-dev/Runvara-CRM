import type { QuoteVersionView, z } from '@flexa/contracts';
import { createRequire } from 'node:module';
import PDFDocument from 'pdfkit';

// The quote document (ADR-0021, docs/p9-plan.md §5): drawn from the stored version only, so it cannot disagree with
// the API. Embedded DejaVu fonts cover Turkish; no browser is involved.

const font = createRequire(__filename);
const REGULAR = font.resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf');
const BOLD = font.resolve('dejavu-fonts-ttf/ttf/DejaVuSans-Bold.ttf');

export interface QuotePdfInput {
  locale: string;
  tenantName: string;
  number: string;
  title: string;
  currency: string;
  footer: string;
  /** Not yet sent: marked on every page. */
  draft: boolean;
  content: z.infer<typeof QuoteVersionView>;
}

const TR = {
  quote: 'TEKLİF', version: 'Sürüm', date: 'Tarih', validUntil: 'Geçerlilik', customer: 'Müşteri', contact: 'İlgili kişi', product: 'Ürün / hizmet', qty: 'Miktar', price: 'Birim fiyat',
  disc: 'İsk. %', net: 'Tutar', subtotal: 'Ara toplam', discount: 'İskonto', netTotal: 'Net toplam', tax: 'Vergi', total: 'Genel toplam', terms: 'Koşullar', draft: 'TASLAK', page: 'Sayfa',
};
const EN: typeof TR = {
  quote: 'QUOTE', version: 'Version', date: 'Date', validUntil: 'Valid until', customer: 'Customer', contact: 'Contact', product: 'Product / service', qty: 'Quantity', price: 'Unit price',
  disc: 'Disc. %', net: 'Amount', subtotal: 'Subtotal', discount: 'Discount', netTotal: 'Net total', tax: 'Tax', total: 'Grand total', terms: 'Terms', draft: 'DRAFT', page: 'Page',
};

/** Grouped decimal string in the document's locale; the digits are the stored ones (no float in between). */
export function formatDecimal(v: string, locale: string): string {
  const [i = '0', f] = v.split('.');
  const tr = locale.startsWith('tr');
  const grouped = i.replace(/\B(?=(\d{3})+(?!\d))/g, tr ? '.' : ',');
  return f ? `${grouped}${tr ? ',' : '.'}${f}` : grouped;
}
const trim = (v: string): string => (v.includes('.') ? v.replace(/0+$/, '').replace(/\.$/, '') : v);
/** Unit prices keep at least two decimals. */
const price = (v: string): string => {
  const [i = '0', f = ''] = trim(v).split('.');
  return `${i}.${f.padEnd(2, '0')}`;
};

const M = 48;
const INK = '#1A1B1F';
const MUTED = '#646B7E';
const LINE = '#E7E7EF';

export function renderQuotePdf(q: QuotePdfInput): Promise<Buffer> {
  const L = q.locale.startsWith('tr') ? TR : EN;
  const c = q.content;
  const num = (v: string): string => formatDecimal(v, q.locale);
  const day = (iso: string): string => {
    const [y = '', m = '', d = ''] = iso.slice(0, 10).split('-');
    return q.locale.startsWith('tr') ? `${d}.${m}.${y}` : `${y}-${m}-${d}`;
  };
  const doc = new PDFDocument({ size: 'A4', margin: M, bufferPages: true, info: { Title: `${q.number} v${String(c.version)}`, Author: q.tenantName } });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (b: Buffer) => chunks.push(b));
    doc.on('end', () => { resolve(Buffer.concat(chunks)); });
    doc.on('error', reject);
  });
  doc.registerFont('r', REGULAR);
  doc.registerFont('b', BOLD);
  const W = doc.page.width - 2 * M;
  const bottom = doc.page.height - M - 24;
  const ensure = (h: number): void => {
    if (doc.y + h > bottom) doc.addPage();
  };

  doc.font('b').fontSize(16).fillColor(INK).text(q.tenantName, M, M, { width: W * 0.6 });
  doc.font('b').fontSize(16).text(L.quote, M + W * 0.6, M, { width: W * 0.4, align: 'right' });
  doc.font('r').fontSize(9).fillColor(MUTED)
    .text(`${q.number} · ${L.version} ${String(c.version)}`, M + W * 0.6, M + 22, { width: W * 0.4, align: 'right' })
    .text(`${L.date}: ${day(c.sentAt ?? c.createdAt)}`, { width: W * 0.4, align: 'right' })
    .text(`${L.validUntil}: ${day(c.validUntil)}`, { width: W * 0.4, align: 'right' });
  doc.y = Math.max(doc.y, M + 64);
  doc.x = M;
  if (c.customer.account) doc.font('b').fontSize(10).fillColor(INK).text(`${L.customer}: ${c.customer.account}`, M, doc.y, { width: W });
  if (c.customer.contact) doc.font('r').fontSize(10).fillColor(INK).text(`${L.contact}: ${c.customer.contact}`, M, doc.y, { width: W });
  doc.moveDown(0.5).font('b').fontSize(11).text(q.title, M, doc.y, { width: W });
  if (c.intro.trim()) doc.moveDown(0.5).font('r').fontSize(9.5).text(c.intro, M, doc.y, { width: W });
  doc.moveDown(1);

  const cols = [
    { label: L.product, w: W * 0.42, align: 'left' as const },
    { label: L.qty, w: W * 0.14, align: 'right' as const },
    { label: L.price, w: W * 0.17, align: 'right' as const },
    { label: L.disc, w: W * 0.09, align: 'right' as const },
    { label: L.net, w: W * 0.18, align: 'right' as const },
  ];
  const row = (cells: string[], bold: boolean): void => {
    doc.font(bold ? 'b' : 'r').fontSize(8.5).fillColor(bold ? MUTED : INK);
    const h = Math.max(...cells.map((t, i) => doc.heightOfString(t, { width: (cols[i]?.w ?? 0) - 6 }))) + 8;
    if (doc.y + h > bottom) {
      doc.addPage();
      if (!bold) row(cols.map((x) => x.label), true);
      doc.font('r').fontSize(8.5).fillColor(INK);
    }
    const y = doc.y;
    let x = M;
    cells.forEach((t, i) => {
      const col = cols[i];
      if (!col) return;
      doc.text(t, x + 3, y + 4, { width: col.w - 6, align: col.align });
      x += col.w;
    });
    doc.moveTo(M, y + h).lineTo(M + W, y + h).lineWidth(0.5).strokeColor(LINE).stroke();
    doc.y = y + h;
  };
  row(cols.map((x) => x.label), true);
  for (const l of c.lines) {
    row([[`${l.name} (${l.sku})`, l.description].filter(Boolean).join('\n'), `${num(trim(l.quantity))} ${l.unit}`, num(price(l.unitPrice)), trim(l.discountPercent) === '0' ? '' : num(trim(l.discountPercent)), num(l.net)], false);
  }

  const sums: [string, string, boolean][] = [
    [L.subtotal, c.totals.subtotal, false],
    ...(Number(c.totals.discount) > 0 ? [[L.discount, `-${c.totals.discount}`, false] as [string, string, boolean]] : []),
    [L.netTotal, c.totals.net, false],
    ...c.taxes.map((x): [string, string, boolean] => [`${L.tax} %${num(trim(x.percent))}`, x.tax, false]),
    [L.total, c.totals.total, true],
  ];
  ensure(sums.length * 16 + 12);
  doc.y += 8;
  for (const [label, value, bold] of sums) {
    const y = doc.y;
    doc.font(bold ? 'b' : 'r').fontSize(bold ? 11 : 9.5).fillColor(INK);
    doc.text(label, M + W * 0.5, y, { width: W * 0.22 });
    const signed = value.startsWith('-') ? `-${num(value.slice(1))}` : num(value);
    doc.text(`${signed} ${q.currency}`, M + W * 0.72, y, { width: W * 0.28, align: 'right' });
    doc.y = y + 16;
  }
  if (c.terms.trim()) {
    ensure(48);
    doc.moveDown(1).font('b').fontSize(10).text(L.terms, M, doc.y, { width: W });
    doc.font('r').fontSize(9).text(c.terms, M, doc.y + 2, { width: W });
  }

  const pages = doc.bufferedPageRange();
  for (let i = 0; i < pages.count; i += 1) {
    doc.switchToPage(i);
    // Footers sit inside the bottom margin; without this pdfkit would open a new page for them.
    doc.page.margins.bottom = 0;
    const y = doc.page.height - M + 4;
    doc.font('r').fontSize(8).fillColor(MUTED)
      .text([q.footer, `${L.page} ${String(i + 1)}/${String(pages.count)}`].filter(Boolean).join(' · '), M, y, { width: W, align: 'center', height: 20, ellipsis: true });
    if (q.draft) {
      doc.save().rotate(-35, { origin: [doc.page.width / 2, doc.page.height / 2] }).font('b').fontSize(90).fillColor(INK).fillOpacity(0.06)
        .text(L.draft, 0, doc.page.height / 2 - 50, { width: doc.page.width, align: 'center', lineBreak: false }).restore();
    }
  }
  doc.end();
  return done;
}
