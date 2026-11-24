// Demo workspace seed (docs/phase-plan.md P3): creates one tenant with users and CRM data by calling the
// API in-process, so every record goes through the same validation, authorization and RLS as real traffic.
// CLI: src/seed-demo.ts.
import type { MailJob } from '@flexa/contracts';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Mailer } from '../infra/tokens';

const SLUG = process.env.SEED_TENANT_SLUG ?? 'flexa-demo';
const DOMAIN = 'demo.flexa.test';

/** Keeps mails in memory: the seed reads verification and invitation links from it instead of sending them. */
export class MemoryMailer implements Mailer {
  readonly jobs: MailJob[] = [];
  send(job: MailJob): Promise<void> {
    this.jobs.push(job);
    return Promise.resolve();
  }
}

export interface Mailbox {
  readonly jobs: readonly MailJob[];
}

function tokenOf(mailbox: Mailbox, template: MailJob['template'], to: string): string {
  const job = [...mailbox.jobs].reverse().find((j) => j.template === template && j.to === to);
  const url = job && 'url' in job.vars ? job.vars.url : '';
  const token = url ? new URL(url).searchParams.get('token') : null;
  if (!token) throw new Error(`no ${template} mail for ${to}`);
  return token;
}

type Json = Record<string, unknown>;

export interface SeedResult {
  created: boolean;
  slug: string;
  emails: string[];
}

