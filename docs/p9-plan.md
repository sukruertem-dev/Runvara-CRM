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


# P9c — forecast, aktivite kuralları, uçtan uca akış

## 15. Forecast (B2B-07)
- Dönem: ay (`2026-11`) ya da çeyrek (`2026-Q4`). Sayılanlar:
  - kapanış tarihi (`expected_close`) dönemde olan **açık** B2B fırsatları: açık tutar ve ağırlıklı tutar (tutar × olasılık);
  - dönemde (tenant saat dilimi) **kazanılan** fırsatlar: tam tutarla.
- Kapanış tarihi olmayan açık fırsat sayılmaz. Para birimleri ayrı toplanır, kur çevrimi yok.
- Kişi başına tahmin = Yönetici ayarı varsa o, yoksa kazanılan + ağırlıklı.
- Hesap her açılışta canlı yapılır: yeniden atanan fırsat yeni sahibin satırına geçer.

## 16. Kapsam (AC-G4-4)
- `sales_b2b.forecast.read` A14 satırında (B104): Admin tümü, Yönetici ekibi, Temsilci kendi. Analist göremez (403).
- Bir fırsat yalnızca iki koşul birlikte sağlanırsa sayılır:
  - kişi onu okuyabilir (kayıt yetkisi);
  - fırsatın sahibi kişinin forecast kapsamındadır.
- Tutar alanı gizliyse ya da B2B segmenti yoksa forecast 404 döner. B2C fırsatları hiç sayılmaz.

## 17. Yönetici ayarı
- `sales_b2b.forecast.adjust` A15 satırında, `approve` modunda (B104): Admin herkesi, Yönetici yönettiği ekiplerin üyelerini ayarlar. Kendi tahminini ayarlayamaz, Temsilci hiç ayarlayamaz.
- Ayar kişi, dönem ve para birimi başına tektir. Tutar ve gerekçe içerir; `amount: null` ayarı kaldırır. Her değişiklik denetim kaydına yazılır.

## 18. Anlık görüntü
- El ile: Admin ya da Yönetici, kendi kapsamındaki tabloyu kaydeder.
- Zamanlanmış: her pazartesi 01:00 UTC (katalog işi `sales_b2b.forecast.snapshot`). B2B açık her workspace için içinde bulunulan ay ve çeyrek kaydedilir.
- Görüntü değişmez. Okuyan kişi görüntüde yalnızca kendi kapsamındaki kişileri görür. Her görüntü için `forecast.snapshot_taken` olayı yazılır.

## 19. Dokunulmamış fırsat (TRK-05)
- Son işlem şu üçünden en yenisidir: fırsatın oluşturulması, fırsat zaman çizelgesindeki son olay (alan değişikliği, aşama, yorum, arama/e-posta kaydı, teklif, sözleşme, sipariş), fırsata bağlı görevin son güncellemesi.
- `sales_b2b.activity_rules.staleDays` gündür (varsayılan 7) işlem görmeyen açık fırsatlar için saatlik tarama şunları yapar:
  - fırsat sahibine ve ekibinin (üst ekipler dahil) yöneticilerine bildirim gönderir;
  - `opportunity.stale` olayını yazar.
- Uyarı her "son işlem" için bir kez gider; yeni bir işlemden sonra yeniden uyarı gidebilir.
- Ekranlar:
  - fırsat sayfasında "Sonraki adım" paneli: son işlem, uyarı, sonraki adım;
  - forecast sayfasında dokunulmamış fırsatlar listesi.

## 20. Sonraki adım
- Sonraki adım, fırsata bağlı açık görevlerden vadesi en yakın olandır.
- `requireNextStep` açıksa (varsayılan kapalı) B2B fırsatı başka bir açık aşamaya geçerken açık görev ister; yoksa 422 `NEXT_STEP_REQUIRED` döner. Kapatma (kazanma, kaybetme) bu kurala bağlı değildir.
- Ayar: Ayarlar → Satış hatları → Aktivite kuralları.

