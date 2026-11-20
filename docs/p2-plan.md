# P2 — Faz 2 Task çekirdeği: uygulama planı ve sabit arayüzler

> 2026-11-20 · Kaynak: CRM_TASK_PLATFORM_PROMPT.md Faz 2, ADR-0005, 0008, 0018, 0019, 0020. Bu dosyadaki arayüzler paketler arasındaki **sözleşmedir**; değiştirmek için önce burayı güncelleyin.

## Paketler ve sahipleri

| Paket | İçerik | Bağımlılık |
|---|---|---|
| `packages/query-lang` (`@flexa/query-lang`) | RQL lexer, Pratt parser, AST, semantik denetim, Drizzle `SQL` derleyici | `drizzle-orm`, `luxon` |
| `packages/formula` (`@flexa/formula`) | Formül dili: parse, referans çıkarımı, döngü tespiti, saf yorumlayıcı | — |
| `packages/recurrence` (`@flexa/recurrence`) | RRULE doğrulama ve yerel duvar saatine göre sonraki örnek (DST) | `rrule`, `luxon` |
| `packages/workflow` (`@flexa/workflow`) | Durum makinesi değerlendirme, fractional indexing, bağımlılık DAG döngü kontrolü | `fractional-indexing` |
| `packages/db` migration `0002_tasks.sql` | Şema, RLS, `record_registry`, trigger'lar | — |
| `apps/api` `modules/tasks`, `modules/workflows`, `modules/custom-fields` | REST uç noktaları | hepsi |

