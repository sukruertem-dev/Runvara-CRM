# ADR-0014: Modül kaydı ve kapısı, plan/kota, gürültülü komşu koruması, operatör destek erişimi

- Durum: Önerildi · Tarih: 2026-11-20 · Kapsam: Faz 1 (iskelet), G1 · Gereksinimler: MOD-01…04, AUTH-11, TEN-01/02/08/09/10

## 1. Modül manifesti
Her modül `packages/modules/manifests/<id>.ts` içinde, `docs/enterprise/module-manifest.schema.json` şemasına uyan bir manifest dışa aktarır: `id, version, displayNameKey, dependsOn (anyOf grupları dahil), permissions[], routes{apiPrefix}, menu[], jobs[], events{publishes, consumes}, configKeys[], planEntitlement, defaultConfig`. Katalog: `packages/modules/src/catalog.json`.
- Açılışta kayıt defteri tüm manifestleri yükler, şemayla doğrular ve bağımlılık grafiğinde **döngü** ve **bilinmeyen modül** kontrolü yapar (hata = süreç başlamaz).
- Bağımlılık semantiği: `dependsOn: [["crm"]]` = crm gerekli; `dependsOn: [["call_center"], ["sales_b2b", "sales_b2c"]]` = call_center **ve** (b2b **veya** b2c).

## 2. Modül kapısı
| Yüzey | Kapalı modül davranışı |
|---|---|
| REST | Rota önekine göre ara katman → **404** `MODULE_DISABLED` (tüm modüller için aynı; AI dahil) |
| Menü | `/v1/me/navigation` yalnızca etkin + yetkili modülleri döndürür |
| İzinler | Matris API'sinde kapalı modül satırları gizlenir; `can()` ilk koşulda reddeder |
| İşler | Zamanlayıcı iş eklemeden önce, işçi işlemeden önce kontrol eder (kapalıysa iş atlanır, `skipped_module_disabled`) |
| Olay tüketicileri | Kapalı modülün tüketicisi olayı işlenmiş sayar ama aksiyon uygulamaz |
| SSE | Kapalı modül kaynak olayları iletilmez |
- Kapatma **veri silmez** (MOD-03). Kapatma, ona bağımlı etkin modül varsa reddedilir (`MODULE_HAS_DEPENDENTS`) veya kullanıcı onayıyla zincirleme kapatılır. `tenant_modules` değişikliği → `tenants.authz_epoch += 1` + `module.toggled` olayı + audit.

## 3. Plan, kota ve kullanım
- `plans` (global) → `tenant_plans` (tenant'ın planı + add-on modüller). Kota boyutları: `users`, `storage_bytes`, `call_minutes`, `api_rpm`, `records`, `ai_tokens`.
- Sayaçlar: Redis'te anlık (`INCRBY`), dakikalık olarak `tenant_usage_counters`'a (gün × boyut) toplanır.
- Aşım davranışı: %80 uyarı (Admin bildirimi), %100 **yumuşak** (yeni kullanıcı daveti/yeni yükleme engellenir, mevcut iş sürer), %120 **sert** (ilgili yazma eylemleri 402 `QUOTA_EXCEEDED`). Okuma ve dışa aktarma kota ile asla engellenmez (veri taşınabilirliği).

## 4. Gürültülü komşu koruması (TEN-10)
- API: tenant başına token bucket (plan `api_rpm`), kullanıcı başına ayrıca.
- Kuyruklar: açık kaynak BullMQ ile **shard + adil sıra**: her iş türü için `N` shard kuyruğu (`events.0..N-1`), `shard = hash(tenantId) mod N`; shard içinde tenant başına eşzamanlılık sınırı (Redis semafor, `tenant:{id}:concurrency:{queue}`), sınır dolarsa iş gecikmeli yeniden kuyruklanır. Ağır tenant yalnızca kendi shard'ını yavaşlatır ve orada bile kendi semaforuyla sınırlanır.
- DB: tenant başına `statement_timeout` (API 5 sn, rapor 30 sn), rapor sorguları read-replica'ya.

## 5. Tenant yaşam döngüsü (TEN-02)
`trial → active → suspended → pending_deletion → deleted` (+ `trial → suspended`, `suspended → active`, `pending_deletion → active` (iptal, bekleme süresinde)). Geçersiz geçiş reddedilir; her geçiş audit + olay. `suspended`: giriş engelli, Data Servisi ve telefoni olay işleme durur (olaylar 7 gün tamponlanır). `pending_deletion`: 30 gün bekleme (tenant ayarı ≥ 7), sonra silme işi: nesne depolama ön eki, tüm tenant satırları (bölüm bölüm), anahtarlar (crypto-shredding: DEK imhası yedeklerdeki veriyi de okunamaz kılar).

## 6. Platform Operatörü destek erişimi (TEN-08)
- Operatörün tenant verisine varsayılan erişimi **yoktur**. Akış: operatör talep (gerekçe, kapsam: salt okuma/belirli modül, süre ≤ 8 saat) → tenant Admin onayı (uygulama içi) → `support_access_grants` → operatör, tenant içinde **"Platform Destek"** sanal kullanıcısı olarak, onaylanan kapsamla ve salt okuma varsayılanıyla bağlam kurar. Her istek audit'li (`actor.type = operator`), Admin oturum boyunca canlı göstergeyi görür ve iptal edebilir; süre dolunca otomatik sona erer.

## Sonuçlar
- (+) Modül ekleme = manifest + kod; menü, izin, iş ve API kapısı otomatik.
- (−) Shard sayısı sonradan değişirse tenant → shard eşlemesi değişir; değişiklik yalnızca kuyruklar boşaltılarak (drain) yapılır (runbook).
