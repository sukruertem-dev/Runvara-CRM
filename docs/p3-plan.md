# P3 — Faz 3 CRM nesneleri: uygulama planı

> 2026-11-20 · Dal `feat/p3-crm` (P2 dalı üzerine). Kaynak: prompt Faz 3, ADR-0004/0005/0010/0019. Bu dosya kararların kaydıdır; uygulama bundan sapacaksa önce burayı güncelleyin.

## Segment (ADR-0010) — P3'ten itibaren etkin
- `app.segments()` (oturum değişkeni `app.segments`) — `withTenant` her istekte doldurur.
- P4'teki kullanıcı segment yetkisi gelene kadar **etkin segment kümesi = tenant satış modu** (`b2b_only` → `{b2b}`, `b2c_only` → `{b2c}`, `both` → `{b2b,b2c}`), `TenantGuard` hesaplar.
- `record_registry` artık `segments segment[]` sütunu da taşır (kimlik kayıtları). RESTRICTIVE segment politikaları:
  - `accounts`, `contacts`: `segments && app.segments()`
  - `leads`, `opportunities`: `segment = ANY(app.segments())`
  - `cases`, `notes`, `tasks`, `record_registry`: `segment IS NULL OR segment = ANY(...)` (+ `segments` için `IS NULL OR &&`)
  - `contact_points`: sahibinin `record_registry` satırı görünür olmalı (EXISTS) → gizli segmentteki kişinin telefonu sızmaz.

## Tablolar (`0003_crm.sql`)
`accounts` (hiyerarşi `parent_account_id`, `domain`, `segments[]`, `merged_into`), `contacts` (`full_name` üretilmiş sütun, `segments[]`, `merged_into`), `account_contact_roles` (decision_maker|influencer|user|approver|other, `is_primary`), `contact_points` (owner = contact|account|lead → registry FK; phone → `e164`; email → küçük harf), `leads` (`segment`, workflow statüsü, `source`, `score`, `converted_at`), `lead_conversions`, `pipelines` (+ `pipeline_stages`: statü → olasılık), `opportunities` (`segment`, tutar `numeric(18,4)` + `currency`, `probability`, `probability_manual`, `expected_close`, `won_lost_reason`), `cases` (`channel`, `category`, `queue_id`, `segment` NULL), `notes` (polimorfik, `visibility` standard|private), `merges`. `pg_trgm` ile isim benzerliği indeksleri.

## Varsayılan iş akışları (tenant başına, `app.seed_crm_workflows`)
- **lead:** new (initial) → working → qualified; unqualified (closed), converted (closed, yalnızca dönüştürme servisi).
- **opportunity** (varsayılan pipeline): prospecting 10 → qualification 25 → proposal 50 → negotiation 75 → won 100 / lost 0 (lost: `won_lost_reason` zorunlu). Wildcard geçişlerle her aşamaya gidilebilir.
- **case:** new → in_progress ↔ waiting → resolved → closed; reopen.

## Kurallar
- **Lead dönüştürme** (`POST /v1/leads/{id}/convert`): tek transaction; Account (mevcut seçilebilir) + Contact + opsiyonel Opportunity + `lead_conversions` + lead statüsü `converted`; herhangi bir hata → hiçbir kayıt kalmaz. `Idempotency-Key` yerine ikinci çağrı `LEAD_ALREADY_CONVERTED`.
- **Olasılık:** aşama değişiminde `probability_manual = false` ise `pipeline_stages.probability`; manuel değer PATCH ile verilirse `probability_manual = true`.
- **Merge** (`POST /v1/{accounts|contacts}/merge` `{survivorId, mergedIds[], fieldChoices?}`): ilişkili task/note/contact_point/rol/opportunity/case kayıtları survivor'a taşınır, kaybedenler `merged_into` + soft delete, segmentler birleşir, `merges` kaydı + audit.
- **Mükerrer:** `GET /v1/{contacts|accounts}/{id}/duplicates` — aynı e-posta/E.164 (kişi) veya alan adı (firma) ya da isim benzerliği ≥ 0.45 (`pg_trgm`); yalnızca çağıranın görebildikleri.
- **Yetki:** görevlerle aynı `recordScope` (`own` = sahip veya oluşturan; P4'e kadar fail-closed).
- **Görev entegrasyonu:** `GET /v1/{type}/{id}/tasks`; görev `related` alanı CRM kayıtlarını kabul eder (hedef okunabilir olmalı).
- **RQL:** her nesne için alan kaydı (custom field'lar dahil, `resourceType` = nesne türü).

## Kabul kriterleri ↔ testler
| Kriter | Test |
|---|---|
| Lead dönüştürme atomik; hata durumunda hiçbir kayıt kalmaz | `crm.int.test.ts` (zorla hata: geçersiz pipeline → 0 yeni satır) |
| Opportunity aşama değişiminde olasılık doğru | aynı dosya |
| Merge sonrası ilişkili task/aktiviteler taşınır | aynı dosya |
| Tüm CRM nesnelerinde tenant izolasyonu | şema koruması (otomatik) + API çapraz tenant testleri + segment testleri |

## Uygulama notları (tamamlandı, 2026-11-20)
- **Tek kayıt motoru:** `apps/api/src/modules/crm/crm-objects.ts` her nesneyi bildirimsel tanımlar (tablo, görünüm sorgusu, RQL alanları, API görünümü); `crm.service.ts` ortak davranışı (liste, CRUD, `If-Match`, soft delete, geçiş, ilişkili görevler, iletişim noktaları), `crm-ops.service.ts` dönüştürme, merge ve mükerrer tespitini uygular. Liste motoru görevlerle ortak: `common/keyset-list.ts`.
- **Segment uygulaması:** `TenantGuard` segmentleri hesaplar, tüm istek işleyicileri `dbCtx(t)` ile transaction açar (kiracı + kullanıcı + segment tek yerden). RLS reddi (42501) `SEGMENT_NOT_ALLOWED` olarak döner; servis önce açık kontrol yapar.
- **Yetki:** `recordScope(ctx, action, resource)` artık kaynağı da alır: modül kapalıysa `none`, Matris A'daki `resources` daraltması uygulanır (B27).
- **Notlar:** `/v1/notes` (çekirdek modül) — üst kaydı okuyabilen görür, `private` yalnızca yazarına; yazma üst kaydın kaynağında `create` ister; düzenleme yalnızca yazar, silme yazar veya tenant genelinde `archive`.
- **Mükerrer:** e-posta / E.164 / alan adı eşleşmesi skor 1; aksi hâlde `pg_trgm` benzerliği ≥ 0.45 (aday süzgeci `%` operatörüyle indeksli).
- **Seed:** `pnpm --filter @flexa/api seed:demo` (`src/seed/demo.ts`) — demo çalışma alanını API üzerinden kurar (5 kullanıcı + Admin, firma, kişi, lead, fırsat, talep, görev, not); parola her çalıştırmada üretilir ve bir kez yazdırılır; tekrar çalıştırma bir şey yapmaz.
- **Ertelenen (bilinçli):** CRM nesneleri için özel workflow/pipeline oluşturma ve düzenleme API'si P6 ayar ekranlarıyla (şimdilik tenant başına varsayılan akışlar); lead'e bağlı görev/notların dönüştürmede taşınması yok (lead geçmişi olarak kalır); outbox olayları P5.