## 21. Kabul (P9c, G4 sonu)
| Kriter | Kanıt |
|---|---|
| Aday → fırsat → teklif → iskonto onayı → sözleşme → sipariş (AC-G4-1) | `forecast.spec.ts` |
| Teklif sürümleri değişmez (AC-G4-2) | `quotes.int.test.ts` |
| Yalnızca B2B yetkilisi erişir (AC-G4-3) | `contracts.int.test.ts`, `forecast.int.test.ts` |
| Forecast kapsam dışı kayıt içermez (AC-G4-4) | `forecast.int.test.ts` |
| Ağırlıklı forecast, Yönetici ayarı, anlık görüntü (B2B-07) | `forecast.int.test.ts`, `forecast.spec.ts` |
| Dokunulmamış fırsat uyarısı, sonraki adım (TRK-05) | `forecast.int.test.ts`, `forecast.spec.ts` |


# P9d — B2C müşteri profili ve rıza

## 22. B2C müşterisi (C2)
- Müşteri, segmentlerinde `b2c` olan kişidir (`contacts`). Telefonlar P3'ten beri E.164 biçiminde saklanır.
- B2C'ye özgü alanlar ayrı tablolarda tutulur (hepsi `b2c` segmentinde):
  - `customer_profiles`: tercih ettiği kanal, dil, en çok 20 etiket;
  - `customer_addresses`: en çok 20 adres, biri varsayılan.
- Okuma ve yazma yetkisi kişi kaydından gelir (`*record*`). B2C segmenti olmayan kullanıcı ya da B2C olmayan kişi için 404 döner.
- Profil `If-Match` ile sürümlenir. Her değişiklik kişinin zaman çizelgesine `customer` olarak, yalnızca B2C kullanıcılarının göreceği şekilde düşer.

## 23. Rıza (B2C-06)
- İzin kanal başınadır: e-posta, SMS, telefon, WhatsApp.
- Her kayıt şunları taşır: durum (`granted` | `withdrawn`), kaynak (web formu, telefon, mağaza, e-posta, içe aktarma, API, diğer), kanıt, dış kayıt numarası (İYS gibi, A11), müşterinin bildirdiği zaman (geleceğe ait olamaz), kaydeden kişi.
- Güncel durum `consents` tablosunda tutulur. Her değişiklik ayrıca değiştirilemez `consent_events` tablosuna yazılır.
- Her değişiklik için `consent.changed` olayı ve denetim kaydı (`consent.granted` / `consent.withdrawn`) yazılır.
- Yetki A25 satırından gelir (`sales_b2c.consent.read` / `.manage`), kapsam müşterinin sahibine göredir:
  - Temsilci kendi müşterisi için, Yönetici ekibininki için, Admin herkesinki için okur ve yazar.
  - Analist yalnızca okur.
  - Çağrı temsilcisinin kuyruk kapsamı, okuyabildiği müşteriler demektir (B110).
- Workspace kanalları kapatabilir (`sales_b2c.consent_channels`). Kapalı kanala izin kaydedilmez ve o kanaldan kimseye ulaşılmaz.

## 24. Erişilebilirlik: tek kontrol
- `GET /v1/sales/b2c/customers/:id/reachability?channel=` ve aynı işi gören sunucu fonksiyonu (`reachability`).
- Cevap "evet" ya da nedeniyle birlikte "hayır": `not_b2c`, `channel_disabled`, `no_consent`, `withdrawn`, `no_contact_point`.
- Kampanyalar (P9f), otomasyonlar (bu adım) ve giden arama / dialer (G7–G8) iletişimden önce bu kontrolü kullanır. Liste ekranı `?reachable=kanal` ile yalnızca ulaşılabilir müşterileri süzer.

