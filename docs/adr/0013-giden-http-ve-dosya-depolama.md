# ADR-0013: Giden HTTP güvenliği (SSRF) ve dosya depolama

- Durum: Önerildi · Tarih: 2026-11-20 · Kapsam: Faz 4 (dosya), Faz 5 (webhook), G7, G11 (BYO uç nokta) · Gereksinimler: NFR-04, AIP-05, CC-12

## 1. Giden HTTP (tek istemci: `packages/config/http-egress`)
Webhook teslimatı, CCaaS REST çağrıları, BYO AI uç noktası, OIDC keşfi **yalnızca** bu istemciyi kullanır (diğer `fetch` kullanımları lint ile yasak).
- Yalnızca `https` (dev'de tenant ayarıyla `http` + localhost yasak kalır); port beyaz listesi 443, 8443 (tenant genişletebilir).
- DNS çözümleme **bizim** tarafımızda yapılır, tüm A/AAAA kayıtları kontrol edilir; özel (RFC 1918), loopback, link-local (169.254/16, bulut metadata dahil), CGNAT, ULA, multicast, IPv4-mapped IPv6 aralıkları reddedilir; bağlantı çözülen IP'ye sabitlenir (DNS rebinding engeli).
- Yönlendirme takip edilmez (3xx = başarısız teslim). Zaman aşımı: bağlantı 3 sn, toplam 10 sn; yanıt gövdesi en fazla 64 KB okunur.
- Webhook imzası: `Flexa-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, t + "." + body)>`; alıcı 5 dk tolerans; sır döndürmede iki imza birlikte gönderilir.
- Webhook otomatik devre dışı: 24 saat boyunca ardışık başarısızlık → `disabled_auto`, Admin bildirimi.

## 2. Dosya depolama
- S3 uyumlu (dev: MinIO). Anahtar: `tenants/{tenantId}/{kind}/{yyyy}/{mm}/{uuidv7}`; dosya adı yalnızca meta veride.
- Yükleme: istemci → `POST /v1/attachments:initiate` (boyut, MIME, hedef kayıt; yetki kontrolü) → imzalı PUT URL (5 dk) → `:complete` → **karantina** durumu → tarama kancası (ClamAV `clamd` adaptörü; dev'de devre dışı bırakılabilir ama durum `unscanned` olarak açıkça işaretlenir) → `available`.
- Limitler: varsayılan 25 MB/dosya, MIME beyaz listesi + sihirli bayt doğrulaması; SVG yalnızca temizlenerek.
- İndirme: her istekte yetki kontrolü + 60 sn imzalı GET URL, `Content-Disposition: attachment` (HTML/SVG satır içi açılmaz → XSS engeli).
- Çağrı kayıtları: tenant DEK ile istemci tarafı şifreli nesne (SSE-C veya uygulama içi AES-256-GCM), dinleme erişimi audit'li, saklama süresi işi ile silme.

## Sonuçlar
- (+) SSRF ve dosya kaynaklı XSS sistematik olarak engellenir.
- (−) Kullanıcının kendi ağındaki (özel IP) webhook hedefleri desteklenmez; kurumsal ihtiyaçta izinli CIDR listesi tenant başına platform operatörü onayıyla açılır.

## Uygulama notu (P4b, 2026-11-21)
- Dosya akışı `apps/api/src/modules/records/attachments.service.ts`: imzalı PUT (içerik türü ve `Content-Disposition` imzalı) → `complete`'te boyut ve dosya imzası (sihirli bayt) doğrulaması, uyuşmazlıkta nesne silinir → `ClamdScanner` (INSTREAM) ya da açıkça `unscanned`; tarayıcı erişilemezse dosya `quarantine`'de kalır ve indirilemez → indirme her istekte yetki + 60 sn imzalı GET.
- Geliştirme/test deposu SeaweedFS (MinIO imajları erişilemez, `assumptions.md` B33). SVG şimdilik kabul edilmiyor.

## Uygulama notu (P5b, 2026-11-21)
- Webhook teslimi `apps/api/src/modules/integrations/webhooks.service.ts`. Abonelik başına olay türü kalıpları vardır (`*`, `account.*`, tam ad). Gizli `whsec_…` tenant DEK'iyle şifreli saklanır; yalnızca oluşturmada ve döndürmede bir kez gösterilir.
- Başlıklar: `Flexa-Event`, `Flexa-Delivery`, `Flexa-Signature: t=<unix>,v1=<HMAC-SHA256(gizli, t + "." + gövde)>`. Döndürmeden sonra 24 saat boyunca eski gizliyle de imzalanır (iki `v1`).
- Gönderim `safePost` ile yapılır: DNS bir kez çözülür, özel/yerel adresler reddedilir ve bağlantı çözülen adrese sabitlenir (DNS rebinding yok). Yönlendirme izlenmez; 3 sn bağlantı / 10 sn toplam süre; yanıtın en çok 64 KB'ı okunur. 2xx dışı yanıt başarısız sayılır.
- 8 deneme, üstel bekleme + jitter (olay kuyruğuyla aynı). Teslimat geçmişi (durum, deneme, yanıt kodu, gecikme) ve elle yeniden gönderim vardır.
- 24 saat kesintisiz başarısızlıkta abonelik kapanır (`auto_failures`): `webhook.disabled` olayı, Admin bildirimi ve audit kaydı üretilir. Yeniden açınca sayaç sıfırlanır.
- Kural aksiyonu `call_webhook` aynı teslim hattını kullanır (abonelik olay türüyle eşleşmese de).
