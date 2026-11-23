# P7 — G1 kalanı: tenant platformu · uygulama planı

> 2026-11-23 · Kaynak: prompt §10.2 (TEN, MOD, CFG), §10.3.2 (katmanlar), Faz G1, ADR-0011 (yapılandırma, blueprint, marka), ADR-0014 (modül, kota, adalet, operatör). P1'de G1'in çekirdeği (tenant yaşam döngüsü, modül kayıt defteri ve kapısı, OIDC, sızıntı iskeleti) yapıldı. Kalan iş tek PR için çok büyük; üç adıma bölündü:
> - **P7a (bu dal, `feat/p7a-config`):** yapılandırma motoru (anahtar kayıt defteri, katmanlar, JSON Schema, sürüm, diff, geri alma, audit, olay), tenant yerelleştirmesi (CFG-07), marka (CFG-06), sunucu tarafı kullanıcı tercihleri ve bunların **ekranları**.
> - **P7b:** blueprint'ler ve yapılandırma dışa/içe aktarma (CFG-04/05), onboarding sihirbazı, plan/kota/kullanım ölçümü ve plan hakkı (MOD-04), gürültülü komşu koruması (TEN-10), modül kataloğu ve kullanım ekranları.
> - **P7c:** Platform Operatörü konsolu ve destek erişimi (TEN-08), tenant yaşam döngüsü, tenant dışa aktarma ve silme (crypto-shredding), yedekten geri yükleme prosedürü, sızıntı test paketinin genişletilmesi (önbellek, kuyruk, SSE, dosya, arama) ve ekranları.
> - **P7d:** tenant SSO (SAML) ve parola/2FA güvenlik politikaları (TEN-04) ve ekranları. P7c tek PR için çok büyüdüğünden ayrıldı.

## 1. Yapılandırma anahtarları (`packages/config`)
- `src/settings/` altında **kayıt defteri**: her anahtar kodda tanımlıdır ve şunları bildirir:
  - JSON Schema 2020-12;
  - varsayılan (platform katmanı);
  - `overridableAt: ('tenant'|'team'|'user')[]`;
  - sahibi modül;
  - `schemaVersion` + yükseltme fonksiyonları.
  Kayıtsız anahtar okunamaz ve yazılamaz (404 `CONFIG_KEY_UNKNOWN`).
