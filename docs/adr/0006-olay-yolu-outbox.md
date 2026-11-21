# ADR-0006: Olay veri yolu (transactional outbox) ve otomasyon güvenlik önlemleri

- Durum: Önerildi · Tarih: 2026-11-20 · Kapsam: Faz 5 (iskelet Faz 2'de) · Gereksinimler: AU-*, 5.3, MEN-05, CC-21

> **Not (P2, 2026-11-20):** Outbox yazıcısı P2'ye değil P5'e bırakıldı; görevler henüz olay üretmiyor (olay tüketicisi olmadan yazılan outbox satırları birikirdi). Görev servisinin yazma noktaları P5'te outbox'a bağlanacak.

## Bağlam
İş değişikliği ile olay yayını arasında "yazıldı ama yayınlanmadı" veya "yayınlandı ama geri alındı" durumu olmamalı. Otomasyonlar idempotent, döngü korumalı, DLQ'lu olmalı.

## Karar

### 1. Outbox
```sql
CREATE TABLE outbox_events (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  tenant_id uuid NOT NULL,
  type text NOT NULL, version smallint NOT NULL,
  resource_type text, resource_id uuid, segment segment NULL,
  actor jsonb NOT NULL, payload jsonb NOT NULL,
  causation_id uuid NULL, correlation_id uuid NOT NULL, depth smallint NOT NULL DEFAULT 0,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz NULL, attempts int NOT NULL DEFAULT 0
);
CREATE INDEX outbox_unpublished ON outbox_events (occurred_at) WHERE published_at IS NULL;
```
- Servisler olayı iş yazımıyla **aynı transaction'da** `packages/events` yazıcısıyla ekler; trigger `pg_notify('outbox', '')` gönderir.
- Relay (`flexa_relay`): NOTIFY ile uyanır + 1 sn yedek yoklama; `SELECT … FOR UPDATE SKIP LOCKED LIMIT 500`; BullMQ'ya `jobId = event.id` ile ekler (iş kuyrukta durdukça BullMQ aynı jobId'yi tekrar eklemez; iş tamamlanıp silinmişse tekrar eden yayını tüketici idempotency'si (§2) etkisiz kılar); sonra `published_at` set eder. Birden çok relay örneği güvenle çalışır.
- Saklama: yayınlanmış olaylar 7 gün sonra `outbox_archive` (bölümlenmiş, aylık) tablosuna taşınır/silinir.

### 2. Teslim ve tüketiciler
- En az bir kez teslim. Her tüketici: `processed_events(consumer text, event_id uuid, PRIMARY KEY(consumer, event_id))`; işleme ve bu satırın yazımı aynı transaction'da → **tam olarak bir kez etki**.
- Sıralama garantisi yok; kayıt başına sıralama gereken tüketiciler (SSE, arama indeksi) olaydaki `resource.version` ile eskiyi yok sayar.

### 3. Otomasyon güvenlik önlemleri
| Önlem | Uygulama |
|---|---|
| İdempotency | `automation_runs UNIQUE (tenant_id, rule_id, event_id, record_id)` |
| Zincir derinliği | Aksiyonun ürettiği olay `depth = parent.depth + 1`; `depth > 5` (tenant ayarı, en fazla 10) → çalıştırma `halted_depth` durumuyla loglanır, aksiyon uygulanmaz |
| Aynı kuralın tekrar tetiklenmesi | `correlation_id` zincirinde aynı `rule_id` + aynı `record_id` ikinci kez → `halted_loop` |
| Retry | BullMQ: 8 deneme, exponential backoff (2^n × 1 sn) + tam jitter, üst sınır 15 dk |
| DLQ | Son denemeden sonra `dead_letters` tablosu + `automation.dlq` kuyruğu; replay aracı (CLI + Admin API) olayı yeni `attempt_group` ile yeniden kuyruğa koyar |
| Çalıştırma logu | `automation_runs`: girdi özeti, koşul sonucu, aksiyonlar, süre, hata, durum |
| Hız sınırı | Tenant başına dakikada en fazla N aksiyon (plan); aşımda `throttled` ve gecikmeli yeniden deneme |

### 4. Olay zarfı ve katalog
Zarf ve tüm olay tipleri `docs/events.md`. Tipler `packages/events` içinde Zod şemalarıyla sürümlenir; geriye uyumsuz değişiklik yeni `version`.

## Alternatifler
| Alternatif | Neden seçilmedi |
|---|---|
| Debezium / mantıksal replikasyon (CDC) | Ek altyapı (Kafka Connect); şu ölçekte outbox yeterli; ileride outbox tablosu CDC kaynağı yapılabilir |
| Doğrudan BullMQ'ya yazma (tx dışında) | Çift yazma problemi; çökmede olay kaybı |
| Kafka/NATS | Operasyonel yük; Redis zaten gerekli |

## Sonuçlar
- (+) Worker çökmesi olay kaybettirmez (yayınlanmamış satırlar kalır; işlenmemiş işler BullMQ'da `stalled` olarak geri döner).
- (−) Redis kalıcılığı kritik: AOF `everysec`; Redis kaybında relay, `published_at` sonrası tüketilmemiş işleri yeniden yayınlayabilmek için `processed_events` ile mutabakat aracı sunar (runbook).

## Uygulama notu (P5a, 2026-11-21)
- Outbox'a tek yazma noktası timeline yazıcısıdır (`apps/api/src/common/activity.ts`): her timeline olayı aynı transaction'da zarfıyla birlikte yazılır; yük yalnızca alan adları ve durum anahtarlarıdır (FLS gizli değer olaya girmez). Tür eşlemesi: `<tür>.created|updated|status_changed|assigned|deleted|restored`, `lead.converted`, `record.merged`, `comment.created`, `attachment.uploaded`, `activity.logged`, ayrıca `automation.schedule_tick`, `automation.hook_received`, `automation.run.halted`.
- Relay `packages/db/src/relay.ts` (`createRelay`, `startRelayLoop`), worker'da çalışır. Tüketici API imajında `automation` servisi (B37).
- Kanıt: `apps/api/test/automation.int.test.ts` (döngü/derinlik, tam bir kez, retry → DLQ → replay, kaos). İşletim: `docs/ops/automation-dlq.md`.

## Uygulama notu (P5b, 2026-11-21)
- Olay tüketicisi (`AutomationQueues.dispatch`) her olayı sırayla kural motoruna, SLA'ya ve webhook dağıtımına verir, ardından gerçek zamanlı kanala yayınlar. Her tüketici `processed_events`'te kendi adıyla (`automation`, `sla`, `webhooks`) tam bir kez işaretlenir. Birinin hatası diğerlerini durdurmaz: iş yeniden denenir, işaretli tüketiciler atlanır.
- BullMQ özel iş kimliği `:` içeremez (kendi üç parçalı biçimi dışında). Bu yüzden kuyruk iş kimlikleri `-` ile ya da kararlı UUID ile kurulur: `mail-<uuid>`, `delivery-<id>`, `digest-<user>-<id>`. P5a'daki otomasyon e-postası kimliği (`run:…`, beş parça) gerçek kuyrukta reddedilirdi; düzeltildi ve test e-posta kuyruğu artık aynı kuralı uygular.