Tüm paketler P1 kalıbını izler: CommonJS, `tsc -p tsconfig.build.json` → `dist`, `vitest run`, `eslint src`, TypeScript strict (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`). Placeholder/TODO yok; `any` yok; `!` (non-null assertion) kaynak kodda yok (testlerde serbest).

## 1. `@flexa/query-lang`

```ts
export type FieldType = 'text' | 'number' | 'date' | 'datetime' | 'bool' | 'uuid' | 'enum' | 'user';
export type CompareOp = '=' | '!=' | '<' | '<=' | '>' | '>=';
export interface FieldDef {
  sql: SQL;                       // column/expression, e.g. sql`t.due_at` or sql`(t.custom->>'cf_budget')::numeric`
  type: FieldType;
  sortable: boolean;
  enumValues?: readonly string[]; // required when type === 'enum'
  nullable?: boolean;             // IS EMPTY allowed (default true)
}
export type FieldRegistry = Readonly<Record<string, FieldDef>>;   // keys: 'status', 'owner', 'custom.cf_budget' …
export interface CompileContext {
  userId: string; timezone: string; now: Date;
  teamIds?: readonly string[]; queueIds?: readonly string[];
}
export class RqlError extends Error { code: 'RQL_SYNTAX' | 'UNKNOWN_FIELD' | 'BAD_OPERATOR' | 'BAD_VALUE' | 'LIMIT_EXCEEDED'; position: number }
export function parse(input: string): Query;                          // Query = { where: Expr | null; orderBy: OrderItem[] }
export function compile(q: Query, registry: FieldRegistry, ctx: CompileContext): { where: SQL | null; orderBy: SQL[] };
export function compileQuery(input: string, registry: FieldRegistry, ctx: CompileContext): { where: SQL | null; orderBy: SQL[] };
```
- Dilbilgisi ADR-0008 (EBNF), Türkçe eşanlamlılar `VE`, `VEYA`, `DEĞİL`, `BOŞ`, `İÇİNDE` → aynı token'lar; anahtar kelimeler büyük/küçük harf duyarsız (Türkçe İ/ı dahil: `toLocaleUpperCase('tr-TR')` ile karşılaştır).
- Değerler **her zaman** `sql` şablon parametresi; alan SQL'i yalnızca registry'den. `~` (içerir) → `ILIKE '%' || $n || '%'`, `%`, `_`, `\` kaçışlı (`ESCAPE '\'`).
- Fonksiyonlar: `me()`, `today()`, `now()`, `startOfWeek()`, `startOfMonth()`, `myTeams()`, `myQueues()`; göreli tarih `+7d`, `-2w`, `+3M`, `+12h`, `-30m`; `today()`/`startOf*` ve göreli tarihler `ctx.timezone`'da hesaplanıp UTC `Date` parametre olur. `date` tipli alanda karşılaştırma gün bazlı.
- Tip uyumu: `number` alanına metin → `BAD_VALUE`; `enum` değeri listede değilse `BAD_VALUE`; `user`/`uuid` alanında `me()` veya UUID; `IN` listesi ≤ 500; karşılaştırma ≤ 50; derinlik ≤ 10; metin ≤ 4096 karakter → `LIMIT_EXCEEDED`.
- `!=` NULL'ları da kapsar: `(x <> $1 OR x IS NULL)`. `IS EMPTY` → `x IS NULL` (metinde `OR x = ''`).
- `ORDER BY a DESC, b` → yalnızca `sortable` alanlar; `NULLS LAST` her zaman.
- Testler: birim (her kural + hata konumu) ve **fast-check** property testleri: (a) rastgele girdi → `parse` ya başarılı ya `RqlError`, başka istisna yok; (b) rastgele geçerli AST → derlenmiş SQL metni (`new PgDialect().sqlToQuery(sql)`) hiçbir değer literal'ini içermez, değerler `params` dizisinde; (c) injection korpusu (`' OR 1=1 --`, `; DROP TABLE`, `$1`, NUL, Unicode tırnaklar) hem değer hem alan konumunda.

## 2. `@flexa/formula`

```ts
export class FormulaError extends Error { code: 'FORMULA_SYNTAX' | 'FORMULA_UNKNOWN_REF' | 'FORMULA_TYPE' | 'FORMULA_LIMIT' | 'FORMULA_CYCLE'; position: number }
export interface Formula { readonly source: string; readonly refs: readonly string[] }
export function compileFormula(source: string, knownRefs: ReadonlySet<string>): Formula;
export function evaluate(f: Formula, record: Readonly<Record<string, unknown>>, now?: Date): number | string | boolean | null;
export function assertNoCycles(defs: readonly { key: string; formula: Formula | null }[]): void; // throws FORMULA_CYCLE with the cycle path
```
- ADR-0018: aritmetik `+ - * / %`, karşılaştırma, `AND OR NOT`, `IF(c,a,b)`, `ROUND(x[,n])`, `ABS`, `MIN`, `MAX`, `COALESCE`, `DAYS_BETWEEN(a,b)`, `TODAY()`, `CONCAT(...)`, `LEN(s)`; referans `{amount}` / `{custom.cf_x}`; sayı, `"metin"`, `true/false`, `null` sabitleri.
- **eval / Function / dinamik özellik erişimi yok**; yorumlayıcı AST üzerinde `switch`. ≤ 500 düğüm, ≤ 1 ms değerlendirme bütçesi (aşımda `FORMULA_LIMIT`), sıfıra bölme → `null`, null yayılımı (null içeren aritmetik → null).

## 3. `@flexa/recurrence`

```ts
export interface SeriesSpec { rrule: string; dtstartLocal: string /* 'YYYY-MM-DDTHH:mm' */; tzid: string }
export class RecurrenceError extends Error { code: 'RRULE_INVALID' | 'RRULE_UNSUPPORTED' | 'TZ_INVALID' }
export function validateSeries(spec: SeriesSpec): void;
/** Occurrence #index (0-based) as UTC instant, or null when the rule is exhausted (COUNT/UNTIL). */
export function occurrence(spec: SeriesSpec, index: number): Date | null;
/** First occurrence with index > afterIndex whose instant is > notBefore (catch_up = 'skip_missed'). */
export function nextOccurrence(spec: SeriesSpec, afterIndex: number, notBefore: Date | null): { index: number; at: Date } | null;
```
- ADR-0020: kural **yerel duvar saatinde** üretilir (rrule'a "floating" tarih verip luxon ile `tzid`'e yerleştir). Var olmayan yerel saat (ileri saat) → sonraki geçerli dakika; çift anlamlı (geri saat) → ilk oluşum.
- Desteklenen FREQ: DAILY, WEEKLY, MONTHLY, YEARLY; BYDAY, BYMONTHDAY, BYMONTH, INTERVAL, COUNT, UNTIL, BYSETPOS. SECONDLY/MINUTELY/HOURLY → `RRULE_UNSUPPORTED`. Kural metni ≤ 500 karakter; `index` ≤ 10 000.
- Testler: Europe/Istanbul, Europe/Berlin (2026-03-29 ileri, 2026-10-25 geri), America/New_York (2026-03-08, 2026-11-01); "her gün 09:00" DST boyunca 09:00 yerel kalır; "her gün 02:30" Berlin ileri saat gününde 03:00; ayın 31'i (BYMONTHDAY=31 kısa aylarda atlanır — rrule davranışı, testle sabitlenir); COUNT tükenmesi; `skip_missed`.

## 4. `@flexa/workflow`

```ts
export type StatusCategory = 'open' | 'in_progress' | 'closed';
export interface WfStatus { id: string; key: string; category: StatusCategory; isInitial: boolean }
export type Condition = { kind: 'role'; anyOf: string[] } | { kind: 'is_owner' } | { kind: 'field_present'; field: string } | { kind: 'field_equals'; field: string; value: string | number | boolean | null };
export type Validator = { kind: 'required_fields'; fields: string[] } | { kind: 'subtasks_closed' } | { kind: 'no_open_blockers' };
export type PostFunction = { kind: 'set_field'; field: string; value: string | number | boolean | null } | { kind: 'clear_field'; field: string } | { kind: 'assign_to_actor' };
export interface WfTransition { id: string; key: string; fromStatusId: string | null; toStatusId: string; conditions: Condition[]; validators: Validator[]; postFunctions: PostFunction[] }
export interface Workflow { statuses: WfStatus[]; transitions: WfTransition[] }
export interface TransitionFacts { actorUserId: string; actorRoleKeys: readonly string[]; ownerUserId: string | null; record: Readonly<Record<string, unknown>>; openSubtaskCount: number; openBlockerCount: number }
export type TransitionResult =
  | { ok: true; transition: WfTransition; patch: Record<string, unknown> }          // patch = post-function effects
  | { ok: false; code: 'WORKFLOW_TRANSITION_NOT_ALLOWED'; allowed: string[] }
  | { ok: false; code: 'WORKFLOW_CONDITION_FAILED'; failed: Condition[] }
  | { ok: false; code: 'WORKFLOW_VALIDATION_FAILED'; failed: { validator: Validator; fields?: string[] }[] };
export function validateWorkflow(wf: Workflow): void;               // exactly one initial status, transitions reference known statuses, unique keys
export function resolveTransition(wf: Workflow, fromStatusId: string, target: { transitionKey: string } | { toStatusId: string }, facts: TransitionFacts): TransitionResult;
export function allowedTransitions(wf: Workflow, fromStatusId: string, facts: TransitionFacts): WfTransition[]; // conditions pass (validators not evaluated)
// fractional ordering
export function keyBetween(before: string | null, after: string | null): string;   // wraps fractional-indexing + 4-char random suffix
export const REBALANCE_LENGTH = 32;
export function rebalance(count: number): string[];                               // n evenly spaced fresh keys
// dependency graph
export function wouldCreateCycle(edges: readonly (readonly [blocker: string, blocked: string])[], add: readonly [string, string]): string[] | null; // returns cycle path or null
```
- `fromStatusId: null` = "herhangi bir durumdan". Self-transition (aynı statüye) yasak. Validator'lar koşullar geçtikten sonra değerlendirilir.

## 5. Veri modeli (`0002_tasks.sql`) — ana noktalar
`record_registry`, `queues`/`queue_members` (kind work|call), `workflows`, `statuses`, `workflow_transitions`, `tasks`, `task_dependencies`, `tags`, `task_tags`, `task_series`, `custom_field_definitions`; tümü tenant RLS (RESTRICTIVE), `tasks` için `record_registry` trigger'ı ve `(tenant_id, related_type, related_id)` → `record_registry` bileşik FK (DEFERRABLE); alt görev derinliği ≤ 5 trigger; bağımlılık döngüsü DB trigger'ı (yinelemeli CTE) + servis katmanı kontrolü; GIN `custom jsonb_path_ops`; FTS `search tsvector` (simple + unaccent).

## 6. Yetki (P2 dilimi)
Görevler `*record*` izinlerini kullanır (Matris A A08–A13, A24). Kapsam: `all` → tüm tenant; `own` → `owner_user_id = me OR assignee_user_id = me OR created_by = me`; `team`/`queue`/`segment` P4'te — o zamana kadar **fail-closed** olarak `own` uygulanır (Yönetici kendi görevlerini görür, ekibini değil). `@flexa/authz` yeni fonksiyonu: `recordScope(ctx, action) → { kind: 'all' } | { kind: 'own' } | { kind: 'none' }`.

## 7. Kabul kriterleri ↔ testler
| Kriter | Test |
|---|---|
| Geçersiz workflow geçişi reddedilir, geçerlisi kaydedilir | `workflow` birim + API entegrasyon |
| Döngü oluşturan bağımlılık engellenir | `workflow` birim + DB trigger + API entegrasyon (eşzamanlı ekleme dahil) |
| Tekrarlayan görev kapanınca doğru tarihte yeni örnek (DST) | `recurrence` birim + API entegrasyon |
| Sorgu dili injection'a karşı güvenli (fuzz/property) | `query-lang` fast-check + PG'de `EXPLAIN` entegrasyonu |
| 10 bin kayıtta liste p95 < 200 ms | `apps/api/test/perf` + `docs/perf/p2-task-list.md` |
