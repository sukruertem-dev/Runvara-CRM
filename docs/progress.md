# İlerleme

## P2 — Faz 2: Task çekirdeği · 2026-11-20 · ✅ (CI PR'da çalışacak)

### Marka değişikliği (aynı dalda)
- Ürün adı **Runvara → Flexa** (kullanıcı kararı). Tek kaynak `packages/ui/brand.json`, kurallar `docs/brand.md` (kaynak prompt §12'nin yerini alır).
- Teknik ön ekler: `@flexa/*`, `flexa_owner/app/relay`, `FLEXA_*`, çerezler `fx_rt`/`fx_csrf`. Yeni palet (mor `#7B3CFF`, antrasit yan menü) token'lara döküldü: kontrast **90/90**. JSON'daki ikincil metin `#8B93A7` normal metin için yetersiz (2.92–3.07:1) olduğundan metinde `#646B7E` kullanılır; gerekçe `docs/brand.md` §3.
- Resmi logo çizimi verilmediği için **logo çizilmedi** ("Do not invent" kuralı); eski Runvara işareti kaldırıldı, arayüz yalnızca "Flexa" yazı markasını kullanır.
- **Yerel geliştirme:** 0001 migration'ındaki rol adları değiştiği için mevcut yerel Compose veritabanı eski şemayla uyumsuzdur: `docker compose down -v` ve `node scripts/dev-env.mjs --force` gerekir.

### Yapılanlar
- **Yeni paketler** (arayüzler `docs/p2-plan.md`):
  - `@flexa/query-lang` (RQL) — lexer, Pratt parser, Türkçe anahtar kelimeler, tip/operatör denetimi, saat dilimine duyarlı göreli tarihler, değerler daima parametre; 214 test (fast-check property: 600–3000 koşu, injection korpusu değer ve alan konumunda).
  - `@flexa/formula` — eval'siz formül dili, null semantiği, döngü tespiti; 39 test.
  - `@flexa/recurrence` — RRULE yerel duvar saatinde, DST boşluğu → sonraki geçerli dakika, çakışma → ilk oluşum; 26 test (Berlin, New York, İstanbul).
  - `@flexa/workflow` — durum makinesi (koşul, doğrulayıcı, post-function), fractional indexing, DAG döngü tespiti; 33 test.
- **`0002_tasks.sql`:** `record_registry` + bileşik FK (polimorfik bütünlük), kuyruklar (work/call tek kavram), workflow/status/geçiş, görevler (sahiplik CHECK'leri, derinlik ≤ 5 ve ebeveyn döngüsü trigger'ı), bağımlılık DAG trigger'ı (tenant başına advisory lock), etiketler, tekrar serileri, custom field tanımları, varsayılan görev akışı fonksiyonu (`app.seed_task_workflow`). 12 tablonun tamamı FORCE RLS + RESTRICTIVE (şema koruma testi otomatik doğruladı).
- **`@flexa/authz.recordScope`:** Matris A A08–A13/A24'ten kayıt kapsamı; ekip/kuyruk/segment kapsamı P4'e kadar **fail-closed** olarak "kendi kayıtları".
- **API (21 yeni uç nokta):** görev CRUD + soft delete/restore, `If-Match` iyimser kilit (428/412), geçişler (`/transition`, PATCH ile statü değişimi 409), fractional sıralama + yeniden dengeleme (`/move`), alt görevler + ilerleme, bağımlılıklar (döngü yolu raporlanır), toplu güncelleme (atomik/değil), tekrar serileri (kapanınca sonraki örnek, çift üretim imkânsız), workflow ve custom field yönetimi, RQL listeleme (imzalı, sorguya bağlı keyset cursor; NULLS LAST; alan seçimi; sayım), `/v1/rql/validate` ve `/v1/rql/fields`.

### Kabul kriterleri (Faz 2)
| Kriter | Durum | Kanıt |
|---|---|---|
| Geçersiz workflow geçişi reddediliyor, geçerlisi kaydediliyor | ✅ | `tasks.int.test.ts` (izinli liste, doğrulayıcı, closedAt) + `workflow` 33 birim |
| Döngü oluşturan bağımlılık engelleniyor | ✅ | API (yol raporlu), eşzamanlı ters kenar (biri 201 biri 422), API atlanınca DB trigger |
| Tekrarlayan görev kapanınca doğru tarihte yeni örnek (DST dahil) | ✅ | Berlin 2026-03-28 08:00Z → 2026-03-29 07:00Z, kapat-aç-kapat sonrası tek örnek |
| Sorgu dili SQL injection'a karşı güvenli (fuzz/property) | ✅ | `query-lang` property testleri + API'de injection korpusu (200, boş sonuç, tablo yerinde) |
| 10 bin kayıtla liste p95 < 200 ms | ✅ | `docs/perf/p2-task-list.md`: p95 30–33 ms (sayımlı 52 ms) |

### Testler
API entegrasyon **39/39** (P1 25 + P2 14), DB izolasyon 16/16, tüm birim test görevleri yeşil (23), lint/typecheck temiz, kontrast/matris/katalog PASS.

### Bilinen sınırlar
- Outbox/olay yayını, activity timeline ve audit'e görev olayları P4/P5'te (ADR-0006 notu); görev değişiklikleri henüz olay üretmez.
- Workflow **düzenleme** ve yayım sihirbazı (sürümleme) P6 ayar ekranlarıyla; şimdilik yeni workflow oluşturulabilir, mevcut düzenlenemez.
- Undo (toplu işlem geri alma) P6.
- Custom field ifade indeksleri (`indexed: true`) için `CREATE INDEX CONCURRENTLY` işi P5 worker'ında; şimdilik GIN `jsonb_path_ops`.
- Görece tarihler tenant saat diliminde hesaplanır; kullanıcı saat dilimi P7 (i18n) ile.

### Sonraki adım
**P3 — Faz 3 CRM nesneleri** (segment sütunlarıyla).

## P1 — Faz 1 + G1 çekirdeği: İskelet, kimlik doğrulama, multi-tenancy · 2026-11-20 · ✅

### Yapılanlar
- **Monorepo:** pnpm 10 + Turborepo, TypeScript 5.9 strict, ESLint (strict-type-checked + sabit renk yasağı + `pg` import yasağı), Prettier, lint-staged + husky, commitlint. Sürüm sabitleme gerekçesi: ADR-0001 eki.
- **`packages/db`:** DB rolleri (`flexa_owner` BYPASSRLS / `flexa_app` NOBYPASSRLS / `flexa_relay`), `0001_foundation.sql` (16 tablo, hepsi FORCE RLS, tenant tablolarında RESTRICTIVE politika, değiştirilemez `audit_log` ve `auth_events`, 9 SECURITY DEFINER çözümleyici), checksum'lı ve advisory-lock'lu migration koşucusu, `withTenant / withUser / withAnonymous`.
- **`packages/security`:** argon2id, Ed25519 JWT, TOTP (tekrar koruması), kurtarma kodları, AES-256-GCM zarf şifreleme (tenant DEK), CSRF.
- **`packages/modules`:** 13 modüllük katalog (tek kaynak `src/catalog.json`), bağımlılık grafiği, `planToggle` (bağımlılık, bağımlı modül, cascade), rota → modül eşlemesi.
- **`packages/authz`:** `permission-matrix.yaml`'dan derleme anında üretilen `can()` (modül kapısı → rol yetkisi → politika); P4'te kayıt kapsamı aynı giriş noktasına eklenecek.
- **`packages/contracts`:** Zod şemaları, hata kodu kataloğu, uç nokta listesi → OpenAPI 3.1.
- **`apps/api`:** kayıt (tenant + 5 sistem rolü + core modülü + DEK tek transaction), e-posta doğrulama, giriş (hesap varlığı sızdırmaz, zamanlama eşitlenmiş, kilit), TOTP 2FA, refresh rotasyonu + yeniden kullanım tespiti, CSRF, çıkış, parola sıfırlama (tüm oturumlar kapanır), tenant seçimi, davetler, modül aç/kapat (audit + authz_epoch), OIDC (PKCE, nonce, state, alan adı kontrolü, JIT = Analist), SSRF korumalı giden URL denetimi, helmet/CORS/Redis hız sınırı, request-id, log redaksiyonu, `/healthz` `/readyz`, `/openapi.json` + `/docs`, OpenTelemetry (OTLP uç noktası verilirse).
- **`apps/worker`:** BullMQ e-posta kuyruğu, TR/EN şablonlar (HTML kaçışlı), health uç noktaları.
- **`apps/web`:** (alt ajanla) giriş, kayıt, 2FA, tenant seçimi, güvenlik/davet/modül ayarları, davet kabulü, parola sıfırlama, OIDC dönüşü; yalnızca token'lar, aynı-köken `/api` proxy, CSP.
- **Altyapı:** Docker Compose (postgres 18, redis 7, mailpit, migrate, api, worker, web; host portları `.env` ile değiştirilebilir), çok aşamalı Dockerfile'lar, `scripts/dev-env.mjs`, GitHub Actions iş akışı (`.github/workflows/ci.yml`), README.

### Kanıt
| Paket | Sonuç |
|---|---|
| DB izolasyon (Testcontainers, PG18) | 16/16 — bağlamsız 0 satır, çapraz tenant okuma/güncelleme/ekleme engeli, `SET row_security=off` reddi, havuz sızıntısı yok, audit değiştirilemez, şema koruması |
| API entegrasyon (PG18 + Redis7) | 25/25 — kayıt/doğrulama, kilit, TOTP + tekrar, refresh reuse, CSRF, parola sıfırlama, davetler, API düzeyi tenant izolasyonu, modüller, OIDC (sahte IdP), hız sınırı, rota ↔ sözleşme eşleşmesi |
| Birim | config 2, security 11, modules 9, authz 8, contracts 4, worker 3, api (SSRF) 3 |
| E2E (Playwright, Compose yığını) | 4/4 — kayıt → doğrulama → giriş → 2FA → çıkış → 2FA ile giriş; tenant seçimi; axe /login ve /signup (kritik/ciddi ihlal yok) |
| Lint + typecheck + build | 25/25 turbo görevi temiz (web: tsc + eslint temiz) |
| `docker compose up --build --wait` | 6 servis sağlıklı, migrate çıkış 0 |
| Doğrulama betikleri | kontrast 79/79, yetki matrisi, modül kataloğu PASS |

### Kabul kriterleri (Faz 1)
| Kriter | Durum |
|---|---|
| `docker compose up` ile tüm servisler sağlıklı ayağa kalkıyor | ✅ |
| Kayıt → giriş → 2FA → tenant seçimi E2E | ✅ |
| Tenant izolasyon testleri (API ve DB) | ✅ |
| CI yeşil | ✅ GitHub Actions, PR #1 (sukruertem-dev/Runvara-CRM): `checks` ve `e2e` işleri yeşil |

### Test sırasında bulunup düzeltilen hatalar
- `withTenant` geçersiz kimlikte Promise reddi yerine senkron hata fırlatıyordu.
- Davet kabulünde `accepted_by` yabancı anahtarı, kullanıcı satırından önce yazılıyordu (500).
- SSRF koruması: `::ffff:0:0/96` alt ağı Node `BlockList`'inde tüm IPv4 adreslerini engelliyordu; eşlemeli adresler artık açılıp IPv4 kurallarıyla denetleniyor.
- Turborepo katı ortam modu `API_INTERNAL_URL`'i Next derlemesine iletmiyordu (web proxy 500).

### Bilinen sınırlar / sonraki fazlara bırakılanlar
- Plan hakkı kontrolü (MOD-04), yapılandırma motoru, blueprint'ler, SAML, operatör konsolu, kota → P7 (G1 kalanı).
- Yönetici davetleri ekip kapsamı gerektirir → P4'te ekiplerle (şimdilik `MANAGER_LIMIT`).
- AuthzContext her istekte DB'den yükleniyor (doğru ama önbelleksiz); Redis önbelleği P4'te.
- E-posta kuyruğa commit sonrası ekleniyor; çökme anında kayıp olursa kullanıcı "yeniden gönder" kullanır. Outbox'a geçiş P5.
- TOTP kurulumunda QR kod yok (gizli anahtar + otpauth URI metni); tasarım sistemiyle P6'da.
- Web'in `next build` standalone adımı Windows'ta symlink izni nedeniyle yerelde tamamlanmıyor; Linux/Docker derlemesi sorunsuz.

### Sonraki adım
**P2 — Faz 2 Task çekirdeği:** status/workflow motoru, custom field, bağımlılık DAG, RRULE, RQL sorgu dili, cursor API.

## P0 — Faz 0 + G0: Mimari ve gereksinim analizi · 2026-11-20 · ✅ tamamlandı (onay bekliyor)

### Yapılanlar
- Kaynak promptun tamamı (Bölüm 1–12) analiz edildi; 27 tespit (6 kritik) ve düzeltmeleri: `docs/requirements-review.md`.
- 22 ADR (`docs/adr/`), mimari doküman, bütünleşik faz planı.
- ER diyagramı: 11 alan diyagramı, 148 tablo (`docs/er-diagram.md`) — 13/13 Mermaid bloğu ayrıştırıcıdan geçti.
- API taslağı, olay kataloğu (80+ olay tipi), risk kaydı (25 risk), varsayımlar (43) + tek toplu soru (Q1–Q5).
- Makine okunur yetki matrisi `docs/enterprise/permission-matrix.yaml` (Matris A 36 satır, AI 16 satır, 10 demo kullanıcı, 34 karar senaryosu) — kaynak tablolarla **hücre hücre** doğrulandı.
- Modül manifest şeması + 13 modüllük katalog — şema, §10.3.1 bağımlılık tablosu ve döngü kontrolü geçti.
- `packages/ui/tokens.json` (tam tema paritesi) + kontrast raporu: 79/79 kontrol geçti.
- Alt ajanlarla (Sonnet) üretilen ve gözden geçirilen: izlenebilirlik tablosu (246 gereksinim, 122 kabul kriteri, 474 test ID), 115 kullanıcı hikâyesi, 22 ekran wireframe'i.

### Kabul kriterleri
| Kriter | Durum | Kanıt |
|---|---|---|
| F0: ER diyagramı tüm referans gereksinimleri kapsıyor | ✅ | `er-diagram.md` 11 alan; izlenebilirlikte DM-* satırları |
| F0: Her kritik karar bir ADR'ye bağlı | ✅ | `adr/README.md`; `requirements-review.md` her maddede ADR |
| F0: Klasör yapısı ve modül sınırları net | ✅ | `architecture.md` §3 |
| F0: Riskler için azaltma planı mevcut | ✅ | `risks.md` |
| G0: Her gereksinim bir faza ve en az bir teste bağlı | ✅ | `enterprise/requirements-traceability.md` (eksik ID yok, grep ile doğrulandı) |
| G0: Yetki matrisi YAML'ı 10.4 tablolarıyla birebir tutarlı | ✅ | `node scripts/check-permission-matrix.mjs` → PASS; negatif test hücre bozulmasını yakaladı |
| G0: Yönetici sınırları ve tenant çözümü kuralları istisnasız yazılı | ✅ | ADR-0004 §7, ADR-0003 §4, ADR-0015 §4 |
| G0: Palet kontrast raporu tüm metin çiftlerinde ≥ 4.5:1 | ✅ | `contrast-report.md` (düzeltmelerle; Q4 onayı bekleniyor) |

### Bilinen sınırlar
- Kaynak §4 DoD'deki "docker compose up / CI yeşil" maddeleri P0 için uygulanamaz (kod yok); doğrulama betikleri şimdilik `yaml`/`ajv` paketlerini kök `package.json` olmadan çalıştırıyor — P1'de devDependency olarak eklenip CI adımı yapılacak.
- Depoda uzak sunucu (remote) yok → CI kurulamadı (Q3).
- Flexa adı için marka/alan adı araştırması yapılmadı (R-21).

### Sonraki adım
Q1–Q5 yanıtlandıktan sonra **P1** (Faz 1 + G1 çekirdeği): monorepo, Docker Compose, CI, kimlik doğrulama, RLS + DB rolleri, modül kayıt defteri/kapısı, tenant sızıntı testleri.