## 25. Otomasyon: müşteriye e-posta (AC-G5-2)
- Yeni otomasyon eylemi `email_customer`, yalnızca kişi kurallarında kullanılabilir.
- Gönderimden önce e-posta izni kontrol edilir. İzin yoksa ileti gönderilmez, çalıştırma başarılı sayılır ve eylem sonucunda engel nedeni (`blocked: no_consent`) görünür.
- İleti `customer_message` şablonuyla gider: bağlantı içermez, alt bilgi iznin dayanağını ve geri çekme yolunu söyler.

## 26. Bilinen sınırlar
- Kişiler birleştirilirse birleşen kişinin izinleri taşınmaz. Kalan kişinin kendi izinleri geçerlidir; izin hiçbir zaman varsayılmaz (B112).
- KVKK kapsamında müşteri verisinin dışa aktarılması ve anonimleştirilmesi siparişlerle birlikte P9e'de yapılacak.

## 27. Ekranlar
- `/sales/b2c/customers`: arama (ad, e-posta, telefon), etiket, izin süzgeci; yeni müşteri penceresi.
- `/sales/b2c` şimdilik müşterilere yönlenir.
- Kişi sayfasında (B2C, modül açık): iletişim izinleri ve geçmişi, profil, adresler.
- Otomasyon kural editöründe "Müşteriye e-posta gönder" eylemi.

## 28. Olaylar
- `consent.changed` (channel, status)
- `customer.updated` (changedFields)

## 29. Kabul (P9d)
| Kriter | Kanıt |
|---|---|
| Müşteri profili, adres, etiket, E.164 (B2C-01) | `customers.int.test.ts`, `crm.int.test.ts`, `customers.spec.ts` |
| Kanal bazlı rıza, kaynak, zaman, geri çekme (B2C-06) | `customers.int.test.ts`, `customers.spec.ts` |
| Rızasız müşteriye otomasyon iletisi gitmez (AC-G5-2, otomasyon kısmı) | `customers.int.test.ts` |
| Yalnızca B2C yetkilisi erişir (AC-G5-3, müşteri kısmı) | `customers.int.test.ts` |


# P9e — B2C sipariş, iade, KVKK

## 30. B2C siparişi (B2C-02)
- B2C siparişi ortak `orders` tablosundadır (segment `b2c`).
- Sipariş verilerini müşteri, kanal (web, mağaza, telefon, sosyal medya), ödeme durumu (`pending`, `paid`, `failed`, `refunded`, `partially_refunded`), teslimat adresinin kopyası, kargo firması ve takip numarası oluşturur.
- Kalemler katalogdan gelir. Fiyat B2C fiyat listelerinden (P8a çözücüsü), vergi üründen alınır. Toplamlar teklifle aynı fonksiyonla hesaplanır. Fiyatı olmayan ürün için `QUOTE_PRICE_MISSING` döner.
- Görünürlük müşteriden türer: müşteriyi okuyabilen siparişini de görür. Sipariş oluşturmak müşteriyi düzenleme hakkı ister (B114).
- Numara `SP-YYYY-00001` biçimindedir; B2B siparişleriyle aynı sayaç kullanılır.

## 31. Sipariş akışı (B2C-03)
- Akış: `new → confirmed → preparing → shipped → delivered`. İptal kargodan önce ve gerekçeyle yapılır. `returned` durumuna yalnızca onaylanmış iadeyle geçilir.
- Akış `packages/workflow` içinde saf bir fonksiyondur (`b2cOrderStep`) ve birim testiyle doğrulanır.
- Her adımı hangi rollerin atacağı tenant ayarıdır (`sales_b2c.order_workflow`). Varsayılan:
  - Temsilci ve çağrı temsilcisi onaylar.
  - Hazırlama, kargoya verme ve teslim Yönetici ve Admin'dedir.
  - İptal Temsilci, Yönetici ve Admin'dedir.
  - Ödeme durumunu Temsilci, çağrı temsilcisi, Yönetici ve Admin değiştirir.
