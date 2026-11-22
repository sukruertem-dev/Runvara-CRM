# Mimari Karar Kayıtları (ADR)

Biçim: Bağlam → Karar → Alternatifler → Sonuçlar. Durum: Önerildi / Kabul / Yerini aldı (`NNNN`). Yeni ADR bir sonraki numarayı alır; kabul edilmiş ADR değiştirilmez, yerine yenisi yazılır.

| No | Başlık | Durum | Faz |
|---|---|---|---|
| [0001](0001-teknoloji-yigini-ve-monorepo.md) | Teknoloji yığını ve monorepo | Önerildi | Tümü |
| [0002](0002-veritabani-orm-ve-migration.md) | Veritabanı, ORM ve migration | Önerildi | F1 |
| [0003](0003-multi-tenancy-ve-rls.md) | Çok kiracılılık, RLS, tenant bağlamı | Önerildi | F1, G1 |
| [0004](0004-yetki-motoru.md) | Merkezi yetki motoru | Önerildi | F4 + G2 |
| [0005](0005-veri-modeli-kurallari.md) | Veri modeli kuralları (polimorfik, sahiplik, kuyruk, sıralama, para) | Önerildi | F2, F3 |
| [0006](0006-olay-yolu-outbox.md) | Olay yolu (outbox) ve otomasyon güvenlik önlemleri | Önerildi | F5 |
| [0007](0007-gercek-zamanli-iletisim.md) | Gerçek zamanlı iletişim (SSE) | Önerildi | F5, G6 |
| [0008](0008-sorgu-dili-rql.md) | Sorgu dili (RQL) | Önerildi | F2 |
| [0009](0009-kimlik-dogrulama-ve-oturum.md) | Kimlik doğrulama, oturum, API anahtarları | Önerildi | F1 |
| [0010](0010-segment-modeli-ve-ortak-musteri-kimligi.md) | Segment modeli ve ortak müşteri kimliği | Önerildi | F3, G2 |
| [0011](0011-yapilandirma-katmanlari-blueprint-marka.md) | Yapılandırma katmanları, blueprint, marka | Önerildi | G1 |
| [0012](0012-api-sozlesmeleri.md) | API sözleşmeleri | Önerildi | Tümü |
| [0013](0013-giden-http-ve-dosya-depolama.md) | Giden HTTP (SSRF) ve dosya depolama | Önerildi | F4, F5 |
| [0014](0014-modul-kaydi-kota-adalet-operator.md) | Modül kaydı, kota, adalet, operatör erişimi | Önerildi | F1, G1 |
| [0015](0015-telefoni-gateway-ve-olay-semasi.md) | Telefoni ağ geçidi ve normalize olay şeması | Önerildi | G7 |
| [0016](0016-data-servisi.md) | Data Servisi | Önerildi (Q1) | G7 |
| [0017](0017-mention-ve-bildirim.md) | Mention ve bildirim | Önerildi | F4, G6 |
| [0018](0018-custom-field-ve-formul.md) | Custom field ve formül | Önerildi | F2 |
| [0019](0019-workflow-ve-status.md) | Status ve workflow motoru | Önerildi | F2 |
| [0020](0020-zaman-tekrar-ve-sla-takvimi.md) | Zaman dilimi, tekrar, SLA takvimi | Önerildi | F2, F5 |
| [0021](0021-teklif-versiyonlama-ve-onay-motoru.md) | Teklif versiyonlama ve onay motoru | Önerildi | G3, G4 |
| [0022](0022-ai-mimarisi.md) | AI asistan mimarisi (çerçeve) | Önerildi | G11 |
| [0023](0023-idempotency-anahtari-ve-api-anahtarlari.md) | Idempotency-Key deposu (Redis) ve API anahtarları | Kabul edildi | Faz 5 |
| [0024](0024-on-yuz-yigini-ve-tasarim-sistemi.md) | Ön yüz yığını ve tasarım sistemi | Kabul edildi | Faz 6, G9 |
| 0025 | AI model seçimi | G11'de yazılacak | G11 |
