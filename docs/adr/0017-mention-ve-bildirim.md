# ADR-0017: Mention ve bildirim mimarisi

- Durum: Önerildi · Tarih: 2026-11-20 · Kapsam: Faz 4 (temel), G6 · Gereksinimler: MEN-01…13, AIN-04

## 1. Zengin metin ve yapısal mention
- Editör: TipTap (ProseMirror). Saklama biçimi: ProseMirror JSON (`body jsonb`) + sunucuda üretilen temizlenmiş HTML (`body_html`, yalnızca izinli düğümler/işaretler; DOMPurify eşdeğeri sunucu tarafı şema doğrulaması) + düz metin (`body_text`, FTS için).
- Mention düğümü: `{ "type": "mention", "attrs": { "kind": "user" | "team", "id": "uuid" } }`; etiket (isim) **saklanmaz**, okuma anında çözülür (MEN-02).
- Mention destekli alanlar: `notes.body`, `tasks.description`, `comments.body`, `calls.note`, `quotes.note`, `returns.note`, `qa_evaluations.coaching_note`, CRM kayıtlarının `description` alanları.

## 2. Doğrulama akışı (sunucu)
1. Gövde ayrıştırılır, mention düğümleri çıkarılır (en fazla 20 kullanıcı + 3 ekip / içerik; MEN-11).
2. Her kullanıcı için `can(ctxHedef, read, kayıt)`; erişimsiz biri varsa → **422** `MENTION_TARGET_NO_ACCESS` (yanıt hangi kullanıcının erişimsiz olduğunu yalnızca **anan kişinin zaten görebildiği** kullanıcılar için söyler).
3. Politika "anınca erişim ver" açıksa ve anan kişinin `share` yetkisi varsa: hedefe `record_shares(source='mention')` okuma paylaşımı oluşturulur + audit.
4. `@ekip`: üyelere genişletilir; erişimi olmayan üyeler **sessizce atlanır** (ekip mention'ı geçerlidir), genişletme sonucu `mentions` satırlarında `via_team_id` ile tutulur.
5. Düzenlemede eski ve yeni mention kümeleri karşılaştırılır (MEN-08): yalnızca yeni eklenenlere bildirim; kaldırılanlar `retracted_at` + okunmamış bildirim geri çekilir (`notification.retracted` SSE olayı).

## 3. Bildirim boru hattı
```text
mention.created (outbox) → notification servisi
  → notifications (alıcı başına satır; içerik değil referans: source, record, actor)
  → kanal kararı: tercihler + rahatsız etme saatleri (kullanıcı saat dilimi) + çevrimiçi mi?
     ├─ in-app: SSE (ADR-0007) → toast/rozet; çağrıdaysa "düşük kesintili" (yalnızca rozet, MEN-12)
     ├─ web push (VAPID, push_subscriptions): yalnızca başlık "X sizi bir kayıtta andı" (içerik yok)
     └─ e-posta yedeği: 10 dk içinde okunmadıysa ve kullanıcı çevrimdışıysa, özet (digest) olarak; içerik yetki kontrolünden geçmiş kısa alıntı
  → notification_deliveries (kanal, durum, gecikme)
```
- **Okuma anında yetki** (MEN-09): `GET /v1/notifications` her satır için kaynak kaydı predicate ile birleştirir; erişim kaybedilmişse satır "Bu içeriğe artık erişiminiz yok" olarak döner, alıntı ve kayıt adı **boş**.
- Okundu senkronu (MEN-10): `notifications.read_at`; değişim `notification.read` SSE olayıyla kullanıcının tüm cihazlarına.
- Derin bağlantı: `/r/{recordType}/{recordId}#comment-{id}`.
- Tekilleştirme: aynı (alıcı, kaynak içerik, mention) için tek bildirim; kullanıcı başına dakikada 30 mention oluşturma sınırı.
- AI özetleri mention düğümlerini **düz metne** çevirerek işler; bildirim üretmez (AIN-04).

## 4. Ölçüm
`notification_e2e_latency_seconds` (olay → SSE yazımı) ve istemci ack ile uçtan uca; hedef p95 < 2 sn; SLO alarmı p95 > 2 sn (5 dk pencere).

## 5. KVKK (MEN-13)
Kullanıcı anonimleştirmede: mention düğümleri `{kind:"user", id:<anon-id>}` olarak kalır, okuma anında "Silinmiş kullanıcı" çözülür; bildirimleri silinir; push abonelikleri silinir.