- Durum hatalıysa 409 `ORDER_STATE`, rol uymuyorsa 403 döner.
- Toplu adım `POST /orders/steps` her siparişi ayrı işlemde yürütür ve her biri için ayrı sonuç döner.
- Durum ve ödeme değişikliklerinin geçmişi değiştirilemez (`order_status_history`).

## 32. İade (B2C-05)
- Yalnızca teslim edilmiş siparişin kalemleri iade edilir.
- İade miktarı, siparişteki miktardan bekleyen ve onaylanmış iadeler düşüldükten sonra kalan miktarı aşamaz (`RETURN_QUANTITY`).
- Tutar, kalemin KDV dahil tutarının iade edilen orandaki payıdır.
- Talep `sales_b2c.return.create` iznini ister (A16 satırında; herhangi bir yetkisi olan talep açabilir, B115).
- Kararı A16 verir (`approve` modu):
  - Admin her iadeye karar verir.
  - Yönetici, ekibinin müşterilerine ait iadelere `sales_b2c.returns.managerLimit` (varsayılan 5000, sipariş para biriminde) tutarına kadar karar verir.
  - Talep eden kişi kendi talebine karar veremez.
- Bildirimler:
  - Talep açılınca ekip yöneticilerine bildirim gider; tutar limitin üstündeyse ya da ekip yöneticisi yoksa Admin'lere gider.
  - Karar verilince talep edene bildirim gider.
- Onaylanan iade:
  - Siparişin her kalemi geri geldiyse sipariş `returned` olur.
  - Ödenmiş sipariş, iade kısmiyse `partially_refunded`, tamsa `refunded` olur.
- Talebi açan kişi, karar verilmemiş talebini geri çekebilir.

## 33. Olaylar (stok ve finans)
- `order.created`, `order.status_changed`, `order.payment_changed` (orderId)
- `return.requested`, `return.approved`, `return.rejected`, `return.cancelled` (returnId)
- `customer.anonymized`
- Olaylar alan değeri taşımaz; tüketici ayrıntıyı API'den okur.

## 34. KVKK talepleri
- **Dışa aktarma** (`GET /customers/:id/export`, Admin): kimlik ve iletişim, profil, adresler, izin geçmişi, siparişler (kalemler ve iadelerle), zaman çizelgesi. İşlem denetim kaydına yazılır.
- **Anonimleştirme** (`POST /customers/:id/anonymize`, Admin, müşteri adının yeniden yazılmasıyla onaylanır):
  - Ad, iletişim noktaları, açıklama, özel alanlar, profil, adresler, siparişlerin teslimat adresi ve notları silinir.
  - Tüm izinler geri çekilir; geri çekme izin geçmişine yazılır.
  - Siparişler ve iadeler muhasebe için kişisiz olarak kalır.
  - Zaman çizelgesi değişen alanları gösterir ama eski değerleri göstermez.
  - Anonimleştirilmiş müşteriye sipariş açılamaz.

## 35. Bilinen sınırlar
- İade limiti kur çevirmez: limit sipariş para biriminde tek sayıdır.
- Kampanya ve kupon ile siparişte iskonto P9f'de gelecek.

## 36. Ekranlar
- `/sales/b2c`: sipariş listesi; arama, durum ve kanal süzgeci, toplu adım.
- `/sales/b2c/orders/:id`: kalemler, toplamlar, adım düğmeleri, ödeme durumu, geçmiş, iadeler, iade talebi.
- `/sales/b2c/returns`: iade listesi. `/sales/b2c/returns/:id`: onay/ret, geri çekme.
- Müşteri sayfasında:
  - siparişler ve "Sipariş oluştur";
  - Admin için KVKK talepleri (dışa aktarma ve anonimleştirme).

