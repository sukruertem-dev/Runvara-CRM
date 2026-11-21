# ADR-0020: Zaman dilimi, tekrarlayan görevler ve SLA takvimi

- Durum: Önerildi · Tarih: 2026-11-20 · Kapsam: Faz 2 (RRULE), Faz 5 (SLA), G7/G8 (arama saatleri) · Gereksinimler: DM-02 (tekrar), DM-09, CC-15, NFR-10

## Karar
- Sunucu ve DB **UTC** (`timestamptz`); kullanıcı, tenant, takvim ve kampanya kendi IANA saat dilimini taşır. Tarih matematiği **Luxon** ile (Temporal, Node 24'te bayraksız olduğunda ADR güncellenir).
- **Tekrarlayan görev:** `task_recurrences(task_series_id, rrule text, dtstart_local, tzid, next_index, until)`; RRULE `rrule` kütüphanesiyle **yerel duvar saatinde** üretilir, sonra tzid ile UTC'ye çevrilir (DST'de 09:00 hep 09:00 kalır). Var olmayan yerel saat (ileri saat) → bir sonraki geçerli dakika; çift anlamlı (geri saat) → ilk oluşum. Sonraki örnek, mevcut örnek `closed` kategorisine geçtiği transaction'da **lazy** oluşturulur (`UNIQUE(series_id, occurrence_index)` → çift üretim yok). Görev geç kapatılırsa: seri ayarı `catch_up = skip_missed` (varsayılan; bugünden sonraki ilk oluşum) veya `create_next`.
- **SLA takvimi:** `business_calendars(tenant_id, tzid, weekly_hours jsonb [{dow, start, end}], holidays[] {date, name, partial?})`. `businessAdd(start, minutes, calendar)` ve `businessDiff(a, b, calendar)` saf fonksiyonlar (`packages/sla`), gün gün iterasyon + aralık kesişimi; 1 yıl üst sınırı. Duraklatma (`paused` durumları) segmentleri hesaptan düşülür.
- SLA zamanlayıcıları: `sla_timers(target_at, warn_at, state)`; worker her dakika `warn_at/target_at <= now()` olanları `FOR UPDATE SKIP LOCKED` ile işler (BullMQ gecikmeli işi yalnızca hızlandırıcı; kaynak doğruluk tablodur).
- **Arama saatleri:** müşteri numarasından (ülke kodu) ve profilden çözülen saat dilimi + tenant kuralı (ör. 09:00–20:00, Pazar yok); belirsizse en kısıtlayıcı pencere.

## Test
DST geçiş günleri (Avrupa/İstanbul sabit UTC+3 olduğu için ek olarak Europe/Berlin, America/New_York), hafta sonu, tatil, tatil+duraklatma kombinasyonları için tablo tabanlı ve property testler (Faz 2, Faz 5 kabul kriterleri).

## Uygulama notu (P5b, 2026-11-21)
- `packages/sla`: `businessAdd`, `businessDiff`, `nextOpening`, `isOpen`, `validateCalendar` (property testleriyle). Takvim: haftalık saatler (gün 1–7, `24:00` dahil), tam gün ya da kısmi saatli tatiller, IANA saat dilimi.
- Politika (`sla_policies`): kaynak `case | task | lead`, RQL ölçütü (kural koşullarıyla aynı derleyici) ve sıra. Yeni kayıtta **ilk eşleşen** politika iki saat başlatır, `first_response` ve `resolution`; uyarı eşiği `warn_percent`.
- İlk yanıt şunlardan biridir: ilk durum geçişi (kullanıcı ya da otomasyon), kayda kullanıcı yorumu, e-posta/arama logu. Çözüm: `closed` kategorisine geçiş.
- `pause_statuses` içindeki bir duruma girince kalan iş süresi dondurulur; çıkınca hedef yeniden hesaplanır.
- Dakikalık denetleyici (BullMQ zamanlayıcı, `FOR UPDATE SKIP LOCKED`, eşzamanlı çalışması güvenli) `sla.warning` ve `sla.breached` olaylarını tam bir kez üretir; karşılanınca `sla.met` üretilir. Otomasyon kuralları `sla` tetikleyicisiyle bu olaylara bağlanır.
