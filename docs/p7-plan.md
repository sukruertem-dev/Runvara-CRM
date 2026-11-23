# P7 — G1 kalanı: tenant platformu · uygulama planı

> 2026-11-23 · Kaynak: prompt §10.2 (TEN, MOD, CFG), §10.3.2 (katmanlar), Faz G1, ADR-0011 (yapılandırma, blueprint, marka), ADR-0014 (modül, kota, adalet, operatör). P1'de G1'in çekirdeği (tenant yaşam döngüsü, modül kayıt defteri ve kapısı, OIDC, sızıntı iskeleti) yapıldı. Kalan iş tek PR için çok büyük; üç adıma bölündü:
> - **P7a (bu dal, `feat/p7a-config`):** yapılandırma motoru (anahtar kayıt defteri, katmanlar, JSON Schema, sürüm, diff, geri alma, audit, olay), tenant yerelleştirmesi (CFG-07), marka (CFG-06), sunucu tarafı kullanıcı tercihleri ve bunların **ekranları**.
> - **P7b:** blueprint'ler ve yapılandırma dışa/içe aktarma (CFG-04/05), onboarding sihirbazı, plan/kota/kullanım ölçümü ve plan hakkı (MOD-04), gürültülü komşu koruması (TEN-10), modül kataloğu ve kullanım ekranları.
> - **P7c:** tenant SSO (SAML) ve güvenlik politikaları, Platform Operatörü konsolu ve destek erişimi (TEN-08), tenant dışa aktarma ve silme (crypto-shredding), yedekten geri yükleme prosedürü, sızıntı test paketinin genişletilmesi (önbellek, kuyruk, SSE, dosya, arama) ve ekranları.

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
  - `tenant_assets`: logo; nesne depolama anahtarı tenant önekli.
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
  - Ton ve doygunluk korunur; yalnızca açıklık ikili aramayla ayarlanır.
  - Sonuç `tokens.json`'daki `tenantAccent: true` kontrollerinin tümünü sağlamalıdır.
  - Sağlanamazsa 422 `BRAND_CONTRAST_UNSATISFIABLE`.
  - Önizleme özgün ve düzeltilmiş değerleri ve her kontrolün oranını döndürür.
- Tek kaynak `packages/ui/tokens.json`. Türetme `packages/config`'te saf bir fonksiyondur; API ve web aynı kodu kullanır.
- Kaydedilen marka türetilmiş değerleriyle saklanır. `GET /v1/config` `brand.tokens` döndürür ve kabuk bunları `<html>` üzerinde CSS değişkeni olarak uygular. Flexa işareti ve temel token'lar değişmez.
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
