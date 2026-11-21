# P5 — Faz 5: otomasyon · uygulama planı

> 2026-11-21 · Dal `feat/p5-automation`. Kaynak: prompt Faz 5, ADR-0006 (outbox), ADR-0007 (SSE), ADR-0020 (SLA takvimi), `docs/events.md`. Kapsam iki adıma bölündü:
> - **P5a (bu dal):** olay yolu (outbox + relay + tüketici), kural motoru (tetikleyici → koşul → aksiyon), idempotency, döngü koruması, retry/backoff/jitter, DLQ + replay, çalıştırma logu, atama kuralları (round-robin, yük dengeli, yedek), kural JSON şeması, kaos testi.
> - **P5b:** SLA motoru (çalışma saati, tatil, DST, milestone, uyarı/ihlal), webhook'lar (HMAC, retry, teslimat geçmişi, otomatik devre dışı; kural aksiyonu `call_webhook` ve `sla` tetikleyicisi), API anahtarları + kapsam + `Idempotency-Key`, SSE, bildirim e-posta özeti.

## 1. Olay yolu (ADR-0006)
- `outbox_events`: iş yazımıyla **aynı transaction'da**. Tek yazma noktası: timeline yazıcısı (`recordActivity`) her timeline olayıyla birlikte zarfı da yazar (`<tür>.created|updated|status_changed|assigned|deleted|restored`, `lead.converted`, `record.merged`, `comment.created`, `attachment.uploaded`, `activity.logged`). Yük **minimal**: değişen alan adları, durum anahtarları — alan değerleri yok (FLS gizli alan değeri olaya hiç girmez).
- Zarf: `id, type, version, tenantId, occurredAt, actor{type,id,ruleId?}, resource{type,id,segment}, causationId, correlationId, depth, payload` (`packages/events`, Zod).
- **Relay** (`packages/events` `relayOnce`, worker'da döngü): `flexa_relay` rolüyle `FOR UPDATE SKIP LOCKED LIMIT 500` → BullMQ `events` kuyruğu (`jobId = event.id`) → `published_at`. `pg_notify` ile uyanır + 1 sn yedek yoklama; birden çok relay güvenli.
- **Tüketici** (otomasyon): kuralları çalıştırmak alan servislerini (doğrulama, yetki, timeline) gerektirdiği için API sürecinde BullMQ worker olarak çalışır (`EVENT_CONSUMERS=true`; Compose'da ayrı `automation` servisi aynı imajla). `processed_events(consumer, event_id)` aynı transaction'da → tam bir kez etki.

## 2. Kural motoru
- **Tanım (JSON şeması, `packages/contracts` `AutomationRuleDefinition`)** — P6 görsel editörü bunu üretir:
  - `trigger`: `{type: 'record.created' | 'record.updated' | 'field_changed' | 'status_changed' | 'schedule' | 'inbound_webhook', resource, fields?, toStatus?, cron?, timezone?}`
  - `condition`: RQL ifadesi (güvenli ifade motoru; AND/OR, karşılaştırma, `account.*` gibi ilişkili kayıt alanları) — tetikleyen kayda karşı SQL'de değerlendirilir.
  - `actions[]` (en çok 10): `update_field`, `create_task`, `assign` (kullanıcı veya atama politikası), `notify`, `send_email`, `transition`.
- **Çalıştırma kimliği:** kural, onu oluşturan Admin'in **güncel** yetkisiyle çalışır (yetkisi düşerse aksiyon 403 → çalıştırma `failed`, loglanır); olaylarda aktör `automation` + `ruleId`.
- **Tam bir kez:** bir kuralın bir olay × kayıt için tüm aksiyonları ve `automation_runs` satırı **tek transaction'da**; `UNIQUE(tenant, rule, event, record)` ve başarılı çalıştırma tekrar işlenmez. E-posta kuyruğa commit sonrası `jobId = run:action` ile (yinelenmez).
- **Döngü koruması:** aksiyonun ürettiği olay `depth + 1`, aynı `correlationId`; `depth > 5` → `halted_depth`; aynı zincirde aynı kural + aynı kayıt ikinci kez → `halted_loop`; ikisi de loglanır ve `automation.run.halted` olayı.
- **Retry:** 8 deneme, üstel (2^n sn) + tam jitter, üst sınır 15 dk. Son denemeden sonra `dead_letters` + Admin API ile listeleme/replay (yeni `attempt_group`).
- **Zamanlanmış kurallar:** BullMQ tekrarlayan iş (cron, kural saat diliminde); koşula uyan kayıtlar üzerinde (en çok 500/çalıştırma).
- **Gelen webhook tetikleyicisi:** `POST /v1/automation/hooks/{ruleId}` + `X-Flexa-Hook-Token` (kural başına rastgele, hash'li saklanır).
- **Atama politikaları:** `round_robin` (sıra kalıcı, eşzamanlılıkta kilitli), `load_balanced` (açık iş sayısı en az), üyeler bir ekip veya kuyruk; uygun üye yoksa `fallback_user_id`.

## 3. Yetki
`automation_sla` modülü (katalog) — kural yönetimi `tenant.config.manage` (Admin); çalıştırma logu ve DLQ okuma `tenant.config.read`.

## 4. Kabul kriterleri ↔ testler (P5a)
| Kriter | Test |
|---|---|
| Döngüye giren iki kural limitte durur ve loglanır | `automation.int.test.ts` |
| Aynı olay iki kez işlense bile aksiyon bir kez | aynı (aynı olay iki kez + BullMQ yeniden teslim) |
| Worker çökmesi sonrası olay kaybolmaz (kaos) | relay/tüketici olay ortasında durdurulur, yeniden başlar; tüm olaylar tam bir kez etki |
| Retry + DLQ + replay | geçici hata → yeniden deneme; kalıcı hata → DLQ → düzeltip replay |