## 37. Kabul (P9e)
| Kriter | Kanıt |
|---|---|
| Sipariş → ödeme → teslim → iade akışı E2E (AC-G5-1) | `orders.spec.ts` |
| Kalemler, kanal, ödeme ve teslimat durumu (B2C-02) | `orders.int.test.ts` |
| Rol bazlı sipariş akışı (B2C-03) | `b2c-order.test.ts`, `orders.int.test.ts` |
| İade talebi ve onayı, olaylar (B2C-05) | `orders.int.test.ts` |
| Yalnızca B2C yetkilisi erişir (AC-G5-3) | `orders.int.test.ts`, `customers.int.test.ts` |
| KVKK: müşteri verisini dışa aktarma ve anonimleştirme | `orders.int.test.ts`, `orders.spec.ts` |


# P9f — kampanya, kupon, RFM, otomasyonlar, ölçüm (G5 sonu)

## 39. Kampanya (B2C-04)
- Kampanyanın bilgileri:
  - ad ve başlangıç/bitiş tarihi;
  - indirim yüzdesi (0 = yalnızca ileti);
  - çakışma kuralı (`exclusive`);
  - hedef müşteriler: etiketlerden ve RFM segmentlerinden herhangi biri; ikisi de boşsa tüm B2C müşterileri;
  - isteğe bağlı e-posta iletisi.
- Durum akışı: `draft → pending_approval → active → ended | cancelled`. Bitiş tarihi geçince kampanya kendiliğinden `ended` görünür.
- Yetki A26'dan gelir:
  - Admin kampanyayı doğrudan başlatır.
  - Yöneticinin kampanyası (`requires_approval`) Admin onayını bekler; Admin'lere bildirim gider (US-MGR-12).
  - Temsilci, çağrı temsilcisi ve analist yalnızca okur.
- Yalnızca taslak düzenlenir (`If-Match`). Her adım denetim kaydına yazılır.

## 40. Kupon ve çakışma kuralı
- Kupon bir kampanyaya bağlıdır. Kupon bilgileri: kod (büyük harf, tekil), indirim yüzdesi, en çok kullanım sayısı, müşteri başına kullanım sınırı, etkin/kapalı.
- Kuponun geçmesi için kampanya yürürlükte, gün kampanya aralığında ve müşteri kampanyanın hedefinde olmalıdır. Aksi halde neden döner: `unknown`, `inactive`, `not_started`, `expired`, `used_up`, `customer_limit`, `not_in_audience`.
- Kullanım siparişle aynı işlemde sayılır. Kupon satırı kilitlenir ve sayaç koşullu artırılır; 501. kullanım reddedilir.
- Sipariş indirimi:
  - Müşterinin hedefinde olduğu en yüksek indirimli kampanya kendiliğinden uygulanır; kupon verilmişse kuponun indirimi de eklenir.
  - İki indirim toplanır, ancak biri birleşmez (`exclusive`) işaretliyse yalnızca büyük olan geçerlidir. Toplam en çok %100'dür.
  - Kuponun kendi kampanyası ayrıca kendiliğinden uygulanmaz.
  - İndirim tekliflerdeki hesaplama fonksiyonuyla sipariş geneline uygulanır. Siparişte ara toplam, indirim, kampanya ve kupon görünür.

## 41. Kampanya iletisi ve rıza (AC-G5-2)
- Önizleme (`/audience`): hedefteki müşteri sayısı, e-posta gidebilecek müşteri sayısı ve gidemeyenlerin nedenleri (`no_consent`, `withdrawn`, `no_contact_point`, …).
- Gönderim yalnızca yürürlükteki kampanyada ve bir kez yapılır. Her hedef müşteri için bir kayıt düşer (`campaign_deliveries`): `sent` ya da `blocked` (nedeniyle).
- E-posta yalnızca izni olana gider (`reachability`). `campaign.started` olayı yazılır.

