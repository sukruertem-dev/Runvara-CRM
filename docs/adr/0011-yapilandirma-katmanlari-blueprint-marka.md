# ADR-0011: Yapılandırma katmanları, JSON Schema, versiyonlama, blueprint'ler ve tenant markası

- Durum: Önerildi · Tarih: 2026-11-20 · Kapsam: G1 · Gereksinimler: CFG-01…07, MOD-01

## Karar

### 1. Katmanlar ve birleştirme
`platform default → tenant → team → user`. Her yapılandırma anahtarı **kayıtlı**dır: `config_keys` kodda tanımlı (`packages/config/keys/*.ts`) ve şunları bildirir: JSON Schema, varsayılan, `overridableAt: ('tenant'|'team'|'user')[]`, sahibi modül, hassasiyet (`secret` ise yalnızca şifreli `tenant_secrets`'ta tutulur, okuma API'sinde maskeli).
- Birleştirme: derin birleştirme yalnızca nesne tiplerinde; diziler **tamamen** değiştirilir (yarı birleştirilmiş pipeline aşaması gibi tutarsızlık olmaz).
- İzin verilmeyen katmanda geçersiz kılma → 422 `CONFIG_KEY_NOT_OVERRIDABLE`.

### 2. Depolama ve versiyonlama
```sql
CREATE TABLE tenant_settings (           -- değişmez sürüm satırları
  tenant_id uuid, scope_type text CHECK (scope_type IN ('tenant','team','user')), scope_id uuid,
  key text, version int, value jsonb, schema_version int,
  created_by uuid, created_at timestamptz, change_note text,
  PRIMARY KEY (tenant_id, scope_type, scope_id, key, version)
);
CREATE TABLE tenant_settings_head (tenant_id uuid, scope_type text, scope_id uuid, key text, version int, PRIMARY KEY (tenant_id, scope_type, scope_id, key));
```
- Değişiklik akışı: `POST /v1/config/{key}:preview` (doğrulama + RFC 6902 JSON Patch diff + etki özeti) → `PUT` (`If-Match: version`) → yeni sürüm satırı + head güncellemesi + audit + `config.changed` olayı. Geri alma = önceki sürümün değeriyle **yeni** sürüm (geçmiş silinmez).
- Doğrulama: Ajv (JSON Schema 2020-12, `strict`, `allErrors`), şemalar `packages/config/schemas/`.
- Şema evrimi: `schema_version` + kayıtlı yükseltme fonksiyonları (okuma anında tembel, yazma anında kalıcı).

### 3. Blueprint'ler (CFG-04) ve dışa/içe aktarma (CFG-05)
- Blueprint = sürümlü JSON paketi: `{modules[], salesMode, settings{key:value}, pipelines[], customFields[], workflows[], dispositions[], slaPolicies[], roles?}`. İlk üç: `enterprise-b2b`, `retail-b2c`, `telesales-callcenter` (`packages/config/blueprints/`).
- Uygulama = içe aktarma ile aynı motor: **kuru çalıştırma** (planlanan işlemler + çakışmalar: aynı ad farklı tanım, eksik bağımlı modül, plan dışı modül) → onay → tek transaction'da uygulama.
- Tenant → sandbox → tenant taşımada kimlikler **doğal anahtarla** (ör. pipeline `key`) eşlenir, UUID ile değil.

### 4. Tenant markası (CFG-06)
- Tenant tek bir marka rengi (`brand.accent`) ve logo yükler (SVG temizlenir: script/foreignObject/harici referans kaldırılır; PNG en fazla 512 KB).
- Türetme (her tema için): `accent` (metin), `accent-hover`, `accent-soft`, `accent-btn`, `accent-btn-hover`. Algoritma: OKLCH uzayında açıklık (L) ayarlanarak `tokens.json` içindeki `tenantAccent: true` işaretli tüm kontrast kontrolleri sağlanana kadar ikili arama; ton (H) ve doygunluk korunur.
- Sonuç: kontroller sağlanabiliyorsa **otomatik düzeltilmiş** değerler önizlemede gösterilir (orijinal ve düzeltilmiş yan yana); sağlanamıyorsa (ör. çok düşük doygunluk + sarı tonu) **reddedilir** `BRAND_CONTRAST_UNSATISFIABLE`.
- Flexa işareti, füme/kırık beyaz temel token'lar değiştirilemez (10.5.1 madde 9).

## Sonuçlar
- (+) Her yapılandırma değişikliği doğrulanmış, diff'lenmiş, geri alınabilir ve audit'li.
- (−) Anahtar kaydı disiplin gerektirir; kayıtsız anahtar yazımı API düzeyinde imkânsızdır (kasıtlı).
