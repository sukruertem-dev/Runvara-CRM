# Varsayımlar ve Açık Sorular

> Faz 0 + G0 · 2026-11-20. Kaynak §4 kural 3: varsayımla devam edilir; ilerlemeyi engelleyen belirsizlik için **tek toplu soru** sorulur (bkz. sonda "Toplu soru"). Bir varsayım değişirse bu dosya ve ilgili ADR güncellenir.

## A. Kaynak dokümandaki varsayılanlar (§10.2.4, §11.2.4) — kabul edildi

| # | Konu | Varsayım |
|---|---|---|
| A01 | "Data Servisi" | Santral/IVR için güvenli lookup + olay alma + toplu senkron (DS-01…09), ADR-0016 — **Q1 ile teyit isteniyor** |
| A02 | İlk santral | Asterisk (ARI) + genel webhook CCaaS (Twilio uyumlu sözleşme) — **Q2 ile teyit isteniyor** |
| A03 | Softphone | İlk sürümde isteğe bağlı; CTI birincil |
| A04 | Tenant izolasyonu | Paylaşımlı şema + RLS; kurumsal ayrı şema/DB yalnızca hazırlık (ADR-0003) |
| A05 | Yönetici birden çok ekip | Evet |
| A06 | Kullanıcı birden çok ekip | Evet, bir **birincil ekip** zorunlu |
| A07 | Yönetici silme | Yalnızca arşivler; kalıcı silme Admin |
| A08 | Rapor export'u | Varsayılan kapalı; Admin politikasıyla açılır |
| A09 | Çağrı kaydı dinleme | Varsayılan kapalı; yetkili Yönetici/Admin + tenant politikası |
| A10 | Canlı dinleme/devreye girme | Varsayılan kapalı; politika + bildirim/anons zorunlu (yerel mevzuat hukuk danışmanıyla doğrulanır) |
| A11 | B2C giden arama | Rıza + arama saati zorunlu; İYS benzeri sistemler için entegrasyon noktası (`consents.external_ref`), kapsam hukuk danışmanıyla |
| A12 | Erişimsiz kişiye mention | Anılamaz; "anınca erişim ver" Admin ayarıyla (varsayılan kapalı) |
| A13 | Çoklu para birimi | Evet; tenant ana para birimi + kur tablosu (ADR-0005 §6) |
| A14 | Maliyet/marj alanları | Satış ve Çağrı Temsilcisi'nden gizli (FLS) |
| A15 | "Açık kaynak AI" | Açık ağırlıklı model kendi altyapımızda; lisans eklemeden önce doğrulanır |
| A16 | AI donanımı | Ölçülerek belirlenir (G11), tahmin yapılmaz |
| A17 | AI dış sağlayıcı | Varsayılan kapalı, tenant Admin onayıyla |
| A18 | Embedding/vektör arama | İlk sürümde yok |
| A19 | Kişi bazlı AI raporu | Kendi raporu herkes; başkası için Yönetici (ekibi, segment dahilinde) ve Admin |
| A20 | Özel not | Başkasının raporuna/özetine girmez |
| A21 | Çağrı transkripti | Kapsam dışı (sonraki sürüm) |
| A22 | Özet saati | Kullanıcı saat diliminde 08:30 |
| A23 | Ham istem/yanıt | Saklanmaz; yalnızca üst veri |
| A24 | Çalışan bilgilendirme | Şeffaflık günlüğü zorunlu; metin tenant onaylı |
| A25 | AI çıktı dili | Kullanıcının arayüz dili |

## B. Faz 0 analizinde alınan ek kararlar

