# İlerleme

## P1 — Faz 1 + G1 çekirdeği: İskelet, kimlik doğrulama, multi-tenancy · 2026-11-20 · ✅

### Yapılanlar
- **Monorepo:** pnpm 10 + Turborepo, TypeScript 5.9 strict, ESLint (strict-type-checked + sabit renk yasağı + `pg` import yasağı), Prettier, lint-staged + husky, commitlint. Sürüm sabitleme gerekçesi: ADR-0001 eki.
- **`packages/db`:** DB rolleri (`runvara_owner` BYPASSRLS / `runvara_app` NOBYPASSRLS / `runvara_relay`), `0001_foundation.sql` (16 tablo, hepsi FORCE RLS, tenant tablolarında RESTRICTIVE politika, değiştirilemez `audit_log` ve `auth_events`, 9 SECURITY DEFINER çözümleyici), checksum'lı ve advisory-lock'lu migration koşucusu, `withTenant / withUser / withAnonymous`.
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
- Runvara adı için marka/alan adı araştırması yapılmadı (R-21).

### Sonraki adım
Q1–Q5 yanıtlandıktan sonra **P1** (Faz 1 + G1 çekirdeği): monorepo, Docker Compose, CI, kimlik doğrulama, RLS + DB rolleri, modül kayıt defteri/kapısı, tenant sızıntı testleri.
