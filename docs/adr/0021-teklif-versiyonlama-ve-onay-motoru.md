# ADR-0021: Teklif versiyonlama ve onay motoru

- Durum: Önerildi · Tarih: 2026-11-20 · Kapsam: G3 (onay motoru), G4 (teklif), G5 (iade/kampanya) · Gereksinimler: B2B-04, B2B-05, B2C-05, MGR-04, AUTH-08

## Teklif
- `quotes` (başlık: opportunity, müşteri, para birimi, durum, `current_version`) + `quote_versions` (değişmez anlık görüntü: kalemler, iskontolar, vergiler, toplamlar, geçerlilik, fiyat listesi sürümü, PDF nesne anahtarı, içerik hash'i) + `quote_lines`.
- Düzenleme yalnızca `draft` sürümde; `submitted/sent` olan sürüm trigger ile değiştirilemez (UPDATE/DELETE → hata). Değişiklik = yeni taslak sürüm (`n+1`, önceki sürümden kopyalanır).
- Durum akışı (workflow motoru): `draft → pending_approval → approved → sent → accepted | rejected | expired`; `pending_approval` yalnızca iskonto kuralı tetiklenirse.
- Toplam hesaplama tek fonksiyon (`packages/contracts/pricing`), `numeric` aritmetiği (decimal.js), satır → iskonto → vergi sırası ve yuvarlama kuralı (satır bazında, para biriminin küçük birimine, half-even) belgelenmiş; PDF ve API aynı fonksiyonu kullanır.
- PDF: sunucu tarafı HTML şablon → headless Chromium (Playwright) işçide; sürüm gönderildiğinde üretilip hash'iyle saklanır.

## Onay motoru (genel)
- `approval_rules(tenant_id, kind ∈ {discount, return, campaign, access_request, …}, condition (AST), approver_strategy ∈ {owner_manager, team_manager, role, user}, levels jsonb, timeout_hours, escalation)`.
- `approval_requests(subject_type, subject_id, kind, requested_by, amount/percent, level, assigned_to, state ∈ {pending, approved, rejected, expired, cancelled}, decided_by, decided_at, reason)`.
- Onaylayıcı seçimi: talep sahibinin birincil ekibinin Yöneticisi; Yöneticinin `approve_limit` değeri talebi karşılamıyorsa **bir üst seviye** (üst ekip Yöneticisi → Admin). Talep sahibi kendi talebini onaylayamaz. Zaman aşımında eskalasyon; tüm kararlar audit + olay (`discount.approval_requested`, `approval.decided`).
- Kayıt düzeyinde kilit: onay beklerken konu kayıt (teklif sürümü) değiştirilemez; red → taslağa döner.

## Sonuç
G3 kabul kriteri "Yönetici kendi limitini aşanı onaylayamaz" motorun seçici kuralı ile **yapısal olarak** sağlanır (yetkisiz kişiye atama yapılmaz) ve ayrıca karar anında `can()` ile tekrar kontrol edilir.

## Uygulama notu (P8b, 2026-11-25)
- `approval_rules` tablosu yerine kurallar yapılandırma motorunda: `approvals` anahtarı (sürüm, diff, geri alma hazır gelir). Kişiye özel limitler `approval_limits` tablosunda.
- Eskalasyon geçmişi `approval_steps` (yalnızca eklenebilir). Son seviyede (Admin) süre dolarsa talep `expired` olur.
- Talep edenin kendi yetkisi içindeki talep "otomatik onaylı" kaydedilir; bu bir karar değildir, `decided_by` boştur.
- Yetki talepleri (`access_requests`) P4b akışında kaldı (B88).
