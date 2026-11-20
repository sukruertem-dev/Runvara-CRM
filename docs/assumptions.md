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
| B21 | Flexa logosu | Resmi çizim verilene kadar yalnızca yazı markası; sembol uydurulmadı | docs/brand.md §2 |
| B22 | RQL ayrıntıları | Tırnaksız kelime metin değeri sayılır; `today()`/tarih değeri datetime alanında tüm yerel gün; boş `myTeams()` hiçbir şeyle eşleşmez; liste uç noktasında `ORDER BY` yerine `sort` parametresi | packages/query-lang |
| B23 | Görev yetki kapsamı (P2) | `own` = sahip, atanan veya oluşturan; ekip/kuyruk kapsamı P4'e kadar `own`'a daraltılır (fail-closed); başkasına görev vermek `reassign` (yalnızca Admin) | ADR-0004, docs/p2-plan.md §6 |

## C. Toplu soru (tek seferde; yanıt gelene kadar varsayılanlarla devam edilir)

> **Q1 – Data Servisi:** "Data Servisi"ni, santralin/IVR'ın gelen aramada müşteriyi tanımak için çağırdığı güvenli arama (lookup), çağrı olaylarını/CDR'ı içeri alma ve arama listesi dışa aktarma servisi olarak yorumladım. Doğru mu, yoksa farklı bir şey mi kastedildi (ör. harici veri sağlayıcıdan müşteri verisi zenginleştirme)?
>
> **Q2 – İlk santral:** Kullandığınız veya hedeflediğiniz santral/çağrı merkezi sağlayıcısı hangisi? (Varsayılan: Asterisk + genel webhook; Netgsm/Verimor/3CX/Twilio/Genesys'ten biri öncelikliyse G7'de ilk adaptör o olur.)
>
> **Q3 – Kod deposu ve CI:** ✅ Yanıtlandı (2026-11-20): https://github.com/sukruertem-dev/Runvara-CRM (private), CI PR #1'de yeşil. Önceki soru: GitHub'da bir depo açıp bu yerel depoyu oraya bağlayalım mı? (CI kabul kriterleri GitHub Actions gerektiriyor.)
>
> **Q4 – Palet düzeltmesi:** Koyu temadaki marka kırmızısını erişilebilirlik için `#FF5A5F` → `#FF6B70` yapmayı ve yeni `--border-strong` token'ını eklemeyi onaylıyor musunuz?
>
> **Q5 – Faz sırası:** `docs/phase-plan.md`'deki bütünleşik sırayı (önce temel + yetki, sonra arayüz kabuğu, ardından satış/çağrı modülleri) onaylıyor musunuz? Satış mı, çağrı merkezi mi önce gelmeli?
