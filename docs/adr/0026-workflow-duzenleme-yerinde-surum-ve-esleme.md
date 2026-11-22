# ADR-0026: Workflow düzenleme: yerinde sürüm ve durum eşleme

- Durum: Kabul edildi · Tarih: 2026-11-22 · Kapsam: P6c (workflow editörü), G4/G5 pipeline · İlgili: ADR-0019 · Gereksinimler: Faz 6 "Workflow editörü (görsel durum makinesi)", DM-03, DM-04

## Bağlam
ADR-0019, workflow değişikliğini yeni bir **yayımlanmış sürüm** olarak tasarladı: kayıtlar başladıkları sürüme bağlı kalacak (`workflow_version`), yeni sürüm yayımlanınca eski durumlar bir eşleme tablosuyla taşınacaktı. P2'de bu sürüm sabitleme uygulanmadı: kayıtlar `workflow_id` ve `status_id` taşır, `workflows.version` yalnızca bir sayaçtır. P6c'nin görsel editörü mevcut bir workflow'u değiştirebilmelidir.

Kayıt başına sürüm sabitlemek her liste, Kanban, RQL ve otomasyon sorgusunda "hangi sürümün durumları?" sorusunu doğurur. Aynı tabloda iki farklı durum kümesi yaşar, raporlar bunları birleştirmek zorunda kalır. Tenant'ların bir workflow'u değiştirdiği durumlarda istenen sonuç neredeyse her zaman "herkes yeni akışa geçsin"dir.

## Karar
- Workflow **yerinde** düzenlenir: `PUT /v1/workflows/{id}` tam tanımı alır (`If-Match: workflows.version`). Kayıt başına sürüm yoktur.
- **Kuru çalıştırma:** `POST /v1/workflows/{id}/preview` aynı gövdeyle eklenen ve kaldırılan durumları, kaldırılan her durumdaki kayıt sayısını ve eşlemenin tamam olup olmadığını (`applicable`) döner. Editör kaydetmeden önce bunu çağırır.
- **Eşleme:** kaldırılan bir durumda kayıt varsa gövdedeki `statusMap[kaldırılanId] = hedefDurumAnahtarı` zorunludur; yoksa 409 `WORKFLOW_STATUS_IN_USE` (sayımlarla) döner. Kayıtlar tek transaction'da hedef duruma taşınır; `closed_at` hedef kategoriye göre ayarlanır, kaydın `version`'ı artar.
- **Kimlik ve anahtar:** var olan durumlar `id` ile eşleşir ve **anahtarları değişmez**. Kayıtlı görünümler, kural koşulları, SLA duraklatma listeleri ve otomasyon `transition` eylemi anahtara başvurur. Geçişler bütün olarak yeniden yazılır; anahtarları editörde korunur.
- **Doğrulama:** `packages/workflow.validateWorkflow` (tek başlangıç durumu, ulaşılabilirlik, tekil anahtarlar, kendine geçiş yok) hem sunucuda hem editörde (canlı uyarı) çalışır.
- **Pipeline:** opportunity workflow'unda yeni aşama, workflow'u kullanan her pipeline'a `pipeline_stages` satırı olarak eklenir; `probability` verilirse güncellenir.
- **Segment:** çağıranın segment kısıtı yüzünden göremediği bir kayıt kaldırılan durumda kalırsa yabancı anahtar ihlali `WORKFLOW_STATUS_IN_USE` olarak döner. Bu durumda tüm segmentleri gören bir Admin değişikliği yapmalıdır.
- Toplu taşıma yapılandırma göçüdür: kayıt başına zaman çizelgesi olayı ve outbox olayı üretilmez. Değişiklik `workflow.updated` audit kaydında eklenen/kaldırılan durumlar ve taşınan kayıt sayılarıyla tutulur.

## Sonuçlar
- Raporlar ve görünümler her zaman tek bir durum kümesi görür; sürüm birleştirme gerekmez.
- Bir durumu kaldırmak geri alınamaz bir toplu güncellemedir. Editör bu yüzden kuru çalıştırmayı ve açık eşlemeyi zorunlu tutar.
- ADR-0019'daki `workflow_version` alanı ve yayım sihirbazı bu ADR ile geçersizdir. Kayıt başına sürüm sabitleme ileride gerekirse (ör. düzenlemeye tabi süreçler) yeni bir ADR ile eklenir.
