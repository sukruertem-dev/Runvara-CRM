# İlerleme

## P5a — Faz 5: olay yolu ve kural motoru · 2026-11-21 · ✅ (CI PR'da çalışacak)

> Faz 5 iki adıma bölündü (`docs/p5-plan.md`): **P5a** olay yolu + kural motoru (bu adım), **P5b** SLA, webhook, API anahtarı, SSE, e-posta özeti.

### Yapılanlar
- **`0006_automation.sql`:** `outbox_events` (commit'te `NOTIFY`), `processed_events`, `automation_rules` (sürümlü, kimlik = son kaydeden Admin), `automation_runs` (girdi, koşul sonucu, aksiyonlar, süre, hata, deneme; `UNIQUE(kural, olay, kayıt)`), `dead_letters`, `assignment_policies`; otomasyon bildirimi; gelen webhook ve zamanlama için iki dar SECURITY DEFINER çözümleyici.
- **Olay yolu:** her kayıt değişikliği aynı transaction'da outbox'a yazılır (alan değeri yok, yalnızca alan adları). Relay (`flexa_relay`) → BullMQ `events` (iş kimliği = olay kimliği) → `automation` servisi.
- **Kural motoru:** tetikleyiciler (oluşturuldu, güncellendi, alan değişti, durum değişti, zamanlanmış/cron, gelen webhook), RQL koşulu (ilişkili firma alanları dahil), aksiyonlar (alan güncelle, görev oluştur, ata, bildirim, e-posta, durum geçişi). Kural JSON şeması `AutomationRuleDefinition` (P6 görsel editörü için).
- **Güvenlik önlemleri:** tam bir kez etki (kural × olay × kayıt tek transaction), döngü koruması (`halted_loop`, derinlik > 5 → `halted_depth`, ikisi de loglanır ve olay üretir), 8 deneme + üstel bekleme + tam jitter (üst sınır 15 dk), DLQ + replay, çalıştırma logu.
- **Atama politikaları:** round-robin (kilitli sıra), yük dengeli (açık görev/talep/aday sayısı), ekip veya kuyruk, yedek kullanıcı.
- **Compose:** `automation` servisi (API imajı, `EVENT_CONSUMERS=true`), worker'da relay. İşletim kılavuzu: `docs/ops/automation-dlq.md`.
- **CI hızlandırma:** Dockerfile'larda bağımlılık katmanı ayrı (`pnpm fetch`, yalnızca lockfile ile değişir) ve e2e işinde imaj katmanları GitHub Actions önbelleğinde (`docker/bake-action`). P4b'deki uzun e2e süresinin nedeni önbelleksiz imaj derlemesiydi.
- **API (12 yeni uç nokta).** Kararlar: `assumptions.md` B37–B40.

### Kabul kriterleri (P5a)
| Kriter | Durum | Kanıt |
|---|---|---|
| Döngüye giren iki kural limitte durur ve loglanır | ✅ | `automation.int.test.ts`: ping-pong → `halted_loop` + `automation.run.halted`; büyüyen zincir → 6 başarılı + `halted_depth` |
| Aynı olay iki kez işlense bile aksiyon bir kez | ✅ | aynı olay tekrar → boş; tüketici işareti silinse bile → `duplicate`; görev ve e-posta sayısı değişmez |
| Worker çökmesi sonrası olaylar kaybolmaz (kaos) | ✅ | relay yayınlayıp işaretlemeden "çöker", tekrar yayınlar: 12 kaydın her biri için tam 1 görev, bekleyen olay yok |
| Retry + DLQ + replay | ✅ | geçici hata → `failed`, son deneme → `dead` + DLQ; neden düzeltilip gerçek kuyruk/tüketiciyle replay → tek kez uygulanır |

### Testler
API entegrasyon **84/84** (+7), DB 18/18, birim/lint/typecheck temiz, matris/katalog PASS.

### Sonraki adım
**P5b** — SLA motoru (çalışma saati, tatil, DST), webhook'lar (HMAC, retry, devre dışı bırakma, `call_webhook` aksiyonu), API anahtarları + `Idempotency-Key`, SSE, bildirim e-posta özeti.


## P4b — Faz 4 + G2: kayıt etrafı · 2026-11-21 · ✅ (CI PR'da çalışacak)

### Yapılanlar
- **`0005_records.sql`:** `activity_events` (append-only: güncelleme trigger'la, silme uygulama rolünden yasak), `comments` + `comment_revisions`, `mentions`, `notifications` (+ tercihler; alıcı yalnızca kendi bildirimini okur), `attachments`, `delegations`, `access_requests`, `role_grant_overrides` + `matrix_versions`. Başkası adına bildirim oluşturma ve geri çekme dar kapsamlı iki SECURITY DEFINER fonksiyonuyla (tenant ve aktör oturumdan).
- **Activity timeline:** kayıt oluşturma, alan diff'i (API alan adlarıyla), durum geçişi, atama, silme/geri alma, dönüştürme, merge, yorum, dosya, e-posta/arama logu — iş yazımıyla aynı transaction'da. Okurken **FLS**: gizli alanın diff'i ve yalnızca onu değiştiren olay görünmez.
- **Yorumlar + mention (ADR-0017):** sunucuda üretilen güvenli HTML, düzenleme geçmişi (revizyon kontrolüyle), mezar taşı silme; hedef kaydı göremeyen kişi anılamaz (422, adlarıyla), ekip mention'ı erişimi olmayanları atlar, düzenlemede yalnızca yeni anılanlara bildirim, kaldırılanların okunmamış bildirimi geri çekilir.
- **Bildirimler:** `mention` ve `assigned`; okuma anında yetki (SCN-17: erişim kalkınca başlık, kayıt, aktör ve bağlantı boş), okundu / tümü okundu / okunmamış sayısı, kanal tercihleri (A28).
- **Dosya ekleri:** imzalı yükleme/indirme, boyut + dosya imzası doğrulaması, ClamAV kancası, karantina/enfekte dosya indirilemez, 25 MB ve MIME beyaz listesi.
- **Audit okuma (A23):** Admin tümü, Yönetici yalnızca ekip üyelerinin eylemleri; filtre + cursor.
- **Delegasyon (A07) ve yetki talebi:** süreli rol/segment devri ve iptali, onay/ret/geri çekme; Yönetici sınırları (`managed_teams_only`, `own_segments_only`, `no_escalation`, `not_self`) aynen.
- **Matris yönetimi (A03, AUTH-11):** tenant'a özel hücre değişikliği, diff önizleme, sürümler, geri alma; kapalı modül izinleri görünmez; Admin'in korunan izinleri değiştirilemez; motor override'ları her istekte bağlamdan okur.
- **Altyapı:** S3 istemcisi (`infra/storage.ts`), ClamAV istemcisi (`infra/scanner.ts`), Compose'a SeaweedFS + bucket kurulum adımı; testlerde SeaweedFS kapsayıcısı (MinIO imajları artık çekilemiyor, B33).
- **API (60 yeni uç nokta).** Kararlar: `assumptions.md` B33–B36.

### Kabul kriterleri (P4b)
| Kriter | Durum | Kanıt |
|---|---|---|
| Timeline: diff, geçiş, atama, oluşturma/silme; değiştirilemez | ✅ | `records.int.test.ts` + DB testi (uygulama UPDATE/DELETE yapamaz, sahibi bile UPDATE yapamaz) |
| Gizli alanın diff'i timeline'da görünmez | ✅ | aynı |
| Mention: erişimsiz hedef 422, ekip genişletme, yalnızca yeniye bildirim, geri çekme | ✅ | aynı |
| Bildirim okuma anında yetki (SCN-17) | ✅ | paylaşım kaldırılınca içerik boş |
| Dosya: imzalı yükleme/indirme, dosya imzası, yetkisiz indirme 404, enfekte dosya indirilemez | ✅ | SeaweedFS kapsayıcısıyla gerçek S3 akışı |
| Audit: Yönetici yalnızca ekibinin eylemleri | ✅ | aynı |
| Delegasyon süresi dolunca yetki kalkar (SCN-18); sınırlar | ✅ | aynı |
| Matris düzenleme sonraki istekte geçerli; diff; geri alma; korunan izin | ✅ | aynı |

### Testler
API entegrasyon **77/77** (+10), DB **18/18** (+1), birim testleri yeşil (zengin metin, ClamAV protokolü, dosya imzaları), lint/typecheck temiz, kontrast/matris/katalog PASS.

**Performans:** ✅ Temiz Docker ortamında (başka projelerin kapsayıcıları kaldırıldıktan sonra) tüm senaryolar hedefin çok altında: Admin sayım p95 58 ms, Yönetici (ekip + kural + parent erişimi) 65 ms, Yönetici sayım 74 ms (`docs/perf/p2-task-list.md`). Önceki koşulardaki 200 ms aşımları makine yükündendi: P4a (`main`) aynı yük altında aynı biçimde aşıyordu.

### Sonraki adım
**P5** — outbox relay, kural motoru, SLA, webhook, API anahtarı, SSE (bildirimlerin anlık iletimi ve e-posta özeti dahil).


## P4a — Faz 4 + G2: tek yetki motoru · 2026-11-21 · ✅ (CI PR'da çalışacak)

> P4 iki adıma bölündü (`docs/p4-plan.md`): **P4a yetki motoru** (bu adım) ve **P4b** kayıt etrafı (timeline, yorum/mention, dosya, bildirim, audit okuma, delegasyon, matris yönetimi).

### Yapılanlar
- **`0004_authz.sql`:** `user_segment_grants` (süreli), `teams` (üst ekip, döngü trigger'ı) + `team_members` (member/manager), rol hiyerarşisi (`roles.parent_role_id`, döngü trigger'ı), `sharing_defaults` (OWD), `record_shares` (kullanıcı/ekip, okuma/düzenleme; kaydı görünmüyorsa paylaşım satırı da görünmez), `sharing_rules` (RQL koşulu → ekip), `field_policies`; davetlere segment + ekip. Mevcut üyelere geriye uyumlu segment yetkisi verildi.
- **Segment = kullanıcı yetkisi ∩ satış modu**, `X-Segment` başlığı yalnızca daraltır (segment değiştirici).
- **Kayıt düzeyi motor** (`common/record-access.ts`): own / queue / team (alt ekipler dahil) / rol hiyerarşisi / OWD / manuel paylaşım / paylaşım kuralı → tek SQL predicate. Tekil okuma, liste, sayım ve yazma kontrolleri aynı yoldan; sonradan filtreleme yok. Görevler bağlı CRM kaydı üzerinden okunabilir (parent'tan türetilmiş erişim).
- **Alan düzeyi güvenlik:** gizli alan yanıtta yok, RQL/sıralama/`fields` için var olmayan alanla aynı `UNKNOWN_FIELD`; gizli alana yazma adını vermeden 403, salt-okunura yazma adıyla 403 `FIELD_READ_ONLY`.
- **Yönetici sınırları:** `managed_teams_only`, `own_segments_only`, `not_self`, `no_escalation`, `no_admin_assignment` (rol atama `canAssignRole`), Yönetici davetleri (yönettiği ekibe, Satış Temsilcisi, kendi segmentleri), yeniden atama ekip içinde.
- **API (40 yeni uç nokta):** ekipler ve üyeleri, kuyruklar ve üyeleri, kullanıcı erişim özeti, segment ve rol atama, rol hiyerarşisi, OWD, paylaşım kuralları, 6 nesnede manuel paylaşım, alan politikaları. Her değişiklik audit'li; yeniden atama da audit'e yazılır.
- Matristeki bir tutarsızlık çözüldü: kayıt dışı referans verisi okuması (A17, A26) rol atamada kapsam karşılaştırmasına girmez; aksi hâlde Yönetici Satış Temsilcisi atayamazdı (`assumptions.md` B28). Diğer kararlar B29–B32.

### Kabul kriterleri
| Kriter | Durum | Kanıt |
|---|---|---|
| Matristen otomatik üretilen test paketi (rol × eylem × kapsam × segment) | ✅ | `authz.int.test.ts`: `matrix.json`'dan bağımsız kâhin; 5 rol × okuma/düzenleme/arşiv/oluşturma × kendi/ekip arkadaşı/başka ekip/gizli segment |
| Yetkisiz kullanıcı göremez/değiştiremez; liste sayıları ve sayfalama doğru | ✅ | aynı paket: `count=true` toplamı ve tam liste, görünür kayıtlarla birebir |
| Gizli alan filtre/sıralama ile sızdırılamaz | ✅ | FLS testi: yanıt, `q`, `sort`, `fields`, yazma; Admin etkilenmez; kaldırma sonraki istekte geçerli |
| Rol hiyerarşisi ve paylaşım kuralı senaryoları | ✅ | hiyerarşi (görür / döngü reddi / geri alma), alt ekipler, OWD, manuel paylaşım, kriter kuralı |
| Karar senaryoları 10.4.4 | ✅ | SCN-01, 05 (audit'li), 06, 07, 08, 11 |
| Yetki değişikliği en geç bir sonraki istekte | ✅ | paylaşım, segment, rol ve süresi dolan segment aynı token ile sonraki istekte |
| Audit log'a UPDATE/DELETE DB tarafından reddedilir | ✅ | P1'den beri `rls.int.test.ts` |
| Yetki kontrollü listede p95 < 200 ms | ✅ | `docs/perf/p2-task-list.md`: Yönetici (ekip + kural + parent) p95 56 ms, sayımlı 78 ms |

### Testler
API entegrasyon **67/67** (+15), DB 17/17, birim testleri yeşil (authz'a kapsam ve rol atama testleri), perf yeşil, lint/typecheck temiz, kontrast/matris/katalog PASS.

### Sonraki adım
**P4b** — activity timeline, yorum + mention, dosya ekleri, bildirim temeli, audit okuma, delegasyon ve yetki talebi, matris yönetim API'leri.


## P3 — Faz 3: CRM nesneleri · 2026-11-20 · ✅ (CI PR'da çalışacak)

### Yapılanlar
- **`0003_crm.sql`:** `accounts` (hiyerarşi + döngü trigger'ı, alan adı), `contacts` (üretilmiş `full_name`), `account_contact_roles`, `contact_points` (E.164, küçük harf e-posta, sahibine registry FK), `leads`, `lead_conversions`, `pipelines` + `pipeline_stages` (aşama → olasılık), `opportunities` (`numeric(18,4)` + para birimi, manuel/otomatik olasılık), `cases`, `notes` (polimorfik, özel/standart), `merges`; `pg_trgm` isim indeksleri. 12 yeni tablonun tamamı FORCE RLS + RESTRICTIVE tenant politikası.
- **Segment RLS (ADR-0010) devrede:** `app.segments()`; CRM tablolarında, `tasks`, `notes` ve `record_registry`'de RESTRICTIVE `segment_isolation`; `contact_points` yalnızca sahibi görünürse görünür. Yeni şema koruma testi: segment sütunu olan her tablo segment politikası taşımalı.
- **Varsayılan akışlar** (`app.seed_crm_workflows`, migration + provisioning tek kaynak): lead (new → working → qualified / unqualified / converted), satış hattı (10/25/50/75/100/0; `win` tutar, `lose` gerekçe ister), destek talebi (new → in_progress ↔ waiting → resolved → closed, reopen).
- **API (56 yeni uç nokta):** 5 nesne için RQL'li liste, CRUD, `If-Match`, soft delete/restore, ilişkili görevler; lead/fırsat/talep geçişleri; iletişim noktaları; kişi–firma rolleri; atomik lead dönüştürme; firma/kişi merge ve mükerrer listesi; satış hatları; notlar. Görevler artık CRM kayıtlarına bağlanabilir ve kaydın segmentini devralır.
- **Yetki:** `recordScope` kaynağa duyarlı (modül kapısı + Matris A `resources`); `own` = sahip veya oluşturan; başkasına kayıt vermek `reassign`.
- **Seed:** `pnpm --filter @flexa/api seed:demo` — demo çalışma alanı API üzerinden (doğrulama, yetki ve RLS aynen uygulanır).
- Ayrıntılar ve kararlar: `docs/p3-plan.md`, `docs/assumptions.md` B24–B27.

### Kabul kriterleri (Faz 3)
| Kriter | Durum | Kanıt |
|---|---|---|
| Lead dönüştürme atomik; hata durumunda hiçbir kayıt kalmaz | ✅ | `crm.int.test.ts`: firma + kişi (iletişim noktaları, rol) + fırsat tek adımda; geçersiz pipeline → 422 ve tablo sayıları değişmez; ikinci çağrı 409 |
| Opportunity aşama değişiminde olasılık doğru | ✅ | 10 → 50, manuel 33 korunur, `probabilityManual:false` → 75, kazan → 100 + `closedAt`, yeniden açınca 75 |
| Merge sonrası ilişkili task/aktiviteler taşınır | ✅ | kişi: görev, not, iletişim noktası (mükerrer e-posta düşer), fırsat; firma: fırsat, talep, kişi rolü, alt firma |
| Tüm CRM nesnelerinde tenant izolasyonu | ✅ | şema koruması (otomatik, 17/17) + API çapraz tenant (id ile bile 404) + segment testi (b2b-only alanda b2c kayıt, görevi, notu ve telefonu görünmez — uygulama rolüyle DB'de de 0 satır) |

### Testler
API entegrasyon **52/52** (P1 25 + P2 14 + P3 13), DB izolasyon 17/17, birim testleri yeşil (authz'a kaynak daraltma testi eklendi), görev listesi perf testi yeşil (ortak liste motoruna geçiş sonrası), lint/typecheck temiz, kontrast/matris/katalog PASS.

### Bilinen sınırlar
- Kullanıcı bazlı segment yetkisi, ekip/kuyruk kapsamı ve FLS P4'te (şimdilik segment = tenant satış modu, kapsam fail-closed `own`).
- CRM için özel workflow/pipeline yönetimi P6 ayar ekranlarıyla.
- CRM ekranları P6 (bu adım yalnızca API + veri katmanı).
- Outbox olayları ve activity timeline P4/P5.

### Sonraki adım
**P4 — Faz 4 + G2:** tek yetki motoru (predicate, rol hiyerarşisi, OWD, sharing, FLS, kullanıcı segment yetkisi), timeline, yorum, dosya, audit, bildirim temeli.


## P2 — Faz 2: Task çekirdeği · 2026-11-20 · ✅ (CI PR'da çalışacak)

### Marka değişikliği (aynı dalda)
- Ürün adı **Runvara → Flexa** (kullanıcı kararı). Tek kaynak `packages/ui/brand.json`, kurallar `docs/brand.md` (kaynak prompt §12'nin yerini alır).
- Teknik ön ekler: `@flexa/*`, `flexa_owner/app/relay`, `FLEXA_*`, çerezler `fx_rt`/`fx_csrf`. Yeni palet (mor `#7B3CFF`, antrasit yan menü) token'lara döküldü: kontrast **90/90**. JSON'daki ikincil metin `#8B93A7` normal metin için yetersiz (2.92–3.07:1) olduğundan metinde `#646B7E` kullanılır; gerekçe `docs/brand.md` §3.
- Resmi Flexa logosu `packages/brand/`'e eklendi (verilen SVG birebir + açık zemin ve yalnız sembol türevleri); giriş ekranı ve favicon bu dosyaları kullanır.
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