- Doğrulama: Ajv 2020 (`strict`, `allErrors`). Şemalar derleme anında bir kez derlenir. Hata → 422 `CONFIG_INVALID` (JSON Pointer'lı hata listesi).
- **Birleştirme:** `platform → tenant → team → user`. Nesneler derin birleşir; diziler ve skalerler tamamen değişir. İzin verilmeyen katmana yazma → 422 `CONFIG_KEY_NOT_OVERRIDABLE`.
- **Diff:** RFC 6902 JSON Patch (`add`/`remove`/`replace`). Diziler öğe öğe değil, tümüyle `replace` edilir (birleştirme kuralıyla tutarlı).
- P7a anahtarları:

| Anahtar | Katmanlar | İçerik |
|---|---|---|
| `locale` | tenant, user | `language` (`tr`/`en`), `timezone` (IANA), `dateFormat` (`dmy`/`mdy`/`ymd`), `weekStart` (`monday`/`sunday`), `timeFormat` (`24h`/`12h`) |
| `currency` | tenant | `code` (ISO 4217), `decimals` |
| `brand` | tenant | `accent` (hex), `logoAssetId` (uuid \| null) |
| `ui` | tenant (varsayılan), user | `theme` (`system`/`light`/`dark`), `density` (`comfortable`/`compact`) |
| `notifications.defaults` | tenant | Bildirim türü başına varsayılan kanallar (kullanıcının kendi satırı yoksa uygulanır) |

  - CFG-02'nin kalan anahtarları (disposition, numaralandırma, vergi, teklif ve e-posta şablonları, telefoni, saklama politikası) sahibi modül geldiği fazda bu kayıt defterine eklenir: P8, P9 ve P10.
  - Pipeline, workflow, custom field ve SLA kendi tablolarında ve kendi sürümleriyle kalır (P2/P5/P6c); blueprint ve dışa aktarma (P7b) onları doğal anahtarla taşır.
- `locale.timezone` ve `currency.code` yazıldığında `tenants.timezone`/`currency` sütunları aynı transaction'da güncellenir. SLA ve görece tarih hesapları bu sütunları okumaya devam eder.

## 2. Depolama ve API
- Migration `0011_config.sql`:
  - `tenant_settings`: değişmez sürüm satırları;
  - `tenant_settings_head`;
  - `tenant_assets`: logo, veritabanında `bytea` olarak (≤ 512 KB). Nesne depolama gerekmez ve satır tenant dışa aktarma/silme ile birlikte gider (B61).
  Hepsi RLS'li. `tenant_settings` yalnızca eklenebilir.
- Uç noktalar:

| Uç nokta | Yetki | Not |
|---|---|---|
| `GET /v1/config` | üyelik | Çağıran için birleşik değerler + her anahtarın katman kaynağı |
| `GET /v1/config/keys` | `tenant.config.read` | Kayıt defteri: şema, varsayılan, katmanlar |
| `GET /v1/config/{key}?scope=` | tenant: `tenant.config.read`; user: kendisi | Katman değeri, sürüm (`ETag`) |
| `POST /v1/config/{key}/preview?scope=` | yazma yetkisi | Doğrulama + JSON Patch + etki özeti (marka için türetilmiş renkler) |
| `PUT /v1/config/{key}?scope=` | tenant: `tenant.config.manage`; user: kendisi | `If-Match` zorunlu (ilk yazımda `If-Match: 0`); yeni sürüm + audit + `config.changed` |
| `DELETE /v1/config/{key}?scope=user` | kendisi | Kullanıcı geçersiz kılmasını kaldırır (üst katmana döner) |
| `GET /v1/config/{key}/history?scope=` | okuma yetkisi | Sürümler, yazan, not, önceki sürüme göre diff |
| `POST /v1/config/{key}/revert` | yazma yetkisi | `{version}` → o sürümün değeri **yeni** sürüm olarak yazılır |
| `POST /v1/brand/logo` | `tenant.config.manage` | PNG/WebP ≤ 512 KB veya temizlenmiş SVG |
| `GET /v1/brand/logo` | üyelik | Logonun kendisi (kısa önbellek, `ETag`) |

  - `scope` değerleri `tenant` veya `user`. Ekip katmanı motorda desteklenir; ilk ekip anahtarları (hedefler, ekip panosu) P8 ile gelir.
  - Kullanıcı katmanının kimliği **her zaman** doğrulanmış kullanıcıdır; istekten alınmaz.
- `config.changed` olayı outbox'tan SSE'ye gider: `{key, scope, version}`, değer olmadan. Açık sekmeler `GET /v1/config` ile tazelenir.

## 3. Marka (CFG-06)
- `deriveAccent(hex)`:
  - OKLCH uzayında her tema için `accent`, `accent-hover`, `accent-soft`, `accent-btn` ve `accent-btn-hover` türetilir.
  - Ton ve doygunluk korunur; yalnızca açıklık 0,005'lik adımlarla ayarlanır. Açık temada açıklık 0,30'dan fazla değişmek zorundaysa renk reddedilir (B62).
  - Sonuç `tokens.json`'daki `tenantAccent: true` kontrollerinin tümünü sağlamalıdır.
  - Sağlanamazsa 422 `BRAND_CONTRAST_UNSATISFIABLE`.
  - Önizleme özgün ve düzeltilmiş değerleri ve her kontrolün oranını döndürür.
- Tek kaynak `packages/ui/tokens.json`. Türetme `packages/config`'te saf bir fonksiyondur; API ve web aynı kodu kullanır.
- Saklanan yalnızca seçilen renktir; türetme saf ve deterministik olduğundan okumada yapılır. `GET /v1/config` `brand.tokens` döndürür ve kabuk bunları `<html>` üzerinde CSS değişkeni olarak uygular. Flexa işareti ve temel token'lar değişmez.
- **SVG temizleme:** izin listesine dayalı ayrıştırıcı.
  - Yalnızca şekil, yol, gradyan, `g` ve `defs` öğeleri kalır.
  - `script`, `foreignObject`, `style`, olay öznitelikleri ve harici veya `javascript:` referansları kaldırılır.
  - Ayrıştırılamayan dosya 422 alır.

## 4. Kullanıcı tercihleri (B51'in yerine)
- Tema, yoğunluk, dil, saat dilimi ve tarih biçimi sunucuda (`scope=user`) tutulur.
- `localStorage` yalnızca ilk boyamada titremeyi önleyen önbellektir; sunucu değeri gelince onu ezer.
- Tarih ve saat biçimlendirme (`lib/format.ts`) birleşik `locale` değerini kullanır.
- Arayüz dili değişince mesaj kataloğu (tr/en) değişir.

## 5. Ekranlar
- **Ayarlar → Genel:** tenant dili, saat dilimi (aranabilir IANA listesi), tarih ve saat biçimi, hafta başlangıcı, para birimi, varsayılan tema ve yoğunluk, varsayılan bildirim kanalları. Kaydetmeden önce diff önizlemesi gösterilir.
- **Ayarlar → Marka:**
  - renk seçici + hex alanı;
  - özgün ve düzeltilmiş renk yan yana, açık ve koyu temada canlı örnek (düğme, bağlantı, seçili satır);
  - kontrol listesi (oran, eşik);
  - logo yükleme ve kaldırma.
- **Ayarlar → Yapılandırma geçmişi:** anahtar seçimi, sürüm listesi (yazan, zaman, not), JSON Patch diff görünümü, "Bu sürüme dön" (onaylı, nedenli).
- **Kişisel tercihler** (kullanıcı menüsü → Tercihler): tema, yoğunluk, dil, saat dilimi, tarih biçimi. Her biri için "tenant varsayılanını kullan" seçeneği vardır.
- Salt okuma yetkisi (Yönetici: A02 `R`): form devre dışı ve geçmiş görünür; geri alma düğmesi yoktur.

## 6. Testler ve kabul

| Ölçüt | Kanıt |
|---|---|
| Şema dışı değişiklik reddediliyor | birim (Ajv, her anahtar) + entegrasyon 422 `CONFIG_INVALID` |
| Diff gösteriliyor, geri alınabiliyor | entegrasyon: preview patch'i, revert = yeni sürüm, geçmiş korunur; E2E geçmiş ekranı |
| İzin verilmeyen katman reddediliyor | entegrasyon 422 `CONFIG_KEY_NOT_OVERRIDABLE` |
| Eşzamanlı yazım | entegrasyon 412 (`If-Match`) |
| Katman birleştirme | birim (derin birleştirme, dizi değişimi) + entegrasyon (kullanıcı geçersiz kılması / silinmesi) |
| Marka rengi kontrastı ihlal edince engelleniyor | birim (türetme; sağlanamayan renk) + entegrasyon 422 + E2E |
| SVG temizleme | birim: script, olay özniteliği, harici href, foreignObject |
| Yetki | entegrasyon: Yönetici okur ama yazamaz (403), Satış okuyamaz (403), başkasının kullanıcı katmanı okunamaz |
| Tenant izolasyonu | entegrasyon: A'nın ayarı ve logosu B'den görünmez; DB sızıntı testine yeni tablolar eklenir |
| Audit ve olay | entegrasyon: `config.changed` outbox satırı + audit |
| Erişilebilirlik | E2E axe: Genel, Marka, Geçmiş, Tercihler |

---

# P7b — blueprint'ler, dışa/içe aktarma, onboarding, plan/kota, gürültülü komşu

> Dal `feat/p7b-blueprints`. Kaynak: CFG-04/05, MOD-01…04, TEN-09/10, ADR-0011 §3, ADR-0014 §3–4.

## 7. Yapılandırma paketi (`flexa.config/1`)
- Tek biçim hem blueprint'i hem tenant dışa aktarmasını taşır (`packages/contracts` `ConfigBundle`). Kimlikler **doğal anahtarla** eşlenir, UUID taşınmaz.
- İçerik:
  - `salesMode`;
  - `modules[]` (etkin modüller);
  - `settings{key: value}` (P7a kayıt defterindeki tenant katmanı anahtarları);
  - `customFields[]` (`resourceType` + `key`);
  - `taskWorkflows[]` (`key`; durumlar ve geçişler durum anahtarıyla);
  - `calendars[]` ve `slaPolicies[]` (ad ile, politika takvimi adıyla gösterir);
  - `tags[]` (ad);
  - `queues[]` (`kind` + ad).
- Taşınmayanlar (B67):
  - CRM süreçleri ve pipeline'lar: varsayılanlar her tenant'ta tohumlanır; düzenleyici P8'de gelir.
  - Otomasyon kuralları: bir kullanıcı adına çalışırlar; başka tenant'ta o kullanıcı yoktur.
  - Roller ve yetki matrisi.
  - Gizli değerler: API anahtarları, webhook sırları, logo.
- **Plan (kuru çalıştırma):** saf fonksiyon `planBundle(current, incoming)`. Her öğe için `create`, `update`, `unchanged` veya `conflict` döner:
  - Ayarlar sürümlü ve geri alınabilir olduğundan farklı değer `update` olur.
  - Diğer tanımlarda aynı anahtarla farklı tanım `conflict` olur.
  - Eksik bağımlı modül ve plan dışı modül her zaman engelleyici `conflict`tır.
- **Uygulama:**
  - `onConflict: 'fail' | 'keep'`. `fail` iken çakışma varsa 409 `IMPORT_CONFLICTS` döner ve hiçbir şey yazılmaz. `keep` mevcut tanımı korur ve öğeyi atlar.
  - Tek transaction. Plan aynı transaction içinde yeniden hesaplanır; ekranda görülen plan bayatsa sonuç yine tutarlıdır.
  - Ayar yazımları P7a motorundan geçer (sürüm + audit + olay). Diğer öğeler mevcut ayar API'lerinin doğrulamasını kullanır (workflow motoru, formül derleyici).
  - Tek audit `config.imported`: kaynak, sayımlar.
- **Blueprint'ler:** `packages/config/src/blueprints/`: `enterprise-b2b`, `retail-b2c`, `telesales-callcenter`. Açılışta şemayla doğrulanır; geçersiz blueprint süreci durdurur.

## 8. Onboarding (B66)
- Yeni tenant `onboarding` anahtarı (`status: pending`) ile doğar; P7b öncesi tenant'lar için platform varsayılanı `completed`'dır.
- Admin ana sayfada "Kurulumu tamamla" kartını görür. Akış zorunlu değildir; atlanabilir (`skipped`).
- Sihirbaz `/onboarding`:
  1. sektör şablonu (3 kart + "boş başla");
  2. satış modu (B2B / B2C / her ikisi);
  3. modüller (büyük kartlar; plan ve bağımlılık uyarısı);
  4. özet (kuru çalıştırma) → uygula.
- Telefoni bağlantı sihirbazı P9'da eklenir.

## 9. Plan, kota, kullanım (TEN-09, MOD-04)
- Planlar kodda: `packages/modules/src/plans.json`.
  - `trial`, `starter`, `growth` ve `enterprise`.
  - Her planın bir modül kademesi (`tier`; katalogdaki `planEntitlement.includedIn` ile eşleşir) ve sınırları vardır.
  - Sınır boyutları: `users`, `storage_bytes`, `records`, `call_minutes`, `ai_tokens`, `api_rpm`, `api_rpm_per_user`.
- `tenant_plans`: plan, ek modüller (`add_ons`), sınır geçersiz kılmaları, deneme bitişi.
  - Yeni tenant `trial` ile açılır. Göç öncesi tenant'lar `enterprise` alır; davranış değişmez.
  - Plan değişikliği P7c'deki operatör konsolunun işidir.
- **MOD-04:** Plan kademesine dahil olmayan modül, ek modül olarak satın alınmadıkça açılamaz (402 `MODULE_NOT_IN_PLAN`). Modül listesi her modülün plan durumunu döndürür.
- **Ölçüm:**
  - Anlık sayılan boyutlar: aktif üye + bekleyen davet, ek dosya ve logo baytları, ana kayıt sayısı (müşteri, kişi, aday, fırsat, vaka, görev).
  - Sayaç boyutları: API isteği, arama dakikası, AI token'ı. Redis'te `INCRBY` ile tutulur; dakikalık iş `tenant_usage_counters`'a (gün × boyut) aktarır ve anlık değerlerin günlük görüntüsünü yazar.
- **Eşikler (ADR-0014 §3):**
  - %80: uyarı.
  - %100: yumuşak. Yeni davet ve yeni yükleme engellenir (402 `QUOTA_EXCEEDED`).
  - %120: sert. Kayıt oluşturma engellenir.
  - Okuma ve dışa aktarma asla engellenmez.
  - Her eşik dönem başına bir kez Admin'lere e-posta, audit (`quota.threshold`) ve olay üretir. Kabukta uyarı şeridi gösterilir.

## 10. Gürültülü komşu (TEN-10)
- **API:**
  - Tenant başına ve kullanıcı başına token bucket (Redis Lua, atomik). Sınırlar plandan gelir.
  - Aşımda 429 `RATE_LIMITED` + `Retry-After`.
  - Mevcut IP başına genel sınır yerinde kalır.
- **Kuyruk:**
  - Olay kuyruğu `EVENT_SHARDS` (varsayılan 4) parçaya bölünür; parça `hash(tenantId) mod N` ile seçilir.
  - Parça içinde tenant başına eşzamanlılık semaforu (Redis sıralı küme, kilit süresi dolunca kendiliğinden düşer). Dolu ise iş kısa gecikmeyle yeniden sıraya girer (`DelayedError`).
  - Eski tek kuyruk geçiş için boşaltılarak tüketilmeye devam eder.
- **DB:** `statement_timeout` 5 sn (P1'den beri istemci düzeyinde).

## 11. Ekranlar
- **Ayarlar → Modüller** (tasarım sistemine taşındı): katalog kartları, plan/ek modül rozeti, bağımlılık uyarısı, zincirleme kapatma onayı, satış modu seçimi.
- **Ayarlar → Kullanım ve plan:** plan adı, deneme bitişi, ek modüller; her boyut için ölçer (kullanılan/sınır, eşik durumu); son 30 günün API isteği grafiği.
- **Ayarlar → İçe/dışa aktarma:** dışa aktar (JSON indir); dosya seç → kuru çalıştırma tablosu (oluştur/güncelle/aynı/çakışma) → çakışma politikası → uygula; blueprint uygulama.
- **Onboarding sihirbazı** (`/onboarding`) ve ana sayfa kartı.

## 12. Testler ve kabul
| Ölçüt | Kanıt |
|---|---|
| Blueprint uygulanabiliyor | entegrasyon: üç blueprint de boş tenant'ta kuru çalıştırma ve uygulama; E2E onboarding |
| Dışa/içe aktarma | entegrasyon: A'dan dışa aktar → B'ye içe aktar → B'nin dışa aktarması eşit; çakışma raporu ve 409; `keep` |
| Plan dışı modül | entegrasyon 402 `MODULE_NOT_IN_PLAN`; ek modülle açılır |
| Kota | entegrasyon: davet sınırı (%100), kayıt sınırı (%120), okuma engellenmez; eşik audit/olay bir kez |
| Hız sınırı | entegrasyon: tenant ve kullanıcı bucket'ı 429 + `Retry-After`; başka tenant etkilenmez |
| Kuyruk adaleti | birim: parça seçimi, semafor; entegrasyon: ağır tenant'ın işleri diğer tenant'ın işini bekletmez |
| Yetki ve izolasyon | entegrasyon: Yönetici içe aktaramaz (403); A'nın kullanımı B'den görünmez; DB sızıntı testine yeni tablolar |
| Erişilebilirlik | E2E axe: Modüller, Kullanım, İçe/dışa aktarma, Onboarding |

---

# P7c — operatör konsolu, destek erişimi, tenant dışa aktarma ve silme

> Dal `feat/p7c-operator`. Kaynak: TEN-01/02/05/08/11, ADR-0014 §5–6, B12, B16.

## 13. Platform Operatörü
- `platform_operators` (global): kullanıcı + rol. Operatör ayrı bir kimlik değil; operatör olarak işaretlenmiş bir kullanıcıdır. Operatör uç noktaları (`/v1/operator/*`) üç koşul arar:
  - oturum tenant'a bağlı değil;
  - kullanıcı operatör;
  - oturum ikinci faktörle açılmış (`amr` içinde `otp` veya `recovery`).
- İlk operatör `scripts/grant-operator.mjs` ile sahip bağlantısından eklenir. Uygulama rolü bu tabloya yazamaz.
- Operatörün tenant verisine varsayılan erişimi yoktur. Tenant listesi yalnızca üst veriyi gösterir; tenant listesi bir SECURITY DEFINER fonksiyonundan okunur, fonksiyon çağıranın operatör olduğunu denetler. Ad, adres, durum, plan, kullanım ve üye sayısı vardır; kayıt içeriği yoktur.
- **Yetenekler:**
  - tenant açma (TEN-01; ilk Admin e-postayla davet edilir);
  - plan, ek modül, sınır ve deneme bitişi;
  - durum geçişi (ADR-0014 §5, nedenli);
  - destek erişimi talebi.
- Her operatör eylemi iki yere yazılır: tenant audit'ine (`actor_type = operator`) ve global `operator_actions` tablosuna. Tenant silinse de operatör kaydı kalır.
- Arayüz: ayrı uygulama yerine `apps/web` içinde ayrı alan (`/operator`), kendi düzeni ve kendi API korumasıyla (B72, B16'nın yerine).

## 14. Destek erişimi (TEN-08)
- Akış:
  1. Operatör talep açar: gerekçe, isteğe bağlı modül kapsamı, süre 15–480 dk (B12).
  2. Tenant Admin'i uygulama içinde onaylar veya reddeder.
  3. Onaydan sonra süre işlemeye başlar.
- Operatör `POST /v1/operator/support/{grantId}/enter` ile kendi oturumunu süreli onaya bağlar ve tenant'a bağlı bir erişim belirteci alır (`amr` + `support`).
- Her istekte onay yeniden denetlenir (geçerli, iptal edilmemiş, süresi dolmamış); bitmişse 401 `SUPPORT_ACCESS_ENDED`.
- Destek bağlamı:
  - Admin okuma kapsamı; yalnızca okuma: yazma 403 `SUPPORT_READ_ONLY`;
  - modüller onaylı kapsamla daraltılır;
  - her istek audit'e yazılır (`support.request`: yöntem, yol).
- Admin, etkin destek oturumu boyunca kabukta şerit görür ve tek tıkla iptal eder. Operatör de çıkış yapabilir.

## 15. Yaşam döngüsü, dışa aktarma, silme (TEN-02/05)
- Geçişler: `trial → active | suspended`, `active → suspended | pending_deletion`, `suspended → active | pending_deletion`, `pending_deletion → active` (bekleme süresinde iptal), `pending_deletion → deleted` (yalnızca silme işi). Geçersiz geçiş 422 `TENANT_TRANSITION_INVALID`.
- **Dışa aktarma** (Admin veya operatör talebi):
  - Kuyrukta çalışan iş, tüm tenant tablolarını NDJSON + gzip olarak nesne depolamaya yazar (`tenants/{id}/exports/`). Gizli değerler (anahtar ve belirteç özetleri, şifreli sırlar, DEK) çıkarılır.
  - İndirme imzalı bağlantıyla yapılır; dosya 7 gün sonra silinir.
  - Bekleyen silmede de çalışır (veri taşınabilirliği).
- **Silme:**
  - Admin, adresi yazarak onaylar → `pending_deletion`, `deletion_scheduled_at = şimdi + bekleme` (`privacy.deletionGraceDays`, 7–90, varsayılan 30).
  - Bu sürede giriş kapanır. Admin bekleyen silme ekranından iptal edebilir ve dışa aktarma alabilir.
  - Süre dolunca silme işi sırasıyla:
    1. nesne depolama nesnelerini kaldırır;
    2. tüm tenant satırlarını yabancı anahtar sırasıyla siler (SECURITY DEFINER `app.purge_tenant`);
    3. DEK'i yok eder (crypto-shredding);
    4. başka üyeliği kalmayan kullanıcıları anonimleştirir;
    5. tenant satırını `deleted` mezar taşı olarak bırakır.
  - Yedeklerde kalan düz metin satırlar yedek saklama süresiyle (35 gün) kaybolur; şifreli alanlar DEK imhasıyla hemen okunamaz olur (B73).
- **Yedekten geri yükleme** (TEN-11): `docs/ops/tenant-restore.md` ve `scripts/tenant-restore.mjs`. Yedek geçici bir sunucuya açılır; tek tenant'ın satırları hedefe kopyalanır. Hedefte tenant boş olmalıdır. Kopyalama tek transaction'dadır.

## 16. Sızıntı paketi
Yeni `leaks.int.test.ts` iki tenant ile şunları denetler:
- SSE akışı;
- ek dosya indirme ve dışa aktarma dosyası;
- arama/liste ve RQL;
- kuyruk zarfının tenant'ı;
- hız sınırı ve kota anahtarları;
- yapılandırma, plan ve kullanım.

## 17. Ekranlar
- **Operatör konsolu** (`/operator`):
  - tenant listesi (arama, durum ve plan);
  - tenant ayrıntısı: plan formu, durum geçişi, kullanım, destek talebi;
  - destek talepleri; "salt okuma aç" ve çıkış.
- **Ayarlar → Destek erişimi:** bekleyen talepler, onay/ret/iptal, geçmiş. Etkin erişim için kabuk şeridi.
- **Ayarlar → Veri ve silme:** dışa aktarma talebi ve indirme, çalışma alanını silme (adres onayı), bekleme süresi.
- **Bekleyen silme ekranı:** giriş yapan Admin'e kalan süre, iptal ve dışa aktarma.

