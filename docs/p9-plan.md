# P9 — B2B (G4) ve B2C (G5) satış · uygulama planı

> 2026-11-25 · Kaynak: prompt Faz G4, Faz G5, §10.2 (B2B-01…08, B2C-01…08), ADR-0021. Sıra kullanıcı kararı (Q5): **önce B2B, sonra B2C**. Adımlar:
> - **P9a (bu dal, `feat/p9a-quotes`):** teklif: kalemler, iskonto, vergi, değişmez sürümler, iskonto onayı, PDF, e-postayla gönderim; ekranları.
> - **P9b:** satın alma rolleri, kazanma/kaybetme nedeni ve aşama koşulları, sözleşme (yenileme hatırlatıcısı), B2B sipariş; ekranları.
> - **P9c:** forecast (ağırlıklı, Yönetici ayarı, anlık görüntü), dokunulmamış fırsat uyarısı, sonraki adım; uçtan uca akış testi. G4 biter.
> - **P9d:** B2C müşteri profili, rıza yönetimi ve engelleri.
> - **P9e:** sipariş, sipariş akışı, iade/iptal ve onayı.
> - **P9f:** kampanya, kupon, RFM, otomasyonlar; 100 bin sipariş ölçümü. G5 biter.
>
> B2B-08 ve B2C-08 (öncelik C) sonraki sürüm.

# P9a — teklif

## 1. Veri modeli (`0019_quotes.sql`)
| Tablo | İçerik |
|---|---|
| `quotes` | numara, fırsat, para birimi, durum, geçerli sürüm, iç not, müşteri yanıtının açıklaması |
| `quote_versions` | genel iskonto, geçerlilik, giriş, koşullar, müşteri adı (anlık görüntü), toplamlar, onay oranı, kilit, gönderim |
| `quote_lines` | ürün anlık görüntüsü (SKU, ad, birim, vergi), miktar, liste fiyatı, birim fiyat, iskonto, tutarlar |
| `quote_documents` | gönderilen PDF: nesne anahtarı, SHA-256, boyut (yalnızca eklenir) |
| `quote_counters` | tenant ve yıl başına sayaç |
| `quote_deliveries` (`0020`) | gönderilecek e-posta (ek hariç), deneme sayısı, kuyruğa giriş zamanı |

- **Değişmezlik veritabanında:** gönderilmiş sürüm hiç değişmez; kilitli sürümün içeriği değişmez; satırlar yalnızca kilitsiz sürüme yazılır. Sürümler silinmez (tenant silme hariç).

## 2. Yetki
- Teklif fırsatın parçasıdır: okuyan fırsatı okuyabilmeli; yazan `sales_b2b.quote.create` iznine sahip olmalı ve fırsatı düzenleyebilmeli; gönderen ayrıca `sales_b2b.quote.send`.
- Fırsatın tutarı alan politikasıyla gizliyse teklifler görünmez (404).
- Yalnızca B2B fırsatında; modül kapısı `/v1/sales/b2b`.

## 3. Hesaplama (`packages/contracts/src/pricing.ts`)
- Tek fonksiyon; API, PDF ve editör aynı fonksiyonu kullanır. Tam sayı aritmetiği, kayan nokta yok.
- Miktar × birim fiyat → satır iskontosu → genel iskonto → yuvarla (satır bazında, para biriminin küçük birimi, half-even) → yuvarlanmış satırın vergisi → yuvarla. Toplamlar yuvarlanmış satırların toplamı.
- Ad, birim, vergi ve liste fiyatı katalogdan gelir; birim fiyat elle değiştirilebilir. Katalogda fiyat yoksa girilmesi zorunludur (422 `QUOTE_PRICE_MISSING`).

## 4. Durum akışı ve onay
`draft → (pending_approval →) approved → sent → accepted | rejected | expired`
- **Onay oranı:** satırların liste fiyatına göre en yüksek iskontosu (elle düşürülen fiyat ve genel iskonto dahil), yukarı yuvarlanır. Tamamlama anındaki liste fiyatlarıyla ölçülür; müşteriye yazılan fiyat değişmez.
- Oran onaysız sınırı aşarsa P8b onay motoruna gider (gerekçe zorunlu). Konu fırsattır; talep teklife ve sürüme bağlıdır. Red, geri çekme ve süre aşımında aynı sürüm yeniden taslaktır.
- Gönderilmiş, onaylanmış, reddedilmiş ya da süresi dolmuş tekliften yeni taslak sürüm kopyalanır. Kabul edilen teklif kapanır.
- Geçerlilik tarihi geçen gönderilmiş teklif saatlik işle `expired` olur; süresi geçmiş teklif iş çalışmadan da kabul edilemez.
- Şablon: `sales_b2b.quote_template` (ön ek, geçerlilik günü, giriş, koşullar, alt bilgi).

