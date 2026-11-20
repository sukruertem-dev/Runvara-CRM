# ADR-0007: Gerçek zamanlı iletişim (SSE + yeniden oynatma)

- Durum: Önerildi · Tarih: 2026-11-20 · Kapsam: Faz 5, G6, G7 · Gereksinimler: API-07, MEN-06, MEN-10, CC-04, CC-14

## Bağlam
İhtiyaçlar sunucu → istemci yönlüdür: kayıt değişimi, bildirim, ekran açma, wallboard, temsilci durumu. İstemci → sunucu eylemleri (arama kabul, durum değiştir) normal REST çağrısıdır. Kopan bağlantıda kaçırılan olaylar tamamlanmalıdır (MEN-06). Hedef: çevrimiçi kullanıcıya bildirim p95 < 2 sn.

## Karar
- **Server-Sent Events** (`GET /v1/stream`, `text/event-stream`), HTTP/2 üzerinden; tarayıcı `EventSource` yerine `fetch` tabanlı istemci (Authorization başlığı göndermek için) + yerleşik yeniden bağlanma.
- Her olaya kullanıcı akışında monoton `id` (uuidv7). İstemci yeniden bağlanırken `Last-Event-ID` gönderir; sunucu `realtime_event_log`'dan (kullanıcı başına, 72 saat saklama) sonraki olayları yeniden oynatır; aralık saklama süresini aşıyorsa `resync.required` olayı gönderir (istemci ilgili sorguları tazeler).
- **Fan-out:** outbox → `realtime` tüketicisi → her alıcı için yetki süzgeci (`can(ctxAlıcı, read, resource)`; içerik **okuma anında** yeniden kontrol, MEN-09) → `realtime_event_log` yazımı → Redis pub/sub `t:{tenant}:u:{user}` → kullanıcının bağlı olduğu API örneği.
- Olay yükleri **minimaldir**: tip, kaynak referansı, değişen alan adları, sürüm; hassas içerik yok. İstemci ayrıntıyı REST ile (yetki kontrollü) çeker. İstisna: bildirim kartı özeti, yalnızca alıcının FLS maskesinden geçmiş alanlarla.
- Kalp atışı: 20 sn'de bir yorum satırı (proxy zaman aşımlarına karşı). Bağlantı başına tenant/kullanıcı kotası (en fazla 5 eşzamanlı sekme; fazlası en eskiyi kapatır).
- **Softphone medyası** SSE kapsamı dışında: WebRTC (SIP over WSS) tarayıcıdan santrale doğrudan (ADR-0015); CTI kontrol olayları SSE ile gelir.
- Ölçüm: olay `occurred_at` → istemcinin `ack` beacon'ı (örnekleme %5) → `notification_delivery_latency` histogramı.

## Alternatifler
| Alternatif | Neden seçilmedi |
|---|---|
| WebSocket (Socket.IO vb.) | Çift yön gerekmiyor; yeniden oynatma, kimlik doğrulama ve yük dengeleyici yapışkanlığı kendimiz yazmak zorunda kalırdık. SSE `Last-Event-ID` ile yeniden oynatmayı doğal olarak taşır |
| Uzun yoklama | Gecikme ve maliyet |

## Sonuçlar
- (+) Durumsuz API örnekleri; herhangi bir örneğe bağlanılabilir (yapışkan oturum gereksiz).
- (−) HTTP/1.1 proxy'lerde tarayıcı başına 6 bağlantı sınırı; tek akış üzerinden çoklama ile çözülür (bir sekme = bir akış, tüm konular aynı akışta).
