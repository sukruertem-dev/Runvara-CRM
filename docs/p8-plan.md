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

# P8b — onay motoru ve hedefler

## 7. Onay talebi ve yönlendirme
- Konu şimdilik **B2B fırsatında iskonto**; teklif (P9) aynı motoru kullanır. Talep eden fırsatı düzenleyebilmelidir; kayıt başına tek bekleyen talep.
- Yol: talep edenin birincil ekibi → üst ekipler. Her ekipte yöneticiler (talep eden hariç) içinden limiti yeten **ve** fırsatı görebilen; birden çoksa en az bekleyeni olan. Kimse yoksa **herhangi bir Admin**.
- Talep edenin kendi yetkisi (onaysız iskonto, yönetici limiti, Admin) yetiyorsa talep anında onaylı, "otomatik" kaydedilir (B84).
- Karar: atanan kişi ya da Admin; kendi talebi olamaz (DB CHECK de engeller); limit, izin ve kayda erişim karar anında yeniden denetlenir. Reddetmek limit gerektirmez.
- Süre dolunca bir üst ekip, sonra Admin, Admin'de de dolarsa `expired` (onaysız kapanır).

## 8. Kurallar ve limitler
- `approvals` ayar anahtarı (sürümlü): onaysız iskonto, yöneticinin varsayılan limiti, yanıt süresi (B85). `managerPercent ≥ freePercent`.
- `approval_limits`: kişiye özel limit, yalnızca Admin yazar.

## 9. Olay, bildirim, geçmiş
- `approval.requested|decided|escalated`, `discount.approval_requested`: konu kaydı üzerinde; oran ve gerekçe olayda yer almaz.
- Bildirim türü `approval`; karar ya da yönlendirme değişince onaycının okunmamış bildirimi geri çekilir.
- `approval_steps` yalnızca eklenebilir.

## 10. Hedefler
- Kişi / ekip (alt ekiplerle) / segment × ay / çeyrek × kazanılan tutar, kazanılan fırsat, kapatılan görev. Gerçekleşme okuma anında, tenant saat dilimiyle hesaplanır; farklı para birimi toplanmaz, sayısı bildirilir (B86).
- Okuma A19: kendi / yönettikleri / hepsi. Yazma: Admin hepsi; Yönetici yalnızca yönettikleri, kendisi için değil.
- `target.at_risk`: dönemin en az %25'i geçmiş ve gerçekleşme geçen sürenin %75'inin altındaysa, hedef başına bir kez (B87).

## 11. Ekranlar
Onaylar (`/approvals`), fırsatta iskonto paneli, Ayarlar → Onay kuralları, Hedefler (`/targets`).

## 12. Kabul (P8b)
| Kriter | Kanıt |
|---|---|
| Onay motoru limit aşımında doğru onaylayıcıya yönlendiriyor; Yönetici limitini aşanı onaylayamıyor (G3) | `approvals.int.test.ts` |
| Zaman aşımı ve eskalasyon | `approvals.int.test.ts` |
| Ekip ve hedef verileri yetki kapsamına göre izole (G3) | `approvals.int.test.ts` |
| Ekranlar axe ile denetleniyor | `approvals.spec.ts` |
