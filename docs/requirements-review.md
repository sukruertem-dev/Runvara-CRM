# Gereksinim İncelemesi: Bulunan Eksikler, Çelişkiler ve Düzeltmeler

> Faz 0 / G0 analiz çıktısı · 2026-11-20
> Kaynak: `CRM_TASK_PLATFORM_PROMPT.md`. Her madde için karar ve bağlı ADR verilmiştir. Kaynak dosya **değiştirilmemiştir**; düzeltmeler bu doküman, ADR'ler ve `docs/assumptions.md` üzerinden geçerlidir. Çelişki halinde öncelik: bu doküman > kaynak prompt (yalnızca listelenen maddelerde).

Önem: **K** = kritik (düzeltilmezse güvenlik/veri bütünlüğü riski veya yeniden yazım), **Y** = yüksek, **O** = orta.

## A. Mimari ve sıralama

| # | Bulgu | Önem | Karar | ADR |
|---|---|---|---|---|
| A1 | G0, Faz 1–5'e bağımlı gösteriliyor; ancak segment, modül kapısı ve 4 koşullu yetki modeli Faz 1–4'ün veri modelini belirliyor. Faz 1–5 önce yapılıp G0 sonra yapılırsa CRM tabloları ve RBAC **yeniden yazılır**. | K | Faz 0 ve G0 **birlikte** yapıldı (bu oturum). Segment sütunları Faz 3'ten, modül kayıt defteri ve tenant yaşam döngüsü Faz 1'den itibaren vardır. | 0004, 0010, 0014 |
| A2 | Faz 4 (genel RBAC) ile G2 (segment + kapsam + alan) iki ayrı yetki motoru gibi tanımlanmış. | K | **Tek motor** (`packages/authz`) Faz 4'te G2 kapsamıyla birlikte kurulur. G2 fazı segment yönetim API'leri, delegasyon ve talep akışına iner. | 0004 |
| A3 | Faz 1 kabul kriteri "Kayıt → giriş → 2FA → tenant seçimi E2E" bir web arayüzü gerektirir; arayüz Faz 6'da. | Y | Faz 1'de **minimal auth arayüzü** (giriş, kayıt, 2FA, tenant seçimi) `apps/web` içinde yapılır; Faz 6 tasarım sistemine taşınırken davranış değişmez. | `phase-plan.md` |
| A4 | Önerilen iki MVP yolu (1. bölüm) birbirinden farklı ve arayüzü en sona bırakıyor; uzun süre görünür ürün olmaz. | O | Bütünleşik yol `docs/phase-plan.md`'de: tasarım sistemi + kabuk Faz 4'ten sonra, modül ekranları ilgili fazla birlikte (G9'un izin verdiği kademeli yol). | `phase-plan.md` |
| A5 | Kaynak prompt, komutlarda `PROJECT_PROMPT.md` adını kullanıyor; dosyanın adı `CRM_TASK_PLATFORM_PROMPT.md`. | O | Kök dizine `CLAUDE.md` eklendi; kalıcı bağlamı ve dosya adını işaret eder. Kaynak dosya yeniden adlandırılmadı. | n/a |

## B. Çok kiracılılık ve güvenlik

| # | Bulgu | Önem | Karar | ADR |
|---|---|---|---|---|
| B1 | "Her tabloda `tenant_id`" kuralı; ancak `users` (bir kişi birden çok tenant'a üye), `tenants`, `telephony_numbers` (DID → tenant çözümü tenant bilinmeden yapılır), platform operatörü ve model kaydı doğası gereği tenant dışıdır. Kural istisnasız uygulanırsa giriş ve gelen arama akışı çalışmaz; istisna gelişigüzel yapılırsa sızıntı olur. | K | Kapalı istisna listesi + `SECURITY DEFINER` çözümleyici fonksiyonlar + CI denetimi. | 0003 |
| B2 | RLS'in atlanamaması için uygulama rolünün tablo sahibi olmaması ve `FORCE ROW LEVEL SECURITY` gerektiği belirtilmemiş (tablo sahibi RLS'i varsayılan olarak atlar). | K | `flexa_owner` / `flexa_app` (NOBYPASSRLS) ayrımı, tüm tenant tablolarında FORCE RLS, bağlam yoksa 0 satır. | 0003 |
| B3 | Outbox relay'in tüm tenant'ları tarayabilmesi RLS ile çelişir. | Y | Yalnızca `outbox_events` üzerinde yetkili `flexa_relay` rolü; iş işleme her olayda `SET LOCAL` ile tenant bağlamında. | 0003, 0006 |
| B4 | JWT tabanlı oturum ile "yetki değişikliği en geç bir sonraki istekte geçerli" (G2) ve "eski token/oturum" penetrasyon senaryosu (G10) çelişir. | K | JWT yalnızca kimlik + `authz_version` taşır; izinler istek başına sürümlü önbellekten yüklenir; sürüm uyuşmazlığı bağlamı yeniler; kritik değişiklikte refresh ailesi iptal edilir. | 0004, 0009 |
| B5 | `calls.customer_ref JSONB` örneği, 5.1'deki `related_type + related_id` polimorfik modeliyle tutarsız ve bütünlük kontrolü yapılamaz. | Y | Tüm polimorfik referanslar `related_type` + `related_id` sütunu ve `record_registry` üzerinden **gerçek bileşik FK** ile korunur. | 0005 |
| B6 | Webhook URL'leri ve AI BYO uç noktası SSRF riski taşır; çözümleme sonrası IP kontrolü (DNS rebinding) belirtilmemiş. | Y | Giden HTTP tek istemciden: şema/port izin listesi, DNS çözümleme sonrası özel/link-local/metadata IP reddi, yönlendirme takibi kapalı. | 0013 |
| B7 | Tenant'a bölünmüş adil kuyruk için BullMQ'nun "groups" özelliği ücretli (Pro). | O | Açık kaynak BullMQ ile shard + tenant round-robin + tenant başına token bucket; ayrıntı ADR'de. | 0014 |

## C. Veri modeli

| # | Bulgu | Önem | Karar | ADR |
|---|---|---|---|---|
| C1 | `queues` hem Faz 2'de (görev sahibi kuyruk/grup) hem çağrı merkezinde (çağrı kuyruğu) geçiyor; iki ayrı kavram tek ad altında. | Y | Tek `queues` tablosu, `kind ∈ {work, call}`; "Kuyruk" kapsamı (AUTH-04) her ikisini kapsar, çağrı kuyruğu santral eşlemesi ayrı tabloda. | 0005 |
| C2 | B2C "bireysel müşteri" ile CRM "Contact" ilişkisi tanımsız (ayrı tablo mu?). SEG-05 "kimlik ortak, görünürlük segmente göre" diyor. | Y | Kişi kimliği tek: `contacts`; `segments[]` dizisi. B2C müşteri = `segments` içinde `b2c` olan contact + `customer_profiles` (B2C'ye özgü alanlar: RFM, tercih). Account opsiyonel. | 0010 |
| C3 | `phone_numbers` (müşteri telefonları) ile `telephony_numbers` (DID) adları karışıyor. | O | Müşteri telefonları `contact_points` (tip: phone/email/…; telefon E.164 normalize, indeksli); DID'ler `telephony_numbers`. | 0005 |
| C4 | Kimlik üretimi belirtilmemiş; UUIDv4 B-tree indekslerde yazma dağınıklığı yaratır. | O | PostgreSQL 18 yerel `uuidv7()`; zaman sıralı, cursor sayfalamada kararlı. | 0002 |
| C5 | Para tutarları için tip ve kur stratejisi belirsiz (çoklu para birimi varsayımı "Evet"). | O | `numeric(18,4)` + `currency char(3)`; `fx_rates(tenant_id, base, quote, rate, valid_on)`; raporlarda tenant ana para birimine işlem tarihindeki kurla çevrim. | 0005 |
| C6 | "Özel not" (AIR-05) kavramı AI bölümünde geçiyor, ancak not veri modelinde (Faz 3/4) yok. | Y | `notes.visibility ∈ {standard, private}`; private not yalnızca yazarına ve Admin'e görünür (yetki motoru kuralı), başkasının raporuna/özetine girmez. | 0004 |
| C7 | Teklif versiyonlarının "değiştirilemez" olması (G4) için DB düzeyinde garanti tanımlı değil. | O | `quote_versions` ve `quote_lines` gönderildikten sonra trigger ile UPDATE/DELETE reddi (audit log ile aynı desen). | 0021 |

## D. Arayüz ve marka (hesaplanarak doğrulandı)

> **2026-11-20 güncellemesi:** Marka Runvara → **Flexa** olarak değişti; bu bölümdeki palet bulguları tarihsel kayıttır. Güncel palet, token'lar ve erişilebilirlik ayarları: `docs/brand.md`.

Tüm kontrast oranları WCAG 2.x göreli parlaklık formülüyle yeniden hesaplandı (`scripts/contrast-report.mjs`, çıktı `docs/contrast-report.md`). Kaynakta yazılan oranların **tamamı doğru**; aşağıdakiler eksik veya hatalı **kullanım** kurallarıdır.

| # | Bulgu | Önem | Karar |
|---|---|---|---|
| D1 | 10.5.2: Koyu temada ana buton `--accent` zemin + `--on-accent` metin olarak tanımlı: `#F4F1EA` / `#FF5A5F` = **2.71:1 (BAŞARISIZ)**. 12.4 ise doğru token olarak `--accent-btn`'i veriyor. | K | Koyu tema ana butonu: `--accent-btn` zemin + `--on-accent` metin (5.22:1). Token haritası düzeltildi (`tokens.json`). |
| D2 | Koyu `--accent` (`#FF5A5F`) metni yüzen katman zemini `--bg-raised` (`#2E3035`) üzerinde **4.33:1 (BAŞARISIZ)**; komut paleti ve popover'lar bu zemini kullanır. | Y | Koyu `--accent` ve `--b2c` → **`#FF6B70`** (surface 5.41, raised 4.77, canvas 6.09). Ton aynı aile, fark gözle zor seçilir. Onay sorusu: `assumptions.md` Q4. |
| D3 | Girdi kutusu, onay kutusu gibi bileşen sınırları için 3:1 (WCAG 1.4.11) sağlayan token yok; `--border` 1.20–1.36:1. | Y | Yeni token `--border-strong`: açık `#7E8187` (beyaz 3.91, canvas 3.46, subtle 3.19), koyu `#80838A` (surface 3.94, canvas 4.44, raised 3.48). `--border` yalnızca dekoratif ayraç/kart. |
| D4 | Koyu temada `--bg-subtle`, `--accent-hover`, `--accent-soft`, `--b2b-soft`, `--b2c-soft`, `--*-soft` token'ları **yok**; açık temada `--bg-raised`, `--accent-btn` yok. Token parite eksikliği, bileşenlerde sabit renk yazılmasına (lint ihlali) yol açar. | Y | Tam parite: her token iki temada tanımlı (`tokens.json`); eksik koyu değerler hesaplanarak eklendi, tümü metin çiftinde ≥ 4.5:1. |
| D5 | Grafik paleti: açık temada `#E8858C` beyaz üzerinde **2.57:1**, koyu temada `#7A0A1C` surface üzerinde **1.34:1**; grafik işaretleri metin dışı öğe olarak ≥ 3:1 olmalı. | O | Açık tema: seri 3 `#8A8D93` → `#7E8187` (canvas üzerinde de ≥ 3:1), seri 4 `#E8858C` → `#D9545D` (3.91:1). Koyu tema: seri 5 `#7A0A1C` → `#F2B8BC` (8.80:1). Grafikler `--bg-surface` üzerinde çizilir. Seriler ayrıca çizgi stili/işaretçi ile ayrışır (kaynakla aynı). Ölçümler `contrast-report.md`. |
| D5b | Koyu temada buton hover rengi tanımsız; `--accent-hover` metin rengi olarak kullanılırsa (`#FF8A8E`) üzerindeki `--on-accent` metni okunmaz. | O | Yeni token `--accent-btn-hover`: açık `#9E0C24` (beyazla 8.29), koyu `#A50D26` (`#F4F1EA` ile 6.93). `--accent-hover` yalnızca metin/bağlantı hover'ı. |
| D6 | 12.5'teki `@media (prefers-color-scheme: dark)` bloğu yorum satırı içeriyor ("aynısı"); kopyala-yapıştır ile bozulur. | O | CSS, `tokens.json`'dan **üretilir**; elle kopyalama yok. |
| D7 | Logo kuralı "16 px'te çizgi 12" ve favicon "rx 22" 100'lük ızgarada tanımlı; 32 px varyantı için rx belirtilmemiş. | O | 32 px: rx 24, çizgi 10, kıvılcım r 6. G9'da `packages/brand` ile üretilir. |

## E. Belirsizlikler (varsayımla devam; `docs/assumptions.md`)

| # | Konu | Varsayım |
|---|---|---|
| E1 | "Data Servisi" yorumu | Santral/IVR için güvenli lookup + olay alma + toplu senkron (DS-01…09). Onay sorusu Q1 |
| E2 | İlk santral/CCaaS | Asterisk (ARI) + genel webhook CCaaS (Twilio uyumlu sözleşme). Yerel sağlayıcı (Netgsm/Verimor) adaptörü G7 sonrası. Onay sorusu Q2 |
| E3 | Kod deposu ve CI | GitHub Actions hedefleniyor; depo şu an uzak sunucusuz (remote yok). Onay sorusu Q3 |
| E4 | Kurumsal ayrı şema/DB izolasyonu | G1'de yalnızca hazırlık: tenant → `db_cluster` eşleme tablosu ve bağlantı yönlendirici arayüzü; gerçek ayrı DB sonraki sürüm |
| E5 | Marka araştırması | Alan adı/TÜRKPATENT/EUIPO/WIPO/npm kontrolü yapılmadı (kaynak da belirtiyor); risk kaydında R-21 |

## F. Kapsamı doğru ama ölçülmesi zor kriterler

| Kriter | Sorun | Uygulanacak ölçüm |
|---|---|---|
| "Worker çökmesi sonrası olaylar kaybolmuyor" | Ölçüm tanımı yok | Kaos testi: N olay üret, işleme sırasında worker'ı `SIGKILL`, yeniden başlat; outbox'ta `published_at IS NULL` = 0 ve tüketici `processed_events` sayısı = N |
| "Sıfırdan kurulum 15 dakika" | Makine bağımlı | CI'da temiz runner üzerinde `docker compose up --wait` + seed süresi ölçülür ve raporlanır |
| "Lighthouse ≥ 90" | Geliştirme modunda ölçülürse yanlış | Üretim derlemesi + `lhci` ile mobil profil |
