# ADR-0006: Olay veri yolu (transactional outbox) ve otomasyon güvenlik önlemleri

- Durum: Önerildi · Tarih: 2026-11-20 · Kapsam: Faz 5 (iskelet Faz 2'de) · Gereksinimler: AU-*, 5.3, MEN-05, CC-21

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
- Relay (`runvara_relay`): NOTIFY ile uyanır + 1 sn yedek yoklama; `SELECT … FOR UPDATE SKIP LOCKED LIMIT 500`; BullMQ'ya `jobId = event.id` ile ekler (iş kuyrukta durdukça BullMQ aynı jobId'yi tekrar eklemez; iş tamamlanıp silinmişse tekrar eden yayını tüketici idempotency'si (§2) etkisiz kılar); sonra `published_at` set eder. Birden çok relay örneği güvenle çalışır.
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
