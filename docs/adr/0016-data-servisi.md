# ADR-0016: Data Servisi (santral/IVR veri erişimi)

- Durum: Önerildi (yorum onayı bekliyor: `assumptions.md` Q1) · Tarih: 2026-11-20 · Kapsam: G7 · Gereksinimler: DS-01…09

## Karar
- **Konum:** `apps/api` içinde ayrı Nest modülü, ayrı önek `/dataservice/v1`, ayrı hız sınırı ve ayrı OpenAPI dokümanı; aynı imaj `FLEXA_ROLE=dataservice` ile bağımsız ölçeklenebilir.
- **Kimlik:** `data_service_clients` (tenant'lı): API anahtarı (hash) **veya** mTLS istemci sertifikası parmak izi; isteğe bağlı IP izin listesi; kapsamlar `lookup`, `ingest`, `dialer_export`, `routing`. İstemci, en az yetkili bir **servis bağlamı** ile yetkilendirilir: segment kümesi ve alan politikası istemci kaydında tanımlıdır.
- **Lookup** `GET /dataservice/v1/lookup?phone=+90…` (DS-01, DS-02):
  - Numara E.164'e normalize → `contact_points(tenant_id, e164)` indeksi → yetki predicate'i (istemcinin segmentleri) → **alan politikası** (`data_service_field_policies`, varsayılan minimum: `displayName`, `segment`, `priority`, `ownerExtension`, `openCaseCount`).
  - Whitelist dışı istenen alan (`fields=`) **dönmez** ve `data_service_access_log`'a `field_denied` olarak yazılır (SCN-20).
  - Önbellek: Redis `t:{tenant}:ds:lookup:{clientId}:{policyVersion}:{e164}`, TTL 60 sn; ilgili contact/contact_point/owner değişiminde olay tüketicisi anahtarı siler. Negatif sonuç (bilinmeyen) 15 sn önbellek.
  - Gecikme bütçesi (p95 150 ms): ağ/TLS 30 + auth 5 (anahtar → bellek içi LRU 30 sn) + önbellek 5 / DB 40 + serileştirme 5 + tampon. Sunucu zaman aşımı 120 ms → `504` + `Retry-After: 0`; santral sözleşmesi: 150 ms içinde yanıt yoksa varsayılan IVR akışı.
- **Olay alma** (DS-05): `POST /dataservice/v1/events` (imzalı webhook, ADR-0015 normalize şeması) ve `POST /dataservice/v1/cdr:import` (NDJSON/CSV, asenkron iş); idempotent (`provider_event_id`).
- **Dialer listesi / segment dışa aktarımı** (DS-06): `GET /dataservice/v1/dialer-lists/{id}:export?format=csv|json` — rıza/DNC/arama saati filtreleri uygulanmış haliyle; export politikası ve audit.
- **Yönlendirme verisi** (DS-07): `GET /dataservice/v1/routing?phone=` → `ownerExtension`, `segment`, `priority`, `preferredQueue`.
- **Ölçüm ve audit** (DS-08): istemci başına hız sınırı, kullanım sayacı, her istek `data_service_access_log` (istemci, uç nokta, numara hash'i, sonuç, gecikme, döndürülen alan adları); günlük bölümlenmiş, 90 gün saklama.
- **Sözleşme testleri** (DS-09): OpenAPI'den üretilen Pact/Schemathesis tarzı testler CI'da; sürüm değişikliği yalnızca ek alanla (geriye uyumlu).

## Sonuçlar
- (+) Santral hiçbir zaman yetki kapsamı dışında veya whitelist dışı veri görmez.
- (−) Ayrı önbellek geçersiz kılma tüketicisi gerekir; geçersiz kılma gecikmesi en fazla birkaç saniye (kabul edilebilir; TTL üst sınırı 60 sn).
