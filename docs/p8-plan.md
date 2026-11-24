# P8 — Ortak satış çekirdeği (G3) ve mention/anlık bildirim (G6) · uygulama planı

> 2026-11-24 · Kaynak: prompt Faz G3, Faz G6, §10.2 (B2B-03, B2B-05, TRK-01/02, MGR-01/04, MEN-01…13), ADR-0017, ADR-0021. Tek PR için büyük; dört adıma bölündü:
> - **P8a (bu dal, `feat/p8a-catalog`):** ürün kataloğu, vergi oranları, fiyat listeleri, kur tablosu, fiyat çözümleme; birincil ekip; ürün, fiyat ve ekip **ekranları**.
> - **P8b:** onay motoru (kural, seviye, limit, zaman aşımı, eskalasyon, onay kutusu) ve hedefler; ekranları.
> - **P8c:** mention'ın tüm alanlara yaygınlaştırılması (`@ekip`, açıklama alanları, "anınca erişim ver") ve editör eklentisi.
> - **P8d:** bildirim kanalları (web push, rahatsız etme saatleri, düşük kesintili kip), derin bağlantı, gecikme ölçümü (p95 < 2 sn).
>
> P8 dışı: `quote.sent`, `order.status_changed` olayları kaynağı olan modüllerle gelir (P9). Görev ↔ satış kaydı bağı (TRK-01) ile ortak müşteri kimliği ve mükerrer tespiti (SEG-05) P3'te yapıldı.

## 1. Veri modeli (`0015_catalog.sql`)
| Tablo | İçerik |
|---|---|
| `tax_rates` | ad, oran (%), aktif |
| `products` | SKU (tenant içinde büyük/küçük harf duyarsız tekil), ad, açıklama, kategori, birim, vergi oranı, `segments[]`, maliyet + para birimi, aktif |
| `price_lists` | ad, para birimi, segment (boş = hepsi), müşteri (boş = genel), geçerlilik aralığı, aktif |
| `price_list_items` | liste + ürün + en az miktar → birim fiyat (miktar kırılımı) |
| `fx_rates` | taban, karşıt, tarih → kur |

- Hepsi `tenant_id` + FORCE RLS. `products.segments` ve `price_lists.segment` segment politikasına bağlıdır; fiyat satırı yalnızca hem listesi hem ürünü görünürse görünür.
- Ürün, vergi oranı ve liste **silinmez**, pasifleştirilir (teklif/sipariş satırları bunlara bağlanacak).

## 2. Yetki
- Okuma: `catalog.product.manage` / `catalog.price_list.manage` **read**; yazma: **full** (Matris A17).
- Maliyet ve marj: `fields.cost_margin.read`. Yetki yoksa alanlar yanıtta **yer almaz**; yazma denemesi 403 `FIELD_READ_ONLY`.
- Müşteriye özel liste, o müşteriyi okuyamayana **görünmez** (404). Aynı kural fiyat çözümlemede de geçerlidir.

## 3. Fiyat çözümleme (`POST /v1/prices/resolve`)
Girdi: ürünler + miktarlar, segment, isteğe bağlı müşteri, para birimi, tarih. Her ürün için:
1. Aday listeler: aktif, tarihi kapsayan, segmenti uyan; müşteriye özelse istenen müşterininki.
2. Öncelik: **müşteriye özel → segmente özel → genel**. Aynı düzeyde: istenen para birimindeki liste, sonra en yeni `valid_from`, sonra en yeni liste.
3. O listede ürün için miktarı karşılayan en yüksek kırılım. Yoksa sonraki liste denenir.
4. Para birimi farklıysa kur tablosundan tarihteki en son kur (yoksa ters kurun tersi). Kur yoksa o liste atlanır.
5. Hiçbiri olmazsa `price: null` ve neden (`no_price` / `no_rate` / `inactive`).

Tutarlar `numeric`; çevrilen birim fiyat 4 haneye yuvarlanır (B80).

## 4. Birincil ekip
- İlk ekip birincil olur; birincil ekipten çıkarılan üyenin kalan ekiplerinden en eskisi birincil olur.
- `PUT /v1/users/{id}/primary-team` yalnızca kişinin üyesi olduğu ekibi kabul eder; yetki ekip üyesi yönetimiyle aynıdır (A06): Yönetici yalnızca yönettiği ekipleri seçebilir.

## 5. Ekranlar
- **Ürünler** (`/products`): ürünler, fiyat listeleri, kurlar ve vergiler sekmeleri; fiyat deneme paneli. Yazma yetkisi olmayana salt okunur.
- **Ayarlar → Ekipler** (`/settings/teams`): ekip, üst ekip, üye, yönetici, birincil ekip.

## 6. Kabul (P8a)
| Kriter | Kanıt |
|---|---|
| Fiyat listesi ve müşteriye özel fiyat kuralları testle doğrulandı (G3) | `catalog.int.test.ts` |
| Ekip verisi yetki kapsamına göre izole | `catalog.int.test.ts`, `authz.int.test.ts` |
| Maliyet/marj yetkisize sızmıyor | `catalog.int.test.ts` |
| Ekranlar axe ile denetleniyor | `catalog.spec.ts` |
