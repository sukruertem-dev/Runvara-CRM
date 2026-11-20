# ADR-0003: Çok kiracılılık, RLS ve tenant bağlamı çözümü

- Durum: Önerildi · Tarih: 2026-11-20 · Kapsam: Faz 1, G1, G7, G10 · Gereksinimler: DM-01, TEN-06, TEN-07, 10.3.3

## Bağlam
Her firma ayrı tenant'tır. Kaynak, paylaşımlı şema + RLS'i standart, ayrı şema/DB'yi kurumsal **seçenek** olarak ister. Tenant bağlamı istekten değil doğrulanmış kimlikten/eşlemeden türetilmelidir. Bazı tablolar doğası gereği tenant dışıdır (bkz. `docs/requirements-review.md` B1).

## Karar

### 1. Strateji
**Paylaşımlı veritabanı, paylaşımlı şema, `tenant_id` + PostgreSQL RLS.** Kurumsal izolasyon için G1'de yalnızca hazırlık: `tenant_placements(tenant_id, cluster_id)` tablosu ve `packages/db` içinde `getPool(tenantId)` yönlendirici arayüzü. Varsayılan tek küme; ayrı küme desteği sonraki sürüm (risk R-04).

### 2. Veritabanı rolleri
`docs/architecture.md` §5 tablosu bağlayıcıdır. Kurallar:
- Uygulama `runvara_app` ile bağlanır: `NOSUPERUSER NOBYPASSRLS`, hiçbir tablonun sahibi değildir.
- Tüm tenant tablolarında `ALTER TABLE … ENABLE ROW LEVEL SECURITY; ALTER TABLE … FORCE ROW LEVEL SECURITY;`
- Standart politika (her tenant tablosu için migration şablonu):

```sql
CREATE POLICY tenant_isolation ON <tablo>
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

-- bağlam yoksa NULL döner → karşılaştırma NULL → 0 satır (fail-closed)
CREATE FUNCTION app_tenant_id() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;
```

- Segment politikası satış/CRM tablolarında ek olarak uygulanır (ADR-0010). Politikalar `AS RESTRICTIVE` olarak tanımlanır; böylece bir tabloya sonradan eklenen izin verici politika tenant/segment koşulunu **gevşetemez**.

### 3. Bağlam ayarlama
Her istek/iş bir transaction içinde çalışır; ilk ifade:
```sql
SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true),
       set_config('app.segments', $3, true),  set_config('app.authz_version', $4, true);
```
`packages/db` yalnızca `withTenant(ctx, fn)` sarmalayıcısını dışa açar; bağlamsız sorgu çalıştıran API yoktur (lint: `pool.query` doğrudan kullanımı yasak).

### 4. Tenant bağlamının kaynağı (istisnasız)
| Giriş noktası | Tenant kaynağı |
|---|---|
| Kullanıcı isteği | Erişim JWT'sindeki `tid` (oturum açılırken üyelikten seçilmiş, imzalı) |
| API anahtarı / Data Servisi istemcisi | Anahtar kaydı (`resolve_api_key(hash)` → tenant) |
| Telefoni olayı | **DID / trunk eşlemesi** (`resolve_tenant_by_did(e164)`), gövdedeki tenant alanı yok sayılır ve uyuşmazlık güvenlik olayı olarak loglanır |
| Gelen webhook (bizim abonelik onaylarımız) | URL'deki tenant'a özgü imzalı token |
| Arka plan işi | İş yükündeki `tenantId` (yalnızca outbox'tan veya zamanlayıcıdan; kullanıcı girdisinden değil) |
| Alt alan adı | Yalnızca giriş sayfasında tenant ön seçimi (UX); yetki kararı JWT'den |

### 5. Global tablolar
`docs/architecture.md` §6 kapalı listesi. CI denetimi (`scripts/check-tenant-columns`, Faz 1): `pg_catalog` sorgusuyla `public` şemasındaki her tablonun ya listede olduğunu ya da `tenant_id` sütunu + `relforcerowsecurity = true` + `tenant_isolation` politikasına sahip olduğunu doğrular.

### 6. Tenant'a özel diğer kaynaklar
- Redis anahtarı: `t:{tenantId}:…` (yardımcı fonksiyon dışında anahtar oluşturmak lint ile yasak).
- BullMQ işi: yük her zaman `tenantId` taşır; işçi `withTenant` dışında DB'ye erişemez.
- Nesne depolama: `tenants/{tenantId}/…`; imzalı URL yalnızca bu ön ek altında üretilir.
- SSE kanalı: `t:{tenantId}:u:{userId}`; abonelik kimlikten türetilir.
- Arama indeksi: FTS aynı tablolarda, RLS kapsamında.
- Log/metric: `tenant_id` etiketi; metric kardinalitesi için tenant etiketi yalnızca tenant başına kota/gecikme metriklerinde.

### 7. Şifreleme (TEN-07)
Zarf şifreleme: tenant başına veri anahtarı (DEK), platform ana anahtarıyla (KEK; KMS veya dev'de yerel anahtar dosyası) sarılır, `tenant_keys` tablosunda. Telefoni kimlik bilgileri, webhook sırları, OIDC client secret'ları, çağrı kaydı nesneleri bu DEK ile şifrelenir. Anahtar döndürme: yeni DEK sürümü, tembel yeniden şifreleme işi.

## Kanıt (testler)
- DB düzeyi: `runvara_app` ile bağlamsız `SELECT` → 0 satır; tenant A bağlamında tenant B `id`'si ile `SELECT/UPDATE/DELETE` → 0 satır; `INSERT` tenant B → `WITH CHECK` ihlali.
- API düzeyi: tenant B kaydının id'si tenant A token'ıyla → 404.
- Telefoni: DID A, gövde tenant B → olay A'ya işlenir (SCN-14).

## Alternatifler
| Alternatif | Neden seçilmedi |
|---|---|
| Tenant başına şema | Migration ve bağlantı maliyeti binlerce tenant'ta yüksek; kurumsal seçenek olarak saklandı |
| Yalnızca uygulama katmanı filtreleme | Tek bir unutulmuş `WHERE` sızıntı demektir; RLS son savunma hattıdır |

## Sonuçlar
- (+) Sızıntı için iki bağımsız katmanın birlikte hata yapması gerekir.
- (−) RLS politikaları sorgu planına eklenir; `tenant_id` her bileşik indeksin ilk sütunudur (performans kuralı).
