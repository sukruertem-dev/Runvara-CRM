# İşletim: olay yolu, otomasyon ve dead-letter kuyruğu

> P5a (ADR-0006). Bu belge nöbetçi/işletim ekibi içindir: olay nasıl akar, takılırsa nereye bakılır, DLQ nasıl işletilir.

## Akış
```text
iş transaction'ı ──► outbox_events (aynı commit)
                         │  NOTIFY outbox + 1 sn yedek yoklama
                         ▼
worker (flexa_relay) ──► BullMQ `events` (jobId = olay id) ──► automation servisi (EVENT_CONSUMERS=true)
                                                                   │  kural × kayıt başına tek transaction
                                                                   ▼
                                                   automation_runs (log) + iş değişikliği + processed_events
```
- **Kayıp yok:** olay iş verisiyle birlikte commit edilir. Relay ölürse satır `published_at IS NULL` kalır ve bir sonraki çalışmada yayınlanır. Yayın sonrası, işaretlemeden önce ölürse kuyruk aynı `jobId`'yi ikinci kez almaz.
- **Çift etki yok:** kural çalıştırması ve log satırı aynı transaction'da; `UNIQUE(tenant, rule, event, record)` ve terminal durumdaki çalıştırma tekrar yapılmaz.

## Gözlem
| Soru | Sorgu / uç nokta |
|---|---|
| Yayınlanmayı bekleyen olay var mı? | `SELECT count(*), min(occurred_at) FROM outbox_events WHERE published_at IS NULL;` (normalde birkaç saniyeden eski satır olmaz) |
| Relay hata veriyor mu? | worker logu: `relay error (events stay in the outbox)` |
| Bir kural ne yaptı? | `GET /v1/automations/runs?ruleId=…` (durum, koşul sonucu, aksiyonlar, süre, hata, deneme) |
| Döngü/derinlik kesildi mi? | `status = halted_loop / halted_depth`; ayrıca `automation.run.halted` olayı |
| Kalıcı başarısızlık | `GET /v1/automations/dead-letters` |

## Yeniden deneme
8 deneme; üstel bekleme 2^n sn, tam jitter, üst sınır 15 dk (yaklaşık toplam 1 saat). Geçici hatalar (veritabanı, kilit) kendiliğinden düzelir.

## DLQ nasıl işletilir
1. `GET /v1/automations/dead-letters` → `error` alanı nedeni söyler (ör. `ASSIGNMENT_NO_CANDIDATE`, `FORBIDDEN` = kural sahibinin yetkisi düşmüş, `RULE_DEFINITION_INVALID` = kural artık geçersiz).
2. Nedeni düzeltin: atama politikasına üye ekleyin, kuralı güncel bir Admin ile kaydedin (kural son düzenleyenin kimliğiyle çalışır) ya da kuralı düzeltin/kapatın.
3. `POST /v1/automations/dead-letters/{id}/replay` — olay yeni bir iş kimliğiyle kuyruğa döner. Başarılı olmuş kural çalıştırmaları tekrar etmez; yalnızca başarısız/ölü olanlar yeniden çalışır. İkinci replay 409 döner.
4. Sonucu `GET /v1/automations/runs?ruleId=…` ile doğrulayın.

## Redis kaybı
Redis kalıcılığı AOF `everysec`. Redis tamamen kaybolursa: yayınlanmış ama işlenmemiş olayları bulmak için `outbox_events` (son 7 gün, `published_at IS NOT NULL`) ile `processed_events (consumer = 'automation')` karşılaştırılır; eksik olanlar `published_at = NULL` yapılarak relay'e yeniden verilir. Tüketici idempotent olduğundan fazladan yayın zararsızdır.
