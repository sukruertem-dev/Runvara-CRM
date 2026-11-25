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
| B48 | Kişi rehberi | `GET /v1/directory/users` her üyeye açık; yalnızca etkin üyelerin kimliği ve görünen adı (e-posta, rol, segment yok). Atanan seçici ve ad gösterimi içindir | p6-plan §2 |
| B49 | WIP limiti | Durum başına isteğe bağlı yumuşak sınır (`statuses.wip_limit`); aşılınca Kanban uyarır, taşıma engellenmez | p6-plan §4 |
| B50 | Arayüz yetenekleri | `/v1/me/navigation.capabilities` yalnızca arayüzde gizleme içindir; her istek yine API'de yetkilendirilir. Görev yetenekleri kayıt kapsamından (`*record*` × `core.task`) hesaplanır | p6-plan §2 |
| B51 | Kayıtlı arayüz tercihleri | Tema, yoğunluk, segment seçimi, menü daraltma, tablo sütunları ve son görüntülenenler tarayıcıda (`localStorage`) tutulur; sunucu tarafı kullanıcı tercihleri P7 yapılandırma motoruyla gelir | ADR-0024 |
| B52 | Refresh rotasyonu ve yarıda kalan yanıt | Tam sayfa yüklemesi refresh çerezini döndürür; yanıt tarayıcıya ulaşmadan sayfadan çıkılırsa (≈100 ms pencere) bir sonraki yenileme eski belirteci sunar ve ADR-0009 gereği oturum kapanır. Karar (kullanıcı "en iyi kararı ver" dedi): 30 sn tanıma; halef hiç kullanılmamışsa ve sunulan belirteç tanımayla tüketilmemişse yeni belirteç verilir, aksi halde aile iptal edilir. Tespit korunur, en fazla bir adım gecikir | ADR-0009 not |
| B53 | Çalışma alanı görünümleri | Herkes kişisel görünüm kaydedebilir; çalışma alanı görünümü yayımlamak `tenant.config.manage` ister. Görünüm yalnızca süzgeç tanımıdır; açan kişi yine yalnızca okuyabildiği kayıtları görür | p6-plan §7 |
| B54 | Toplama uç noktası | En çok 200 grup. Gruplama ve toplama yalnızca liste kayıt defterindeki alanlarla yapılır; gizli alanla yapılamaz. Tutar toplamı para birimini dönüştürmez; pipeline ve huni tenant para birimiyle gösterilir, kur dönüşümü P9'da | p6-plan §7 |
| B55 | Takvim ve Gantt tarihleri | Takvim bitiş tarihine göre gösterir; taşımada saat korunur. Gantt çubuğu başlangıç → bitiş; biri eksikse tek gün. Kritik yol bağımlılık zincirinin gün cinsinden en uzunudur (takvim tatilleri hesaba katılmaz) | p6-plan §7 |
| B56 | SLA özeti | `GET /v1/sla/summary` kaydın en kötü saat durumunu sayar (ihlal > çalışıyor > duraklatıldı > karşılandı) ve yalnızca çağıranın okuyabildiği kayıtları içerir | p6-plan §7 |
| B57 | Workflow düzenleme | Yerinde düzenleme, kayıt başına sürüm yok; kaldırılan durumdaki kayıtlar eşlemeyle taşınır, kayıt başına zaman çizelgesi olayı üretilmez (yapılandırma göçü, audit'te sayımlar). Durum anahtarı değişmez | ADR-0026 |
| B58 | Özel alan düzenleme | Anahtar, tür, ilişki hedefi ve formül sabit; kullanılan seçenek kaldırılamaz; arşivden çıkarılan formül alanı döngü denetiminden yeniden geçer (formüller değişmez olduğundan döngü bugün oluşamaz; denetim savunma amaçlıdır) | p6-plan §9 |
| B59 | Lighthouse ölçümü | Mobil profil, simüle yavaşlatma, oturum açık; CI'da tek koşu (yerelde `LH_RUNS=3` ile medyan). Paylaşılan CI makinesinde puan oynayabilir; eşik altı sonuç işi düşürür | p6-plan §9 |
| B60 | Ekran görüntüsü temeli | Temel görüntüler yalnızca sabit Playwright Linux imajında üretilir; piksel farkı eşiği %1. Veri sabit adlarla tohumlanır (tenant "Atlas Lojistik") | p6-plan §9 |
| B61 | Tenant logosu | Logo veritabanında (`tenant_assets`, ≤ 512 KB): PNG/WebP imza denetimiyle, SVG izin listesiyle yeniden yazılarak. Eski logolar sürüm geçmişi geri alınabilsin diye tutulur; tenant silinince birlikte gider (P7c) | ADR-0011 §4 |
| B62 | Marka rengi reddi | Açık temada açıklığın 0,30'dan fazla değişmesi gerekiyorsa renk "başka bir renk" sayılır ve 422 `BRAND_CONTRAST_UNSATISFIABLE` ile reddedilir (ör. saf sarı). Koyu temadaki metin tonu bu sınıra tabi değildir (lacivert gibi koyu markalar açılarak kullanılabilir) | ADR-0011 §4 |
| B63 | Yerel saat ve tarih | `locale` ayarı arayüz dilini, gösterilen zaman damgalarının saat dilimini, sayısal tarih sırasını, 12/24 saati ve takvimin hafta başlangıcını belirler. Takvim ızgarası ve tarih seçici gün sınırlarını cihazın saat diliminde hesaplar; sunucu tarafı hesaplar (SLA, görece RQL tarihleri) tenant saat dilimini kullanır | p7-plan §4 |
| B64 | Kullanıcı tercihlerinin taşınması | P7 öncesi yalnızca tarayıcıda tutulan tema/yoğunluk seçimi (B51), kullanıcının sunucuda geçersiz kılması yoksa ilk girişte bir kez kullanıcı katmanına yazılır; sonrasında sunucu değeri geçerlidir | p7-plan §4 |
| B65 | Göç sağlama toplamı | Göç dosyasının sağlama toplamı LF satır sonuyla hesaplanır; Windows (CRLF) ve Linux (LF) çalışma kopyaları aynı göçü değişmiş saymaz. Kural öncesi yazılmış satırlar ham dosyanın toplamıyla da eşleşir | packages/db/src/migrate.ts |
| B66 | Onboarding zorunlu değil | Yeni tenant `onboarding: pending` ile doğar; Admin ana sayfada "Kurulumu tamamla" kartını görür. Kart atlanabilir ve sihirbaz zorla açılmaz (davetle gelen kullanıcılar ve API istemcileri etkilenmez). P7b öncesi tenant'lar için platform varsayılanı `completed`'dır. Onboarding bir kez uygulanır; sonrası Ayarlar'dan yapılır | p7-plan §8 |
| B67 | Yapılandırma paketinin kapsamı | Paket `flexa.config/1`: satış modu, modüller, taşınabilir ayarlar, özel alanlar, görev akışları, takvimler, SLA politikaları, etiketler, kuyruklar. Taşınmayanlar: CRM süreçleri ve pipeline'lar (her tenant'ta tohumlu; düzenleyici P8), otomasyon kuralları (bir kullanıcı adına çalışır), roller ve matris, gizli değerler, logo (`brand.logoAssetId` yerel kalır). İçe aktarma yalnızca ekler veya günceller, hiçbir şeyi silmez | p7-plan §7 |
| B68 | Çakışma kuralı | Ayarlar sürümlü ve geri alınabilir olduğundan farklı değer `update` sayılır. Diğer tanımlarda aynı doğal anahtarla farklı tanım `conflict` olur ve `keep` ile mevcut tanım korunur; üzerine yazma yoktur (kayıtların kullandığı durum veya seçenekleri bozmamak için). Plan dışı modül, eksik bağımlılık, eksik takvim ve geçersiz öğe her zaman engeller (409 `IMPORT_CONFLICTS`). Onboarding `keep` ile uygulanır | p7-plan §7 |
| B69 | Planlar | Planlar kodda (`packages/modules/src/plans.json`): `trial` (14 gün, kurumsal modül kademesi, küçük sınırlar), `starter`, `growth`, `enterprise`. Yeni tenant `trial` ile açılır; P7b öncesi tenant'lar `enterprise` alır (davranış değişmez). Ek modül (`addOn: true`) her planda satın alınabilir. Plan değişikliği ve deneme bitişindeki geçiş P7c operatör konsolundadır; plan düşürmek açık modülü kapatmaz, yalnızca yeni açmayı engeller | p7-plan §9 |
| B70 | Kota ölçümü | Kullanıcı = etkin üye + bekleyen davet; depolama = silinmemiş ekler (yükleme süren dahil) + logolar; kayıt = silinmemiş müşteri, kişi, aday, fırsat, vaka, görev. Arama dakikası ve AI token'ı takvim ayı (UTC) bazındadır. Kayıt sayımı uyarı eşiğinin altında 60 sn önbelleğe güvenir, üstünde her oluşturmada tam sayar. Eşik duyurusu ay başına bir kez; ölçüm sıçrarsa yalnızca en yüksek yeni eşik e-postalanır | p7-plan §9 |
| B71 | Hız sınırı | Tenant ve kullanıcı (API anahtarında anahtar) başına token bucket; dolu kova bir dakikalık bütçe kadar ani isteğe izin verir. Redis saatini kullanır. `TENANT_RATE_LIMIT_MULTIPLIER` tüm planların hızını ölçekleyen işletim ayarıdır (varsayılan 1; testler 100). Olay kuyruğu `EVENT_SHARDS` parçaya bölünür; parça sayısı yalnızca kuyruklar boşaltıldıktan sonra değiştirilir | p7-plan §10 |
| B72 | Operatör konsolu yeri | B16'nın yerine: ayrı uygulama (`apps/operator`) yerine `apps/web` içinde ayrı alan (`/operator`), kendi düzeniyle. Tasarım sistemi ve derleme ortak kalır. Ayrım API'de: operatör uç noktaları ayrı korumadan geçer (operatör işareti + ikinci faktör), tenant kabuğu operatöre hiçbir şey göstermez | p7-plan §13 |
| B73 | Crypto-shredding kapsamı | DEK imhası yalnızca DEK ile şifrelenmiş alanları (webhook ve SSO sırları) yedeklerde de okunamaz kılar. Diğer satırlar düz metindir; yedeklerden saklama süresi (35 gün) sonunda düşer. Tenant satırı `deleted` mezar taşı olarak kalır. Başka üyeliği olmayan kişiler silinmez, anonimleştirilir; başka tenant'larda kendilerine işaret eden satırlar bozulmaz | p7-plan §15 |
| B74 | Destek oturumu | Operatör tenant üyesi olmaz. Kendi oturumu süreli onaya bağlanır; bağlam Admin okuma kapsamıyla kurulur, onaylı modüllerle daraltılır, yalnızca okunur. Onay her istekte yeniden denetlenir; biten onaydan yalnızca çıkış yapılabilir. Destek oturumu destek erişimi taleplerini onaylayamaz | p7-plan §14 |
| B75 | Bekleyen silmede erişim | `pending_deletion` durumundaki çalışma alanına giriş yapılabilir (tenant listesinde görünür), ama API yalnızca durum, iptal, dışa aktarma ve kabuk yollarını açar (403 `TENANT_PENDING_DELETION`). İptal, silme talebinden önceki duruma (deneme, askı veya etkin) döndürür | p7-plan §15 |
| B76 | Politika etkisi | Güvenlik politikası oturum bir tenant'a bağlanırken (giriş, seçim, yenileme, SSO dönüşü) değerlendirilir; her istekte değil. Sıkılaştırma, açık oturumlarda en geç erişim belirtecinin ömründe (10 dk) etkili olur. Destek oturumları ve API anahtarları kapsam dışıdır | p7-plan §19 |
| B77 | Parola kuralının tenant'a uygulanması | Parola kişiye aittir, kural tenant'a. Girişte parolanın kendisi değil yalnızca uzunluğu ve karma olup olmadığı oturum satırına yazılır; tenant'a girişte kurala bu ölçüyle bakılır. Yaş `user_credentials.updated_at`'tan hesaplanır. Ölçüsü olmayan eski oturumlarda yalnızca yaş denetlenir | p7-plan §19 |
| B78 | SAML kapsamı | Yalnızca SP başlatmalı giriş (InResponseTo zorunlu); IdP başlatmalı giriş, tekli çıkış (SLO) ve şifreli assertion bu sürümde yok. İmzalı assertion zorunlu. IdP sertifikası elle girilir (metadata URL'den otomatik çekme yok) | p7-plan §20 |
| B79 | SSO ve 2FA | Varsayılan olarak SSO girişi ikinci faktör sayılır (IdP kendi MFA'sını uygular); tenant `mfa.ssoSatisfies` ile kapatabilir. "SSO zorunlu" iken Admin'ler varsayılan olarak parolayla da girebilir (IdP arızasında yönetimin kilitlenmemesi için); kapatılabilir | p7-plan §18 |
| B80 | Fiyat çözümleme | Müşteriye özel → segmente özel → genel liste; aynı düzeyde istenen para birimi, sonra en yeni başlangıç tarihi. Listede ürün ya da miktar kırılımı yoksa sonraki liste. Çevrilen birim fiyat 4 haneye yuvarlanır (satır toplamlarının yuvarlaması P9 teklifinde, ADR-0021). Kur yoksa liste atlanır | p8-plan §3 |
| B81 | Katalog kayıtları | Ürün, vergi oranı ve fiyat listesi silinmez, pasifleştirilir. Listenin para birimi, segmenti ve müşterisi oluşturulduktan sonra değişmez | p8-plan §1 |
| B82 | Müşteriye özel liste | Müşteri kaydını okuyamayana görünmez; müşteriler birleştirilince liste kalan müşteriye taşınır | p8-plan §2 |
| B83 | Birincil ekip | İlk ekip birincildir; ayrılınca kalan en eski ekip. Yönetici yalnızca, eski ve yeni birincil ekibin ikisini de yönetiyorsa değiştirebilir | p8-plan §4 |
| B84 | Kendi yetkisi içindeki talep | Onaysız sınır, yöneticinin kendi limiti ya da Admin: talep anında onaylı ve 'otomatik' kaydedilir; kimse kendi talebine karar vermez | p8-plan §7 |
| B85 | Onay kurallarının yeri | Kurallar `approvals` ayar anahtarında (varsayılan: onaysız %8, yönetici %15, 24 saat); ADR-0021 tablosu yerine | p8-plan §8, ADR-0021 |
| B86 | Hedef gerçekleşmesi | Kazanılan = kapalı aşama ve olasılık > 0, kapanış tarihi dönem içinde, sahibi sayılır; görev atanana, yoksa sahibine. Para birimi farklı tutar toplanmaz, sayısı gösterilir. Segment yetkisi dışındaki kayıt sayılmaz | p8-plan §10 |
| B87 | Riskli hedef | Dönemin %25'i geçmiş ve gerçekleşme < geçen süre × 0,75; hedef başına bir bildirim (hedef değişirse yeniden) | p8-plan §10 |
| B88 | Yetki talepleri | P4b akışı korunur (Admin ya da yöneten Yönetici); onay motoruna taşınmaz | p8-plan §7 |
| B89 | Anınca erişim ver | Yalnızca doğrudan kişi anmasında ve kaydı paylaşabilen (düzenleyebilen) kişi için; okuma paylaşımı, segment dışına verilmez. Anma kaldırılınca paylaşım kalır, elle kaldırılır. Otomasyon erişim vermez | p8-plan §14 |
| B90 | Anma sınırları | Dakikada 30 anma (ekip tek sayılır), ekip en çok 100 kişi | p8-plan §14 |
| B91 | Seçici taraması | İstek başına ada uyan en çok 60 üye denetlenir, ilk 8 uygun kişi döner; daha fazlası için arama daraltılır | p8-plan §15 |
| B92 | Kapsam sırası kayıt predicate'inde | `team` ve `queue` kapsamı kişinin kendi kayıtlarını (sahibi, oluşturanı, görevde atananı veya iş kuyruğu) her eylemde kapsar: Yönetici, ekibi dışından kendisine atanan görevi okur, düzenler ve arşivleyebilir. Yeniden atama hedefleri değişmez (ekip üyeleri / kendi kuyrukları) | ADR-0004 §2 notu |
| B93 | Sessiz saatte push | Gönderilmez ve sonradan da gönderilmez (bildirim uygulamada bekler); e-posta sessiz saat bitince gider | p8-plan §17 |
| B94 | E-posta yedeği | Kişinin açık akışı (çevrimiçi işareti) varken gönderilmez | p8-plan §17 |
| B95 | Teslim ölçümü | İstemci onayı %10 örneklenir; satırlar 30 gün saklanır, kayıt ya da içerik taşımaz | p8-plan §19 |
| B96 | P9 sırası (Q5) | Kullanıcı kararı 2026-11-25: önce B2B (P9a–P9c), sonra B2C (P9d–P9f) | p9-plan |
| B97 | Teklif yetkisi | Fırsattan türer: fırsatı (paylaşımla da olsa) düzenleyebilen ve teklif izni olan kişi teklifini de düzenler; fırsat tutarı gizliyse teklif görünmez | p9-plan §2 |
| B98 | Onay oranı | En yüksek satır iskontosu esas alınır (toplam ortalaması değil), tamamlama anındaki liste fiyatına göre. Liste fiyatı olmayan üründe girilen fiyat kendi referansıdır | p9-plan §4 |
| B99 | Kabul edilen teklif | Fırsatın tutarını ve aşamasını kendiliğinden değiştirmez (sözleşme/sipariş P9b) | p9-plan §4 |
