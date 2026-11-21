# ADR-0023: Idempotency-Key deposu ve API anahtarları

- Durum: Kabul edildi · Tarih: 2026-11-21 · Kapsam: Faz 5 (P5b) · Değiştirdiği: ADR-0012 "Idempotency-Key" maddesinin depolama kısmı · Gereksinimler: Bölüm 10 API, güvenilir entegrasyon

## Bağlam
ADR-0012, `Idempotency-Key` yanıtlarını bir `idempotency_keys` tablosunda saklamayı öngörüyordu. P5b'de uygularken iki şey görüldü:
1. Anahtar iş transaction'ından **önce** alınmalı (eşzamanlı ikinci istek 409 almalı), iş bitince yanıtla güncellenmeli. DB tablosunda bu, iş transaction'ından ayrı iki ek transaction demektir. Redis'te "ilk gelen alır" tek komuttur (`SET NX EX`).
2. Kayıtlar 24 saat yaşar ve sorgulanmaz; TTL'li bir anahtar-değer deposu doğal karşılıktır. Redis zaten kuyruk ve hız sınırı için zorunlu bağımlılıktır.

## Karar
- **Depo Redis:** anahtar `idem:{tenant}:{k:<apiKeyId>|u:<userId>}:{key}`, 24 saat TTL. İlk istek `{hash, pending}` ile anahtarı alır; başarıda `{hash, done, status, body}` yazılır; hata olursa anahtar silinir (istemci yeniden deneyebilir).
- Aynı anahtar + aynı istek (yöntem + yol + gövde, SHA-256) → saklanan yanıt, başlık `Idempotent-Replayed: true`. Farklı istek → 422 `IDEMPOTENCY_KEY_REUSED`. İlk istek sürerken → 409 `IDEMPOTENCY_IN_PROGRESS`.
- Kapsam: GET/HEAD/OPTIONS dışındaki tüm kimliği doğrulanmış istekler (genel `APP_INTERCEPTOR`). Anahtar biçimi `[A-Za-z0-9._:-]{8,200}`; aksi 400.
- Zorunluluk: toplu ve dış entegrasyon uç noktaları geldiğinde (P6+) bu uç noktalarda başlık zorunlu olur; P5b'de isteğe bağlı.
- **API anahtarları:** `fx_<8 karakter önek>_<gizli>`; yalnızca SHA-256 özeti saklanır, anahtar bir kez gösterilir. Anahtar, oluşturan kullanıcının **güncel** yetkisiyle ve kendi kapsamıyla çalışır (`read` → yalnızca GET; `write`). Anahtarlar şunları yapamaz (403 `API_KEY_SCOPE`): anahtar yönetmek, yetki matrisine dokunmak, kullanıcı rol/segment ataması yapmak, oturum gerektiren uç noktalara girmek. Anahtar başına dakikalık hız sınırı (Redis sayaç) → 429. İptal veya süre dolumu → 401.

## Sonuçlar
- (+) Atomik; ek DB yazımı yok; iş transaction'ı değişmez.
- (−) Redis kaybında (ör. kalıcılık kapalıyken yeniden başlatma) son 24 saatin anahtarları unutulur. O pencerede aynı anahtarla gelen tekrar bir kez daha çalışabilir. Üretimde Redis AOF açık çalışır. Kayıt düzeyinde kritik tekillik (ör. lead dönüştürme) zaten DB kısıtlarıyla korunur.

## Kanıt
`apps/api/src/common/idempotency.ts`, `apps/api/src/common/guards.ts`, `apps/api/test/integrations.int.test.ts` ("API keys and Idempotency-Key").