## 42. RFM (B2C-07)
- Her gece 02:00'de (katalog işi `sales_b2c.rfm.recompute`) iptal edilmemiş ve iade edilmemiş B2C siparişlerinden hesaplanır.
- R: son siparişten bu yana geçen gün sayısına göre 1–5 puan; eşikler 30, 60, 90 gün ve uyku eşiği.
- F: pencere içindeki sipariş sayısına göre 1–5 puan; eşikler 1, 2, 3, 5 ve 10 sipariş.
- M: tutarın workspace içindeki beşte birlik dilimi.
- Segment:
  - **Uyuyan:** uyku eşiği aşıldıysa (varsayılan 120 gün).
  - **Şampiyon:** R≥4 ve F≥4.
  - **Sadık:** F≥3.
  - **Yeni:** R≥4 ve tek sipariş.
  - **Risk altında:** R≤2.
  - **Düzenli:** diğerleri.
- Ayar `sales_b2c.rfm`: pencere (varsayılan 365 gün) ve uyku eşiği. Admin hesabı istediği an yeniden çalıştırabilir.
- RFM verisini okuma `sales_b2c.rfm.read` izniyle olur (A25 kapsamı, B119). `customer.rfm_recomputed` olayı yazılır.

## 43. B2C otomasyonları
- Ayar `sales_b2c.automations`; hepsi varsayılan olarak kapalıdır.
- **Terk edilmiş sipariş:** `new` durumunda ve ödemesi bekleyen sipariş N saat sonra.
- **Tekrar satın alma:** teslim edilmiş siparişten N gün sonra, müşteri arada yeni sipariş vermediyse.
- **Geri kazanım:** müşteri "Uyuyan" segmentine girince sahibine "Geri kazanım: …" görevi açılır.
- Her üçünde e-posta yalnızca izin varsa gider. Her otomasyon her konu için bir kez çalışır (`b2c_automation_runs`); izin yoksa çalıştırma kaydında neden tutulur.

## 44. Ölçüm (AC-G5-4)
- 100 000 sipariş ve 5 000 müşteriyle sipariş listesinin p95 değeri 200 ms'nin altındadır: `docs/perf/p9-b2c-orders.md`.
- Liste sorgusu önce sipariş sayfasını, sipariş numarası sırasıyla dizin üzerinden seçer; müşteri görünürlüğünü her sipariş için ayrıca denetler; ayrıntıları en son ekler. Önceki biçim müşterilerden başlıyor ve eşleşen tüm siparişleri sıralıyordu (durum süzgeciyle p95 198 → 38 ms).
- Kanal süzgeci için ayrı bir dizin eklendi.

## 45. Bilinen sınırlar
- Kampanya iletisi yalnızca e-posta kanalından gider. SMS ve WhatsApp sağlayıcısı entegrasyonlarla (G9) gelecek. İzin kontrolü kanalı zaten tanıyor.
- Kampanya indirimi kur çevirmez; yüzde olarak uygulanır.

## 46. Ekranlar
- `/sales/b2c/campaigns`: liste ve yeni kampanya penceresi.
- `/sales/b2c/campaigns/:id`: onay, hedef önizlemesi, gönderim, kuponlar.
- `/sales/b2c/rfm`: segment sayıları, segmente göre müşteriler, yeniden hesapla.
- Siparişte kupon kodu ve "Dene"; sipariş sayfasında indirim satırı; müşteri profilinde RFM.

## 47. Kabul (P9f, G5 sonu)
| Kriter | Kanıt |
|---|---|
| Kampanya ve kupon: tarih, kullanım limiti, hedef, çakışma kuralı (B2C-04) | `campaigns.int.test.ts`, `campaigns.spec.ts` |
| Rızasız müşteriye kampanya ve otomasyon iletisi gitmez (AC-G5-2) | `campaigns.int.test.ts`, `customers.int.test.ts`, `campaigns.spec.ts` |
| RFM ve geri kazanım, tekrar satın alma ve terk edilmiş sipariş otomasyonları (B2C-07) | `campaigns.int.test.ts` |
| 100 bin siparişte p95 < 200 ms (AC-G5-4) | `test/perf/b2c-orders.perf.test.ts`, `docs/perf/p9-b2c-orders.md` |