/** Seeds the demo workspace through `app`, whose outgoing mail lands in `mailer`. Idempotent per slug. */
export async function seedDemo(app: NestFastifyApplication, mailer: Mailbox, password: string, slug = SLUG): Promise<SeedResult> {
  const fastify = app.getHttpAdapter().getInstance();
  const SLUG_ = slug;

  const session = () => {
    let token: string | null = null;
    return async (method: 'GET' | 'POST' | 'PUT', url: string, body?: Json): Promise<Json> => {
      const r = await fastify.inject({ method, url, headers: token ? { authorization: `Bearer ${token}` } : {}, ...(body ? { payload: body } : {}) });
      const parsed = r.body ? (JSON.parse(r.body) as Json) : {};
      if (typeof parsed.accessToken === 'string') token = parsed.accessToken;
      if (r.statusCode >= 400) throw new Error(`${method} ${url} → ${r.statusCode} ${r.body}`);
      return parsed;
    };
  };

  {
    const admin = session();
    const adminEmail = `admin@${DOMAIN}`;
    const mailsBefore = mailer.jobs.length;
    try {
      await admin('POST', '/v1/auth/signup', { email: adminEmail, password, displayName: 'Ayşe Yılmaz', tenantName: 'Flexa Demo', tenantSlug: SLUG_, locale: 'tr-TR' });
    } catch (e) {
      if (e instanceof Error && e.message.includes('SLUG_TAKEN')) return { created: false, slug: SLUG_, emails: [] };
      throw e;
    }
    // A repeated sign-up of a known address answers 202 without a verification mail.
    if (!mailer.jobs.slice(mailsBefore).some((j) => j.template === 'verify_email' && j.to === adminEmail)) return { created: false, slug: SLUG_, emails: [] };
    await admin('POST', '/v1/auth/email/verify', { token: tokenOf(mailer, 'verify_email', adminEmail) });
    await admin('POST', '/v1/auth/login', { email: adminEmail, password });
    await admin('POST', '/v1/modules/crm/enable');

    const people: { key: string; role: string; name: string }[] = [
      { key: 'mert', role: 'manager', name: 'Mert Kaya' },
      { key: 'can', role: 'sales_rep', name: 'Can Şahin' },
      { key: 'zeynep', role: 'sales_rep', name: 'Zeynep Arslan' },
      { key: 'selin', role: 'call_agent', name: 'Selin Çelik' },
      { key: 'deniz', role: 'analyst', name: 'Deniz Koç' },
    ];
    const users = new Map<string, { id: string; call: ReturnType<typeof session> }>();
    for (const p of people) {
      const email = `${p.key}@${DOMAIN}`;
      await admin('POST', '/v1/invitations', { email, roleKey: p.role });
      const s = session();
      await s('POST', '/v1/invitations/accept', { token: tokenOf(mailer, 'invitation', email), password, displayName: p.name });
      const login = await s('POST', '/v1/auth/login', { email, password });
      users.set(p.key, { id: (login.user as { id: string }).id, call: s });
    }
    const can = users.get('can');
    const zeynep = users.get('zeynep');
    const selin = users.get('selin');
    if (!can || !zeynep || !selin) throw new Error('seed users missing');

    // Accounts and contacts (B2B), each owned by a sales rep.
    const accounts: { id: string; owner: typeof can }[] = [];
    const companies: [string, string, string, typeof can][] = [
      ['Anadolu Lojistik A.Ş.', 'anadolulojistik.com.tr', 'Lojistik', can],
      ['Boğaziçi Enerji', 'bogazicienerji.com', 'Enerji', can],
      ['Ege Tekstil San. Tic.', 'egetekstil.com.tr', 'Tekstil', zeynep],
      ['Kuzey Yazılım', 'kuzeyyazilim.io', 'Yazılım', zeynep],
      ['Marmara Gıda', 'marmaragida.com', 'Gıda', can],
    ];
    for (const [name, domain, industry, owner] of companies) {
      const a = await owner.call('POST', '/v1/accounts', { name, domain, industry, segments: ['b2b'], contactPoints: [{ kind: 'phone', value: '0212 444 00 00', isPrimary: true }] });
      accounts.push({ id: String(a.id), owner });
    }
    const contactNames: [string, string, string][] = [
      ['Burak', 'Aydın', 'Satın Alma Müdürü'], ['Elif', 'Demir', 'CFO'], ['Hakan', 'Yıldız', 'Genel Müdür'],
      ['Merve', 'Öztürk', 'Operasyon Direktörü'], ['Serkan', 'Aksoy', 'BT Müdürü'],
    ];
    const contacts: string[] = [];
    for (const [i, [first, last, title]] of contactNames.entries()) {
      const acc = accounts[i % accounts.length];
      if (!acc) continue;
      const slug = `${first}.${last}`.toLowerCase().normalize('NFD').replace(/[^a-z.]/g, '');
      const c = await acc.owner.call('POST', '/v1/contacts', {
        firstName: first, lastName: last, title, segments: ['b2b'], account: { id: acc.id, role: i === 0 ? 'decision_maker' : 'influencer' },
        contactPoints: [{ kind: 'email', value: `${slug}@example.com`, isPrimary: true }, { kind: 'phone', value: `0532 10${String(i).padStart(1, '0')} 20 3${String(i)}` }],
      });
      contacts.push(String(c.id));
    }

    // Team, product catalogue and prices: a general list, a B2B list and one customer agreement.
    const mert = users.get('mert');
    if (!mert) throw new Error('seed users missing');
    const team = await admin('POST', '/v1/teams', { name: 'Kurumsal Satış' });
    await admin('PUT', `/v1/teams/${String(team.id)}/members/${mert.id}`, { role: 'manager' });
    for (const rep of [can, zeynep]) await admin('PUT', `/v1/teams/${String(team.id)}/members/${rep.id}`, { role: 'member' });
    const tax = await admin('POST', '/v1/tax-rates', { name: 'KDV %20', rate: '20' });
    const catalog: [string, string, string, string, string][] = [
      ['LIS-CRM', 'CRM lisansı (yıllık)', 'Lisans', '2200', '4800'],
      ['LIS-CC', 'Çağrı merkezi lisansı (yıllık)', 'Lisans', '3100', '7200'],
      ['HZM-KUR', 'Kurulum hizmeti', 'Hizmet', '9000', '18000'],
      ['HZM-EGT', 'Eğitim (gün)', 'Hizmet', '4500', '9500'],
    ];
    const listOf = async (body: Json) => String((await admin('POST', '/v1/price-lists', { currency: 'TRY', ...body })).id);
    const general = await listOf({ name: 'Genel liste' });
    const b2bList = await listOf({ name: 'B2B 2026', segment: 'b2b' });
    const agreement = await listOf({ name: 'Anadolu Lojistik anlaşması', accountId: accounts[0]?.id });
    for (const [sku, name, category, cost, price] of catalog) {
      const p = await admin('POST', '/v1/products', { sku, name, category, taxRateId: tax.id, segments: ['b2b', 'b2c'], cost: { amount: cost, currency: 'TRY' } });
      const set = (list: string, breaks: [string, number][]) =>
        admin('PUT', `/v1/price-lists/${list}/products/${String(p.id)}`, { breaks: breaks.map(([minQty, factor]) => ({ minQty, unitPrice: (Number(price) * factor).toFixed(2) })) });
      await set(general, [['1', 1]]);
      await set(b2bList, [['1', 0.95], ['10', 0.9], ['50', 0.85]]);
      if (sku.startsWith('LIS')) await set(agreement, [['1', 0.8]]);
    }
    await admin('PUT', '/v1/fx-rates', { base: 'USD', quote: 'TRY', validOn: '2026-01-01', rate: '42.5' });

    // Opportunities across the pipeline.
    const stages = ['to_qualification', 'to_proposal', 'to_negotiation', 'win', null] as const;
    for (const [i, acc] of accounts.entries()) {
      const o = await acc.owner.call('POST', '/v1/opportunities', { name: `${companies[i]?.[0] ?? 'Firma'} — yıllık sözleşme`, accountId: acc.id, primaryContactId: contacts[i], amount: String(150_000 + i * 85_000), currency: 'TRY', expectedClose: `2027-0${String((i % 6) + 1)}-15` });
      const step = stages[i];
      if (step) await acc.owner.call('POST', `/v1/opportunities/${String(o.id)}/transition`, { transitionKey: step });
      await acc.owner.call('POST', '/v1/tasks', { title: `${companies[i]?.[0] ?? ''}: teklif takibi`, related: { type: 'opportunity', id: o.id }, dueAt: `2026-12-${String(10 + i)}T09:00:00Z` });
    }

    // Leads: call-center generated (B2C) and web leads (B2B); two converted.
    const leadSpecs: [ReturnType<typeof session>, Json][] = [
      [selin.call, { firstName: 'Ahmet', lastName: 'Kurt', segment: 'b2c', source: 'phone', contactPoints: [{ kind: 'phone', value: '0533 111 22 33' }] }],
      [selin.call, { firstName: 'Fatma', lastName: 'Er', segment: 'b2c', source: 'phone', contactPoints: [{ kind: 'phone', value: '0544 222 33 44' }] }],
      [can.call, { firstName: 'Kemal', lastName: 'Toprak', company: 'Toprak İnşaat', segment: 'b2b', source: 'web', score: 70, contactPoints: [{ kind: 'email', value: 'kemal@toprakinsaat.com' }] }],
      [zeynep.call, { firstName: 'Seda', lastName: 'Güneş', company: 'Güneş Medikal', segment: 'b2b', source: 'fuar', score: 55 }],
      [can.call, { firstName: 'Orhan', lastName: 'Ateş', company: 'Ateş Otomotiv', segment: 'b2b', source: 'referans', score: 85 }],
    ];
    const leadIds: string[] = [];
    for (const [call, body] of leadSpecs) leadIds.push(String((await call('POST', '/v1/leads', body)).id));
    const toConvert = leadIds[4];
    if (toConvert) {
      await can.call('POST', `/v1/leads/${toConvert}/transition`, { transitionKey: 'start' });
      await can.call('POST', `/v1/leads/${toConvert}/convert`, { opportunity: { amount: '420000', currency: 'TRY' } });
    }

    // Support cases and notes.
    const firstAccount = accounts[0];
    if (firstAccount) {
      const cs = await firstAccount.owner.call('POST', '/v1/cases', { subject: 'Fatura adresi güncellenmeli', accountId: firstAccount.id, channel: 'email', priority: 2 });
      await firstAccount.owner.call('POST', `/v1/cases/${String(cs.id)}/transition`, { transitionKey: 'start' });
      await firstAccount.owner.call('POST', '/v1/notes', { related: { type: 'account', id: firstAccount.id }, bodyText: 'Yıllık bütçe Ocak ayında onaylanıyor.' });
    }
    await admin('POST', '/v1/cases', { subject: 'Siparişim gecikti', channel: 'phone', segment: 'b2c', priority: 3 });

    return { created: true, slug: SLUG_, emails: [adminEmail, ...people.map((p) => `${p.key}@${DOMAIN}`)] };
  }
}