## 5. Belge ve gönderim
- PDF `pdfkit` + gömülü DejaVu yazı tipi (Türkçe); taslakta filigran. Gönderilen belge saklanır ve sonradan **o** belge verilir (hash doğrulanır).
- E-posta teklifi ekte taşır, yanıt adresi gönderen kişidir. Aynı sürüm aynı adrese bir kez kuyruğa girer. E-posta, sürümü gönderildi yapan işlemde `quote_deliveries` tablosuna yazılır; kuyruk almazsa dakikalık iş artan aralıklarla (en çok bir saat) yeniden dener.
- Olaylar `quote.created|submitted|revised|sent|accepted|rejected|expired` fırsat üzerinde; tutar ve adres taşımaz.

## 6. Ekranlar
Fırsatta Teklifler paneli, `/sales/b2b/quotes` listesi, teklif editörü (canlı toplam, PDF önizleme, sürümler, iç not + mention), onay kutusunda teklif bağlantısı, Ayarlar → Teklif şablonu.

## 7. Kabul (P9a)
| Kriter | Kanıt |
|---|---|
| Teklif sürümleri değiştirilemez (G4) | `quotes.int.test.ts` |
| İskonto limiti aşılınca onay akışı | `quotes.int.test.ts`, `quotes.spec.ts` |
| Tutarlar tek fonksiyondan, yuvarlama kuralı testli | `pricing.test.ts` |
| Yetkisize teklif, PDF ve tutar sızmıyor | `quotes.int.test.ts` |
| Ekranlar axe ile denetleniyor | `quotes.spec.ts` |

# P9b — satış hatları, sözleşme, B2B sipariş

## 8. Satış hatları ve satın alma rolleri (B2B-01, B2B-02)
- P3'te gelenler: satın alma rolleri (`account_contact_roles`), aşama olasılığı, kazanma için tutar ve kaybetme için neden zorunluluğu (akış doğrulayıcıları).
- Yeni: Admin satış hattı ekler (`POST /v1/pipelines`: ad, segment, fırsat akışı), varsayılan yapar, aşama olasılıklarını değiştirir. Olasılığı elle verilmemiş fırsatlar yeni değere geçer.
- Hat seçilmeden açılan fırsat: varsayılan hat segmente uyuyorsa o; değilse segmentin hattı; yoksa tüm segmentlere açık hat.
- Ekranlar: Ayarlar → Satış hatları; firma sayfasında kişilerin satın alma rolü.

## 9. Sözleşme
- Yalnızca **kazanılan** B2B fırsatı için (kapalı aşama ve olasılık > 0; B86 ile aynı kural). Kabul edilen teklif verilirse tutar ve para birimi tekliften gelir.
- Görünürlük fırsattan türer; yazmak `sales_b2b.contract.manage` ister (A14 satırına eklendi, B100) ve fırsatı düzenleme hakkı.
- Durum: `active → ended | renewed | terminated`. Fesih dönem içinde bir tarihle ve gerekçeyle.
- **Yenileme:** yeni dönem bitişin ertesi günü başlar; süre takvimle aynıdır (6 ay → 6 ay). Bir dönem bir kez yenilenir.

## 10. Hatırlatma ve dönem sonu (saatlik iş)
- `bitiş − bildirim günü` geldiğinde: fırsat sahibine görev ("Sözleşme yenileme"), bildirim, `contract.renewal_due` olayı. Bir kez; bitiş ya da bildirim süresi değişirse yeniden.
- Bitiş geçince: kendiliğinden yenilenen sözleşme yenilenir, diğeri `ended` olur.

## 11. B2B sipariş
- Kazanılan fırsatın kabul edilen teklifinden, teklif başına bir sipariş. Kalemler ve toplamlar teklif sürümünden kopyalanır; sipariş kalemleri değişmez.
- Durum: `open → fulfilled | cancelled` (iptal gerekçeli). B2C sipariş akışı P9e'de aynı tabloya eklenir.

## 12. Olaylar
`contract.created|updated|renewed|terminated|renewal_due`, `order.created|fulfilled|cancelled`; fırsat üzerinde, tutar taşımaz.

## 13. Ekranlar
Fırsatta Sözleşmeler ve Siparişler panelleri, `/sales/b2b/contracts` ve `/sales/b2b/orders` listeleri ile ayrıntı sayfaları.

## 14. Kabul (P9b)
| Kriter | Kanıt |
|---|---|
| Çoklu hat, aşama olasılığı (B2B-02) | `contracts.int.test.ts`, `contracts.spec.ts` |
| Satın alma rolleri (B2B-01) | `crm.int.test.ts`, `contracts.spec.ts` |
| Sözleşme, hatırlatma, yenileme, B2B sipariş (B2B-06) | `contracts.int.test.ts`, `contracts.spec.ts` |
| Yalnızca B2B yetkilisi görür | `contracts.int.test.ts` |