| # | Konu | Varsayım / karar | Bağ |
|---|---|---|---|
| B01 | Faz sırası | Faz 0 + G0 birlikte; Faz 4 ve G2 tek yetki motoru; bütünleşik plan | `phase-plan.md` |
| B02 | Yığın seçimi | NestJS + Fastify, Drizzle, PostgreSQL 18, SSE | ADR-0001/2/7 |
| B03 | Modül kapalı yanıtı | **Tüm modüller için** 404 `MODULE_DISABLED` (kaynak yalnızca AI için 404 diyordu; tutarlılık için genelleştirildi) | ADR-0014 |
| B04 | Özel not görünürlüğü | Yalnızca yazar okur (Admin dahil başkası okuyamaz); KVKK dışa aktarımında yazarın verisi | ADR-0004 §9 |
| B05 | Analist mention | Matris A'da "—": Analist mention oluşturamaz; yorum yazma da yok (salt okuma rolü) | permission-matrix A27 |
| B06 | `@ekip` mention | Yalnızca kayda erişimi olan üyeler bildirim alır; erişimsiz üyeler sessizce atlanır | ADR-0017 |
| B07 | Kuyruk kapsamı | Kuyruktaki kayıtlar + kuyruğa bağlanmış müşteriler + aktif/24 saat içindeki çağrının müşterisi | ADR-0004 §2 |
| B08 | Çağrı kısayolları | `Alt+` kombinasyonları (wireframes.md'de listelendi); tarayıcıyla çakışan `Alt+D/F/H/E` kullanılmaz | wireframes |
| B09 | Kontrast düzeltmeleri | Koyu `--accent`/`--b2c` → `#FF6B70`; yeni `--border-strong`, `--accent-btn-hover`, grafik token'ları; tam tema paritesi — **Q4 ile teyit isteniyor** | requirements-review §D |
| B10 | Varsayılan onay limitleri (seed) | Yönetici iskonto onay limiti %15, Satış Temsilcisi'nin onaysız iskontosu %8'e kadar | ADR-0021, seed |
| B11 | Varsayılan hız sınırı (seed) | Kullanıcı başına 600 istek/dk, tenant başına plan değeri | ADR-0012 |
| B12 | Operatör destek erişimi süresi | En fazla 8 saat, varsayılan 4 saat | ADR-0014 §6 |
| B13 | Elif (B2C Yönetici) – Zeynep'in siparişi | Aynı ekip + segment → erişebilir (kaynakta açıkça yazmıyor, kapsam tanımından türetildi) | Matris B |
| B14 | GraphQL | Kapsam dışı (kaynakta "isteğe bağlı") | ADR-0012 |
| B15 | Matris B export sütunu | Burak "Hayır", Selin "Evet": kullanıcı düzeyi `export_allowed` ile, politika açık demo tenant'ta | permission-matrix |
| B16 | Platform Operatörü konsolu | §12.3 modül ailesinde yok; ayrı uygulama (`apps/operator`), tenant modül kataloğunda yer almaz | ADR-0014 |
| B17 | Ülke ve telefon normalizasyonu | Varsayılan ülke tenant ülkesi (TR), E.164 | ADR-0005 §4 |
| B18 | Depo konumu | Depo OneDrive dışına, yerel `C:\Users\Casper\Projects\runvara` klasörüne taşındı (2026-11-20). OneDrive kopyası artık kullanılmıyor | R-25 |
| B19 | Ürün adı | Runvara → **Flexa** (2026-11-20, kullanıcı kararı); marka kaynağı `packages/ui/brand.json`, `docs/brand.md` | docs/brand.md |
| B20 | Flexa ikincil metin rengi | JSON'daki `#8B93A7` metin kontrastını sağlamadığından metinde `#646B7E`; `#8B93A7` metin dışı öğelerde | docs/brand.md §3 |
| B21 | Flexa logosu | Resmi SVG verildi (2026-11-20); açık zemin sürümü yalnızca yazı rengiyle, sembol yalnızca viewBox kırpmasıyla türetildi | docs/brand.md §2 |
| B22 | RQL ayrıntıları | Tırnaksız kelime metin değeri sayılır; `today()`/tarih değeri datetime alanında tüm yerel gün; boş `myTeams()` hiçbir şeyle eşleşmez; liste uç noktasında `ORDER BY` yerine `sort` parametresi | packages/query-lang |
| B23 | Görev yetki kapsamı (P2) | `own` = sahip, atanan veya oluşturan; ekip/kuyruk kapsamı P4'e kadar `own`'a daraltılır (fail-closed); başkasına görev vermek `reassign` (yalnızca Admin) | ADR-0004, docs/p2-plan.md §6 |
| B24 | Segment varsayılanı (P3) | Kullanıcı segment yetkisi P4'e kadar = tenant satış modu; tenant iki segmentte satıyorsa kayıt oluştururken segment zorunlu (`SEGMENT_REQUIRED`), tek segmentte otomatik | docs/p3-plan.md |
| B25 | Kayda bağlı görev/not segmenti | Görev ve not, bağlandığı kaydın segmentini devralır (kimlik kaydı iki segmentteyse segmentsiz); böylece gizli segmentin görevi/notu da gizlenir | ADR-0010, docs/p3-plan.md |
| B26 | Merge ve görünmeyen segment | Birleştirilen kayıtlardan biri çağıranın göremediği bir segmentteyse merge reddedilir (`MERGE_INVALID`): RLS altında taşınamayan satırlar silinmiş kayıtta kalmasın | docs/p3-plan.md |
| B27 | `*record*` kaynak daraltması | Matris A'daki `resources` listesi uygulanır (Çağrı Temsilcisi yalnızca lead ve kişi oluşturur; görev oluşturamaz) | permission-matrix.yaml A09 |
| B28 | Rol atamada `no_escalation` | Kayıt izinlerinde kapsam katı karşılaştırılır (own < {queue, team} < segment < all). Kayıt dışı referans verisinin okunması (A17 katalog, A26 kampanya) granter aynı izne herhangi bir yetkiyle sahipse kapsanmış sayılır; aksi hâlde Yönetici Satış Temsilcisi atayamazdı (A04 ile çelişki). Sonuç: Yönetici yalnızca Satış Temsilcisi ve Yönetici rolü verebilir; Çağrı Temsilcisi (kuyruk kapsamı) ve Analist (tümünü okuma) veremez | ADR-0004 §7, packages/authz `canAssignRole` |
| B29 | OWD varsayılanı | Her nesne için `private`; Admin `read` / `read_write` yapabilir. OWD ve paylaşım (manuel, kural) yalnızca **okuma ve düzenlemeyi** genişletir; arşivleme, yeniden atama, toplu işlem ve kalıcı silme genişlemez; rolün eylem izni yoksa hiçbir paylaşım onu vermez | docs/p4-plan.md §3 |
| B30 | Davet edilen kullanıcının segmentleri | Varsayılan: davet edenin etkin segmentleri; Admin istediğini seçer, Yönetici yalnızca kendi segmentlerinden | ADR-0010, A04/A05 |
| B31 | Rol hiyerarşisi | Sistem rolleri düz başlar; Admin bir rolü diğerinin altına koyabilir (`PUT /v1/roles/{id}/parent`). Üst rol, alt rol sahiplerinin kayıtlarını okur/düzenler/arşivler (rolün o eylem izni varsa) | ADR-0004 §1 |
| B32 | Ekip listesi | Ekip yapısı tüm üyelerce okunabilir (paylaşım seçicileri için); değiştirme `teams.manage` / `teams.members.manage` | permission-matrix.yaml A06 |
| B33 | Yerel/test S3 | MinIO topluluk imajları artık herkese açık çekilemiyor; geliştirme ve testte S3 uyumlu **SeaweedFS** (`chrislusf/seaweedfs:3.80`). Üretimde herhangi bir S3 uyumlu depo (`S3_*` ortam değişkenleri) | ADR-0013 §2 |
| B34 | Mention geri çekme | Kaldırılan mention'ın **okunmamış** bildirimi silinir (okunmuşlar geçmiş olarak kalır); yeniden anılırsa yeniden bildirilir | ADR-0017 §2.5 |
| B35 | Delegasyon süresi | Yetki, süre dolduğu an bir sonraki istekte kalkar (`valid_until`); süre dolumunun ayrı audit satırı P5 zamanlanmış işiyle yazılır | A07, SCN-18 |
| B36 | Matris düzenleme | Tenant'a özel değişiklik yalnızca sistem rollerinin hücrelerinde; değer gönderilen sürüme eşitse override silinir (matris en küçük farkla kalır); geri alma yeni sürüm olarak kaydedilir (geçmiş yeniden yazılmaz) | A03, AUTH-11 |
| B37 | Otomasyon tüketicisinin yeri | Kural aksiyonları alan servislerini (doğrulama, yetki, timeline) kullandığından tüketici API imajında ayrı bir süreçte (`automation` servisi, `EVENT_CONSUMERS=true`); relay worker'da (`flexa_relay`) | ADR-0006 |
| B38 | Kuralın kimliği | Kural son kaydeden Admin'in **güncel** yetkisiyle çalışır; yetki düşerse çalıştırma `failed`/DLQ olur ve loglanır | docs/p5-plan.md §2 |
| B39 | Döngü koruması | Derinlik > 5 → `halted_depth`; aynı zincirde aynı kural aynı kayda ikinci kez → `halted_loop` (genelde derinlikten önce keser) | ADR-0006 §3 |
| B40 | Otomasyon e-postası | Kuyruğa commit'ten sonra deterministik iş kimliğiyle; yeniden teslimde aynı iş yeniden eklenir, kuyruk yinelenmeyi düşürür (en az bir kez, çift gönderim yok) | ADR-0006 §2 |
| B41 | SLA ilk yanıt | İlk durum geçişi (kullanıcı/otomasyon), kayda kullanıcı yorumu ya da e-posta/arama logu ilk yanıttır; `closed` kategorisi çözümdür. Yeni kayda ilk eşleşen (sıraya göre) tek politika uygulanır | ADR-0020 not |
| B42 | SLA takvim değişikliği | Takvim değişince çalışan saatlerin hesaplanmış hedefleri değişmez; yeni saatler yeni takvimle başlar (geçmiş taahhüt yeniden yazılmaz) | ADR-0020 |
| B43 | Webhook otomatik kapatma | 24 saat kesintisiz başarısızlık (ilk başarısızlıktan bu yana hiç başarı yok) → abonelik kapanır, Admin'ler bildirim alır; tek başarı sayacı sıfırlar | ADR-0013 not |
| B44 | Idempotency-Key deposu | DB tablosu yerine Redis (24 saat TTL); ADR-0012'nin depolama kısmını değiştirir | ADR-0023 |
| B45 | API anahtarı yetkisi | Anahtar oluşturanın güncel yetkisi ∩ anahtar kapsamı; anahtarla anahtar/matris/rol yönetimi yok; oluşturma ve iptal `tenant.config.manage` | ADR-0023 |
| B46 | SSE yeniden oynatma | Son 72 saat ve en çok 500 olay; ötesi `resync.required` | ADR-0007 not |
| B47 | E-posta özeti | 10 dakikadan eski okunmamış bildirimler, 5 dakikada bir, yalnızca `email` kanalını seçen kullanıcılara; bildirim başına en çok bir e-posta | ADR-0017 not |
