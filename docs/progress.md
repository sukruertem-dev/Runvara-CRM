# İlerleme

## P7b — G1: blueprint'ler, dışa/içe aktarma, onboarding, plan/kota, gürültülü komşu · 2026-11-23 · ✅ (CI PR'da çalışacak)

> P7'nin ikinci adımı (`docs/p7-plan.md` §7–12). Sıradaki: **P7c** SAML ve güvenlik politikaları, operatör konsolu ve destek erişimi, tenant dışa aktarma/silme.

### Yapılanlar
- **Yapılandırma paketi `flexa.config/1`** (`packages/contracts` `ConfigBundle`):
  - İçerik: satış modu, modüller, taşınabilir ayarlar, özel alanlar, görev akışları, takvimler, SLA politikaları, etiketler, kuyruklar. Eşleme doğal anahtarla yapılır, UUID taşınmaz (B67).
  - Saf planlayıcı (`bundle-plan.ts`) her öğe için `create`/`update`/`unchanged`/`conflict` döner. Ayar farkı `update`, diğer tanımlarda farklı tanım `conflict`tır.
  - Plan dışı modül, eksik bağımlılık, eksik takvim ve geçersiz öğe engelleyicidir (B68).
- **İçe aktarma:**
  - Tek transaction ve tenant kilidi. Plan transaction içinde yeniden hesaplanır.
  - `onConflict: fail | keep`. Engelleyici çakışma ya da `fail` ile çakışma varsa 409 `IMPORT_CONFLICTS` döner ve hiçbir şey yazılmaz.
  - Ayarlar P7a motorundan geçer (sürüm, audit, olay). Diğer öğeler mevcut ayar API'lerinin doğrulamasını paylaşır: özel alan ve görev akışı oluşturma `config-defs.ts`'e, takvim ve politika oluşturma SLA servisinin transaction düzeyi metotlarına taşındı.
  - Tek audit kaydı: `config.imported`.
- **Blueprint'ler** (`packages/config/src/blueprints/`): Kurumsal B2B, Perakende B2C, Telesatış/Çağrı Merkezi. API açılışta şemayla doğrular.
- **Onboarding** (B66): yeni tenant `pending` ile doğar. Ana sayfada Admin kartı; sihirbaz `/onboarding` (şablon → satış modu → modüller → kuru çalıştırma özeti → tek transaction); atlanabilir, bir kez uygulanır.
- **Plan ve modül hakkı** (B69): `plans.json` (`trial`, `starter`, `growth`, `enterprise`) ve `tenant_plans`. Plan dışı modül 402 `MODULE_NOT_IN_PLAN`; ek modül satın alındıysa açılır. Modül listesi her modülün hak durumunu döndürür.
- **Kota** (B70):
  - Kullanıcı, depolama, kayıt, arama dakikası ve AI token'ı ölçülür.
  - %80 uyarı. %100'de davet ve yükleme 402 `QUOTA_EXCEEDED` alır. %120'de kayıt oluşturma durur. Okuma ve dışa aktarma engellenmez.
  - Eşikler ay başına bir kez duyurulur: audit + `quota.threshold` olayı + Admin e-postası.
  - API istekleri Redis'te sayılır ve dakikada bir `tenant_usage_counters`'a aktarılır. Anlık değerler saatte bir yazılır.
- **Gürültülü komşu** (B71):
  - Tenant ve kullanıcı başına token bucket (Redis Lua, atomik; 429 + `Retry-After`).
  - Olay kuyruğu tenant'a göre parçalara bölündü (`events-<n>`). Parça içinde tenant başına kiralı eşzamanlılık semaforu; dolu ise iş deneme sayılmadan gecikmeyle sıraya döner.
- **Satış modu** uç noktası (`PUT /v1/tenant/sales-mode`, `tenant.sales_mode.manage`).
- **Göç** `0012_plans.sql`: `tenant_plans`, `tenant_usage_counters`, `tenant_quota_alerts`, `app.live_tenant_ids()`. Mevcut tenant'lara `enterprise` atanır.
- **Ekranlar:**
  - **Modüller:** tasarım sistemine taşındı. Katalog kartları, plan/ek modül rozeti, bağımlılık uyarısı, zincirleme kapatma onayı, satış modu.
  - **Kullanım ve plan:** plan, deneme bitişi, ek modüller, hız sınırları, boyut ölçerleri, 30 günlük API grafiği.
  - **İçe/dışa aktarma:** JSON indirme; dosya → kuru çalıştırma tablosu → çakışma politikası → not → uygula; blueprint önizleme ve uygulama.
  - **Onboarding sihirbazı**, ana sayfa kartı ve Admin'e kota uyarı şeridi.
- **İşletim:** `docs/ops/automation-dlq.md` belgesine parça/adalet ve kullanım sayaçları eklendi (`EVENT_SHARDS` değişikliği yalnızca kuyruklar boşaltılınca yapılır).

### Testler
- Birim: planlar ve modül hakkı 4, paket planlayıcı ve blueprint'ler 10, olay parçaları 2. Tüm depo: lint, typecheck, birim 55/55 görev.
- API entegrasyon 124/124. Yeni `plans.int.test.ts` 13 test:
  - üç blueprint de uygulanıyor; ikinci kuru çalıştırma "aynı";
  - onboarding bir kez; atlama;
  - A'dan dışa aktar, B'ye içe aktar: çakışma `fail` ile reddediliyor, `keep` ile korunuyor; B'nin dışa aktarması A'nınkine eşit;
  - engelleyici çakışmalar;
  - Yönetici ve Satış yetkisi;
  - `MODULE_NOT_IN_PLAN` ve ek modül;
  - satış modu;
  - kota: davet %100, kayıt %120, eşik başına tek duyuru, Admin e-postası;
  - ölçüm ve aktarım;
  - tenant ve kullanıcı hız sınırı;
  - tenant semaforu;
  - ağır tenant aynı parçadaki hafif tenant'ı bekletmiyor.
- DB sızıntı testi yeni tabloları tohumluyor.
- E2E `platform.spec.ts` 3 senaryo (onboarding; modüller + kullanım + Yönetici salt okuma; dışa → içe aktarma, kuru çalıştırma ve korunan çakışma; axe her ekranda).
- Görsel regresyon: iş akışı düzenleyicisi temelleri ayarlar menüsü değiştiği için yenilendi; diğer temeller onboarding'i atlayarak aynı kaldı.
- Bulunup düzeltilenler:
  - E2E, onboarding sihirbazının tamamlanınca söküldüğünü yakaladı. Söküldüğü için bildirim ve yönlendirme çalışmıyordu; sihirbaz artık sonucu bekliyor.
  - Docker bellek baskısında Postgres bağlantıyı koparınca `pg` istemcisinin işlenmeyen `error` olayı API'yi çökertiyordu. Havuz ve istemci dinleyicileri eklendi; yeni bir DB testi bağlantıyı işlem içinde ve boştayken koparıyor (DB 19/19).
- E2E `platform.spec.ts`: 3/3 (geliştirme sunucusuna karşı). Görsel 4/4.
- Kontrast, matris ve katalog denetimleri PASS.

## P7a — G1: yapılandırma motoru, yerelleştirme, marka, kullanıcı tercihleri · 2026-11-23 · ✅ (CI PR'da çalışacak)

> P7 üç adıma bölündü (`docs/p7-plan.md`): **P7a** yapılandırma motoru + yerelleştirme + marka + tercihler (bu adım), **P7b** blueprint'ler, dışa/içe aktarma, onboarding, plan/kota, gürültülü komşu, **P7c** SAML ve güvenlik politikaları, operatör konsolu, tenant dışa aktarma/silme.

### Yapılanlar
- **Yapılandırma motoru** (`packages/config`):
  - Anahtar kayıt defteri: JSON Schema 2020-12 (Ajv, strict), platform varsayılanı, izin verilen katmanlar, sahip modül, şema sürümü ve yükseltme adımları. Kayıtsız anahtar 404 `CONFIG_KEY_UNKNOWN`.
  - İlk anahtarlar: `locale`, `currency`, `brand`, `ui`, `notifications.defaults`.
  - Katmanlar platform → tenant → (ekip) → kullanıcı. Nesneler derin birleşir, diziler tümüyle değişir. İzin verilmeyen katman 422 `CONFIG_KEY_NOT_OVERRIDABLE`.
  - RFC 6902 JSON Patch diff.
  - Marka türetmesi: OKLCH'de her tema için beş vurgu token'ı. Kontroller `tokens.json`'dan üretilir (`tenantAccent`). Sağlanamazsa 422 `BRAND_CONTRAST_UNSATISFIABLE`.
- **API:**
  - `GET /v1/config`, `/keys`, `/{key}`; `PUT` (If-Match, ilk yazım `0`); `DELETE` (kendi geçersiz kılması); `/preview`, `/history`, `/revert`.
  - `POST`/`GET /v1/brand/logo`.
  - Her yazım değişmez bir sürüm satırı, audit ve değer içermeyen `config.changed` olayı (SSE: tenant katmanı herkese, kullanıcı katmanı yalnızca sahibine) üretir.
  - `locale`/`currency` tenant satırına da yazılır.
  - Tenant bildirim varsayılanları, kendi tercihi olmayan kullanıcılara uygulanır (uygulama içi ve e-posta özeti).
- **Göç** `0011_config.sql`: `tenant_settings` (yalnızca eklenir), `tenant_settings_head`, `tenant_assets`, `app.default_channels()`.
- **Logo:** PNG/WebP imza denetimi. SVG izin listesiyle yeniden yazılır: script, foreignObject, style, olay öznitelikleri, dış ve `javascript:` referansları atılır; DOCTYPE/ENTITY/CDATA reddedilir. Sandbox CSP ile sunulur.
- **Ekranlar:**
  - **Genel:** dil, saat dilimi, tarih/saat biçimi, hafta başlangıcı, para birimi, varsayılan tema/yoğunluk, bildirim varsayılanları.
  - **Marka:** renk seçici, seçilen ve düzeltilmiş renk, açık/koyu canlı örnek, kontrast tablosu, logo.
  - **Yapılandırma geçmişi:** sürümler, diff, nedenli geri alma.
  - **Tercihlerim:** her alan için "çalışma alanı varsayılanı".
  - Her değişiklik sunucu önizlemesi + not ile uygulanır. Yönetici salt okur.
- **Web:**
  - Etkin yapılandırma arayüz dilini, zaman damgası saat dilimini, sayısal tarih sırasını, 12/24 saati, hafta başlangıcını ve sayı biçimini belirler.
  - Tenant vurgu renkleri CSS değişkeni olarak uygulanır ve önbelleklenir; giriş sayfaları Flexa renkleriyle kalır.
  - Tema/yoğunluk seçimi kullanıcı katmanına yazılır (B51 → B64).
  - Kenar çubuğunda tenant logosu.
- **Düzeltme:** göç sağlama toplamı satır sonundan bağımsız (B65). Windows çalışma kopyası eski göçleri "değişmiş" sayıyordu.

### Testler
- Birim: `packages/config` 17 (renk, türetme, kayıt defteri, birleştirme, diff). SVG temizleyici 6.
- API entegrasyon 111/111, DB 18/18. Yeni: `config.int.test.ts` 7 (şema reddi, 428/412, diff, geri alma, audit/olay, katmanlar, bildirim varsayılanları, marka, logo, yetki, tenant izolasyonu).
- E2E `config.spec.ts` 3 senaryo (genel + geçmiş + geri alma, marka reddi/düzeltme + logo, tercihler + Yönetici salt okuma; axe her ekranda).
  - Bu makinede geliştirme sunucusuna karşı her senaryo en az bir kez geçti.
  - Makine aşırı yüklüyken aynı turda hepsi birlikte geçmedi (API yanıtları 2–11 sn). CI üretim imajlarında koşar.
- Lint, typecheck, birim testleri ve kontrast/matris/katalog denetimleri geçti.

### Kalan
- **P7b:** blueprint'ler, yapılandırma dışa/içe aktarma, onboarding, plan/kota/kullanım, plan hakkı (MOD-04), gürültülü komşu.
- **P7c:** SAML, güvenlik politikaları, operatör konsolu ve destek erişimi, tenant dışa aktarma/silme, sızıntı paketinin genişletilmesi.

## P6c — Faz 6: ayar ekranları, Lighthouse, ekran görüntüsü regresyonu · 2026-11-22 · ✅ (CI PR'da çalışacak)

### Yapılanlar
- **API:**
  - Workflow düzenleme: `POST /v1/workflows/{id}/preview` (kuru çalıştırma) ve `PUT /v1/workflows/{id}` (If-Match). Kaldırılan durumdaki kayıtlar eşlemeyle taşınır; eşleme yoksa 409 `WORKFLOW_STATUS_IN_USE`. Durum anahtarları değişmez. ADR-0026, ADR-0019'u kısmen değiştirir.
  - Özel alan: `PATCH /v1/custom-fields/{id}` (etiket, zorunluluk, seçenekler, sıra) ve `POST …/restore`. Kullanılan seçenek silinemez (409 `CUSTOM_FIELD_OPTION_IN_USE`).
  - `PATCH /v1/sla/policies/{id}`.
  - Göç `0010_settings.sql` (sürüm sütunları). Arayüz yeteneği `authz.matrix.edit`.
- **Ayarlar alanı** (`/settings`): yetkiye ve modüle duyarlı alt menü. Okuyabilen ama değiştiremeyen kullanıcı salt okuma görünümü alır.
- **İş akışı editörü:**
  - Durum diyagramı: kategori sütunları, eğri oklar, "her durumdan" geçişleri.
  - Klavyeyle düzenlenen durum ve geçiş listeleri; koşul, doğrulayıcı ve son işlemler.
  - Motor kuralları canlı uyarı olarak gösterilir. Kaydederken kuru çalıştırma ve gerekiyorsa eşleme iletişim kutusu.
- **Diğer ayar ekranları:**
  - **Özel alan yöneticisi.**
  - **Rol/izin matrisi:** önizleme, not, sürüm geçmişi ve eski sürüme dönüş.
  - **Otomasyon kural oluşturucu:** ne zaman → hangi kayıtlarda → ne yapılsın. Koşul RQL filtre çubuğuyla yazılır; çalıştırma günlüğü görünür.
  - **Webhook ve API anahtarı:** gizli değerler bir kez gösterilir; teslimat geçmişi, yeniden gönderme, iptal.
  - **SLA politikası ve çalışma takvimi:** gün başına birden çok aralık, tatiller.
- **Performans:**
  - `@flexa/ui` yan etkisiz işaretlendi ve `optimizePackageImports` açıldı.
  - Komut paleti, yeni görev formu ve kısayol yardımı ilk açılışta yükleniyor.
  - Kanban, takvim, Gantt, tablo ve pipeline seçildiklerinde yükleniyor.
  - Oturum açık sayfalarda ilk yük ~400 kB'den ~225 kB'ye indi.
- **CI'a eklenenler:**
  - Lighthouse: `pnpm --filter @flexa/web lighthouse`.
  - Ekran görüntüsü regresyonu: `pnpm --filter @flexa/web e2e:visual`. Sabit Playwright Linux imajında 16 temel görüntüyle çalışır.

### Kabul kriterleri (P6c ve Faz 6)
`docs/p6-plan.md` §10 tablosundaki tüm satırlar ✅. Bununla Faz 6'nın bütün kabul kriterleri karşılandı.

Lighthouse sonuçları (CI #29, mobil profil, 3 koşu medyanı); erişilebilirlik hepsinde 100:

| Sayfa | Performans |
|---|---|
| `/` | 92 |
| `/tasks` | 97 |
| `/crm` | 98 |
| `/settings/workflows` | 100 |
| `/login` | 100 |

### Testler
- API entegrasyon **104/104** (+4: `settings.int.test.ts`).
- DB 18/18.
- **E2E 19/19** (+6: `settings.spec.ts`, axe dahil).
- Görsel regresyon 16/16.
- Birim testleri, lint ve typecheck temiz; Storybook derleniyor; kontrast, matris ve katalog kontrolleri PASS.

### CI'da bulunan ve düzeltilenler
- **E2E hız sınırı:** bütün E2E trafiği tek IP'den geldiği için giriş uçlarının IP başına 20/dk sınırına takılıyordu. Compose sınırları ortam değişkeninden alıyor (varsayılanlar aynı); CI E2E yığını yüksek sınırla başlıyor, E2E yardımcısı 429'da `Retry-After` kadar bekliyor.
- **Filtre çubuğu (P6b):** öneri seçildikten sonra hızlı yazımda imleç geride kalıyordu; Enter doğrulanmamış sorguyu uygulayabiliyordu. İmleç artık çizimle eşzamanlı ayarlanıyor, Enter ve Uygula önce doğruluyor.
- **Klavyeyle sürükle-bırak:** Kanban, takvim ve pipeline'da bırakma alanları sürüklemeden önce ölçülüyor; kaldırır kaldırmaz basılan ok tuşu artık kaybolmuyor.
- **Kararsız testler:** 100 bin kenarlı döngü kontrolünün süre ölçümü ayrı CI adımında; 2FA testi kodu yeniden üretmek yerine aynı kodu kullanıyor.
- **Gösterge paneli performansı (CI'da 88–89):** sürükle-bırak yalnızca düzenleme kipinde yükleniyor; oturum açılışındaki ilk büyük çizim `startTransition` ile parçalara bölünüyor.
- Lighthouse sonuçları CI'da annotation olarak yazılıyor; günlüklere girmeden okunabiliyor.

### Notlar
- Bu makinede Lighthouse puanı Docker yükü yüzünden koşudan koşuya oynuyor; giriş sayfası tek koşuda 80 ile 99 arasında ölçüldü. CI bu yüzden 3 koşunun medyanını alıyor (B59).
- Ekran görüntüsü temelleri yalnızca `scripts/e2e-visual.mjs` ile üretilmeli. Windows veya macOS'ta doğrudan alınan görüntüler fontlar nedeniyle farklı çıkar.

### Sonraki adım
**P7**: yapılandırma motoru (G1'in kalanı); ayrıntı `docs/phase-plan.md`'de.

## P6b — Faz 6: görünümler · 2026-11-22 · ✅ (CI PR'da çalışacak)

### Yapılanlar
- **API:**
  - `GET /v1/{tasks|accounts|contacts|leads|opportunities|cases}/aggregate`: liste ile aynı kapsam, RQL ve maskeli alan kayıt defteri; `count` / `sum:<alan>`; tarihlerde gün/hafta/ay (B54).
  - `GET /v1/task-dependencies?ids=`: iki ucu da okunabilir kenarlar.
  - `0009_views.sql`: `saved_views` (kişisel / çalışma alanı, RLS ile yalnızca sahibi yazar) ve `user_dashboards`. `GET/POST/PATCH/DELETE /v1/views`, `GET/PUT /v1/me/dashboard`.
  - `GET /v1/sla/summary` (B56).
- **RQL filtre çubuğu:** alan, işleç ve değer önerileri; API doğrulaması ve hata konumu. **Kayıtlı görünümler:** uygula, kaydet (çalışma alanına yayımlamak `tenant.config.manage`, B53), sil, bağlantıyı kopyala; filtre URL'de, bağlantı paylaşılabilir.
- **Takvim** (ay/hafta/gün) ve **Gantt** (bağımlılık okları, kritik yol, sürükleyerek taşıma ve uzatma, klavyeyle gün kaydırma; B55).
- **CRM:** beş nesnenin listesi (sunucu sıralaması, filtre, görünümler) ve kayıt sayfası (satır içi düzenleme, açıklama, yorum, etkinlik, ilişkili kayıtlar, durum geçişi, canlı değişiklik uyarısı).
- **Pipeline** (`/crm?type=opportunity&view=pipeline`, `/sales/b2b`): aşama toplamları API'den, ağırlıklı tutar, sürükle-bırak ve klavyeyle aşama geçişi.
- **Gösterge paneli** (ana sayfa): KPI'lar, durum ve öncelik grafikleri, 14 günlük açılan/kapanan, fırsat hunisi, SLA. Düzenleme kipinde sıralama, boyutlama, ekleme ve kaldırma; yerleşim kullanıcıya kaydedilir.
- Yorum ve etkinlik paneli görev ve CRM sayfalarında ortak bileşen.
- **Bulunan ve düzeltilen:** iyimser güncellemeler önbelleği değiştirmeden önce süren sorguların iptalini bekliyordu. Yük altında Kanban taşıması 368 ms sürdü (hedef < 100 ms). Değişiklik artık aynı karede uygulanıyor, iptalden sonra yeniden uygulanıyor.

### Kabul kriterleri (P6b)
`docs/p6-plan.md` §8 tablosundaki tüm satırlar ✅: E2E `views.spec.ts` (4 senaryo, axe dahil) ve `views.int.test.ts`.

### Testler
API entegrasyon **100/100** (+4: `views.int.test.ts`, SLA özeti), DB 18/18, bileşen 11/11, **E2E 13/13** (üretim web imajına karşı), birim/lint/typecheck temiz, Storybook derleniyor, kontrast/matris/katalog PASS.

### Yerel ortam notu
API imajını Compose'da `migrate` servisi derler (`docker compose build api` hiçbir şey yapmaz). Bu makinede `0008_ui.sql`, P6a'da uygulandıktan sonra değiştiği için yerel veritabanı elle hizalandı. Temiz kurulumlar ve CI etkilenmez.

### Sonraki adım
**P6c** — ayar ekranları: workflow editörü, custom field yöneticisi, rol/izin matrisi, otomasyon kural oluşturucu, webhook ve API anahtarı, SLA ve takvim; Lighthouse ve ekran görüntüsü regresyonu CI'da.

## P6a — Faz 6: arayüz çekirdeği ve tasarım sistemi · 2026-11-21 · ✅ (CI PR'da çalışacak)

> Faz 6 üç adıma bölündü (`docs/p6-plan.md`): **P6a** tasarım sistemi + kabuk + görev görünümleri (bu adım), **P6b** takvim / Gantt / pipeline / CRM ekranları / dashboard / kayıtlı görünümler, **P6c** ayar ekranları + Lighthouse ve ekran görüntüsü regresyonu.

### Yapılanlar
- **Tasarım sistemi (`packages/ui`, ADR-0024):** `tokens.json` → `tokens.css` + Tailwind v4 teması. Varsayılan Tailwind paleti silindi, token dışı renk derlenmez. Yeni token'lar: boşluk ızgarası, açılır katman gölgesi, karartma, yerleşim, yoğunluk (Rahat/Kompakt). Bileşenler Radix tabanlı (shadcn kalıbı): Button, Input/Field, Select, Combobox, Checkbox, Switch, Tabs, SegmentedControl, Dialog/Sheet, Popover, Tooltip, DropdownMenu, Toast (geri al eylemli), Badge (segment/rol/durum/öncelik; renk + ikon + metin), Avatar, DatePicker, Skeleton, EmptyState, ErrorState, Alert, Kbd, CommandDialog, RichTextEditor (Tiptap), ModuleIcon. **Storybook 10** (tema/yoğunluk araç çubuğu, a11y eklentisi; CI'da derlenir) ve **bileşen testleri** (Vitest + Testing Library + axe).
- **Uygulama kabuğu:** tek oturum açılışı ve tek canlı akış için `(app)` düzeni (sayfa geçişinde kabuk yeniden kurulmaz). Modüle ve yetkiye duyarlı daraltılabilir yan menü; mobilde çekmece. Tenant değiştirici, segment değiştirici (yalnızca iki segmenti olana, `X-Segment` ile yalnızca daraltır), rol rozetleri, kullanıcı menüsü (tema, yoğunluk, güvenlik, çıkış). Bildirim zili ve merkezi ("Anıldım" filtresi, okunmamış kıvılcımı). Bağlantı kopması / çevrimdışı şeridi. Henüz ekranı olmayan modül menüleri için "sonraki sürümde" sayfası.
- **Komut paleti ve kısayollar:** `Ctrl/⌘+K` ve `/` palet (gezinme, eylemler, son görüntülenenler, API'den canlı görev arama); `C` yeni görev, `J/K` + `Enter` + `X` listede, `1/2/3` görünüm, `?` yardım. Açık bir katman varken sayfa kısayolları susar.
- **Görevler:** filtreler URL'de (paylaşılabilir bağlantı).
  - **Liste:** sanal kaydırma, satır içi başlık/öncelik/durum, çoklu seçim (Shift aralık), toplu eylemler + geri al.
  - **Kanban:** dnd-kit; fare, dokunma ve klavye; Türkçe ekran okuyucu duyuruları; iyimser taşıma; WIP limiti uyarısı; kulvarlar (kulvar değişince atanan/öncelik de değişir).
  - **Tablo:** sütun göster/gizle, sunucu sıralaması, gruplama, sabit ilk sütunlar, sanal satırlar.
  - **Detay:** alanlar, açıklama (Tiptap), yorumlar, etkinlik, alt görevler, bağımlılıklar. Başka kullanıcı değiştirince uyarı; `412` gelince çakışma iletişim kutusu; sil + 8 sn geri al.
- **Canlı güncelleme:** `fetch` tabanlı SSE istemcisi; `Last-Event-ID` ile yeniden bağlanma, artan bekleme, `resync.required` gelince tam tazeleme; olaylar 300 ms'de toplanıp ilgili sorguları geçersiz kılar.
- **API ekleri:** `/v1/me/navigation` artık `roles`, `segments` (switcher daraltmasından önce), `salesMode`, `capabilities` döndürüyor. `GET /v1/directory/users` (yalnızca ad, B48). `0008_ui.sql`: `statuses.wip_limit` (B49). SSE kayıt olaylarında `actor`.
- **Bulunan ve düzeltilen hatalar:**
  - **Görevler menüsü kimseye görünmüyordu (P1'den).** Menü `core.task.read` iznini `can()` ile soruyordu; görev izinleri kayıt düzeyindeki `*record*` izinleri olduğu için sonuç hep "yok"tu. Menü ve yetenekler artık kayıt kapsamından hesaplanıyor.
  - **SSE web üzerinden hiç akmıyordu (P5b).** Next.js'in `/api` vekili akışı gzip ile tamponluyordu. Akış yanıtı artık `Cache-Control: no-transform`.
  - **Parola adres çubuğuna düşebiliyordu (P1).** JavaScript yüklenmeden gönderilen formlar GET ile gidiyordu. Tüm formlar artık `method="post"`.
  - **Testlerin yakaladığı P6a hataları (birleştirmeden önce düzeltildi):**
    - Tablo görünümü bir sonraki yeniden çizimde (ör. mobil menü açılınca) sonsuz çizim döngüsüne giriyordu. Nedeni her çizimde yeni oluşturulan gruplama dizisiydi; dizi sabitlendi, genişletme otomatik sıfırlanmıyor.
    - Kanban'da klavyeyle yan sütuna taşıma, kaynak sütunda birden çok kart varken aynı sütuna düşüyordu. Çarpışma algılaması artık fareyle işaretçinin altına, klavyeyle en çok örtüşen alana bakıyor.
    - Erişilebilirlik: arama düğmesi ve kullanıcı menüsünün erişilebilir adı görünen metinle uyuşmuyordu; görünüm seçici sekme yerine radyo grubu oldu; listede geçersiz ARIA özniteliği kaldırıldı.
  - **Sayfa yüklenirken başka sayfaya geçen kullanıcı oturumdan düşüyordu (P1).** Refresh rotasyonunda yanıt kaybolunca eski belirteç "yeniden kullanım" sayılıyordu. 30 sn'lik, tek adımlık tanıma eklendi; hırsızlık tespiti korunuyor (ADR-0009 notu, B52).
  - **Geliştirme sunucusunda JavaScript çalışmıyordu.** CSP, React Refresh'in `eval` çağrısını engelliyordu; izin yalnızca geliştirme modunda açıldı.
- Kararlar: ADR-0024, `assumptions.md` B48–B51.

### Kabul kriterleri (P6a)
| Kriter | Durum | Kanıt |
|---|---|---|
| Görünümler gerçek API'ye bağlı, yetkiye duyarlı | ✅ | E2E `tasks.spec.ts` "kabuk": kapalı modül menüde yok, açılınca görünür; temsilci Admin ayarlarını görmez; `ui-support.int.test.ts` (rol, segment, yetenek) |
| Axe: ciddi/kritik ihlal yok; kritik akış yalnızca klavyeyle | ✅ | E2E: ana sayfa, palet, liste, Kanban, detay ve koyu tema axe denetimi; klavyeyle oluştur → Kanban'da taşı → detayda düzenle → sil ve geri al |
| Kanban sürüklemesi sonrası UI < 100 ms (iyimser) | ✅ | E2E: taşıma isteği 1,5 sn tutulurken kart bırakmadan sonra yeni sütunda < 100 ms |
| 10 bin satırlık listede akıcı kaydırma | ✅ | E2E: 10 000 görev (hacim verisi SQL ile; API'nin IP başına dakikada 600 istek sınırı yüzünden); sayfalar yüklenirken DOM'da < 80 satır |
| Açık/koyu tema ve mobil | ✅ | E2E: koyu tema kalıcı; 375 px'te dört ekranda yatay taşma yok, yan menü çekmece. Ekran görüntüsü regresyonu P6c'de |
| Bileşenler belgeli | ✅ | Storybook derlemesi CI'da; bileşen testleri |

### Testler
API entegrasyon **96/96** (+4: `ui-support.int.test.ts`, refresh tanıma), DB 18/18, bileşen testleri 11/11, **E2E 9/9** (`auth.spec.ts` + yeni `tasks.spec.ts`, üretim web imajına karşı), birim/lint/typecheck temiz, Storybook derleniyor, kontrast/matris/katalog PASS.

### Sonraki adım
**P6b** — takvim, Gantt/timeline, opportunity pipeline, CRM kayıt listeleri ve detayı, dashboard, kayıtlı görünümler + RQL filtre çubuğu.

## P5b — Faz 5: SLA, webhook, API anahtarı, SSE, e-posta özeti · 2026-11-21 · ✅ (CI PR'da çalışacak)

### Yapılanlar
- **`0007_integrations.sql`:** `business_calendars`, `sla_policies`, `sla_timers` (segment politikasıyla), `webhook_subscriptions` (şifreli gizli + döndürme), `webhook_deliveries`, `api_keys` (yalnızca özet), `notifications.emailed_at`. Tenant'lar arası taramalar için dar SECURITY DEFINER fonksiyonlar: vadesi gelen SLA saatleri, API anahtarı çözümleme, özet adayları, özet işaretleme. Kural tetikleyicisine `sla` eklendi.
- **SLA motoru (`packages/sla` + `SlaService`):** çalışma saati, tatil (tam/kısmi), saat dilimi ve DST; ilk yanıt ve çözüm milestone'ları; bekleme durumlarında duraklatma; dakikalık denetleyici `sla.warning` / `sla.breached` (tam bir kez, eşzamanlı güvenli); `sla.met`. Kurallar `sla` tetikleyicisiyle tepki verir.
- **Webhook'lar:** olay türü kalıpları, `Flexa-Signature` HMAC (döndürmede 24 saat çift imza), DNS sabitlemeli güvenli gönderim, 8 deneme + backoff, teslimat geçmişi, elle yeniden gönderim, 24 saat başarısızlıkta otomatik kapatma + Admin bildirimi + audit. Kural aksiyonu `call_webhook`.
- **API anahtarları:** `fx_…`, kapsam `read`/`write`, oluşturanın güncel yetkisi, anahtar başına hız sınırı, iptal/süre; hassas yönetim uç noktaları anahtara kapalı.
- **`Idempotency-Key`:** tüm yazma isteklerinde; tekrar → aynı yanıt (`Idempotent-Replayed`), farklı gövde → 422, sürerken → 409 (ADR-0023: depo Redis).
- **SSE (`GET /v1/stream`):** Redis pub/sub ile tüm API örneklerine; olay başına REST ile aynı okuma yetkisi; bildirimler yalnızca alıcıya ve içeriksiz; `Last-Event-ID` ile 72 saatlik yeniden oynatma, aksi halde `resync.required`.
- **Bildirim e-posta özeti:** 5 dakikada bir, `email` kanalını seçenlere, gönderim anında yeniden yetkilendirilmiş başlıklarla; bildirim başına en çok bir kez.
- **Bulunan ve düzeltilen önceki hatalar:**
  - P5a otomasyon e-postası iş kimliği gerçek BullMQ'da reddedilirdi (`:` kuralı). Test kuyruğu bunu gizliyordu; artık aynı kuralı uyguluyor.
  - `GET /v1/workflows` sırasızdı: yük altında görev testi rastgele düşüyordu. Artık kaynak türü + oluşturma sırasıyla dönüyor.
- **API (18 yeni uç nokta).** Kararlar: `assumptions.md` B41–B47, ADR-0023; ADR-0006/0007/0012/0013/0017/0020 uygulama notları.

### Kabul kriterleri (P5b)
| Kriter | Durum | Kanıt |
|---|---|---|
| SLA: iş saatine göre hedef, duraklatma, uyarı/ihlal bir kez, kural tetiklenir | ✅ | `integrations.int.test.ts` "SLA": eşleşmeyen politika saat başlatmaz; bekleme → `paused` + kalan süre; ihlal iki eşzamanlı denetleyiciyle bile tek `sla.warning` + tek `sla.breached`; kural bildirimi |
| Webhook imzası doğrulanabilir, retry, otomatik kapatma | ✅ | yerel alıcı imzayı `t + gövde` HMAC'iyle doğrular; 500 → `failed`, sonra `succeeded`; döndürmede iki imza; 24 saat sonra `auto_failures` + Admin bildirimi + `webhook.disabled`; `call_webhook` |
| API anahtarı kapsamı, iptal, hız sınırı; Idempotency-Key | ✅ | salt okunur anahtar POST → 403; anahtar yönetimi/matris → 403; iptal → 401; limit → 429; aynı anahtarla tekrar tek kayıt, farklı gövde → 422 |
| SSE yetkiye uyar, yeniden oynatır | ✅ | temsilci yalnızca kendi kaydının olayını alır (yöneticininki gelmez), bildirim içeriksiz; `Last-Event-ID` ile kaçanlar aynı süzgeçle gelir; bilinmeyen kimlik → `resync.required`; kimliksiz → 401 |
| E-posta özeti | ✅ | 10 dk'dan taze bildirim gönderilmez; tercihi `email` olan kullanıcıya tek e-posta; ikinci çalıştırma yeniden göndermez |

### Testler
API entegrasyon **92/92** (+8), DB 18/18, `packages/sla` 38/38, birim/lint/typecheck temiz, matris/katalog PASS.

### Sonraki adım
**P6** — arayüz çekirdeği ve tasarım sistemi: token → tema, bileşen kütüphanesi + Storybook, kabuk (modüle duyarlı menü, segment değiştirici, komut paleti), görev görünümleri, kayıt detayı, ayar ekranları.

## P5a — Faz 5: olay yolu ve kural motoru · 2026-11-21 · ✅ (CI PR'da çalışacak)

> Faz 5 iki adıma bölündü (`docs/p5-plan.md`): **P5a** olay yolu + kural motoru (bu adım), **P5b** SLA, webhook, API anahtarı, SSE, e-posta özeti.

### Yapılanlar
- **`0006_automation.sql`:** `outbox_events` (commit'te `NOTIFY`), `processed_events`, `automation_rules` (sürümlü, kimlik = son kaydeden Admin), `automation_runs` (girdi, koşul sonucu, aksiyonlar, süre, hata, deneme; `UNIQUE(kural, olay, kayıt)`), `dead_letters`, `assignment_policies`; otomasyon bildirimi; gelen webhook ve zamanlama için iki dar SECURITY DEFINER çözümleyici.
- **Olay yolu:** her kayıt değişikliği aynı transaction'da outbox'a yazılır (alan değeri yok, yalnızca alan adları). Relay (`flexa_relay`) → BullMQ `events` (iş kimliği = olay kimliği) → `automation` servisi.
- **Kural motoru:** tetikleyiciler (oluşturuldu, güncellendi, alan değişti, durum değişti, zamanlanmış/cron, gelen webhook), RQL koşulu (ilişkili firma alanları dahil), aksiyonlar (alan güncelle, görev oluştur, ata, bildirim, e-posta, durum geçişi). Kural JSON şeması `AutomationRuleDefinition` (P6 görsel editörü için).
- **Güvenlik önlemleri:** tam bir kez etki (kural × olay × kayıt tek transaction), döngü koruması (`halted_loop`, derinlik > 5 → `halted_depth`, ikisi de loglanır ve olay üretir), 8 deneme + üstel bekleme + tam jitter (üst sınır 15 dk), DLQ + replay, çalıştırma logu.
- **Atama politikaları:** round-robin (kilitli sıra), yük dengeli (açık görev/talep/aday sayısı), ekip veya kuyruk, yedek kullanıcı.
- **Compose:** `automation` servisi (API imajı, `EVENT_CONSUMERS=true`), worker'da relay. İşletim kılavuzu: `docs/ops/automation-dlq.md`.
- **CI hızlandırma:** Dockerfile'larda bağımlılık katmanı ayrı (`pnpm fetch`, yalnızca lockfile ile değişir) ve e2e işinde imaj katmanları GitHub Actions önbelleğinde (`docker/bake-action`). P4b'deki uzun e2e süresinin nedeni önbelleksiz imaj derlemesiydi.
- **API (12 yeni uç nokta).** Kararlar: `assumptions.md` B37–B40.

### Kabul kriterleri (P5a)
| Kriter | Durum | Kanıt |
|---|---|---|
| Döngüye giren iki kural limitte durur ve loglanır | ✅ | `automation.int.test.ts`: ping-pong → `halted_loop` + `automation.run.halted`; büyüyen zincir → 6 başarılı + `halted_depth` |
| Aynı olay iki kez işlense bile aksiyon bir kez | ✅ | aynı olay tekrar → boş; tüketici işareti silinse bile → `duplicate`; görev ve e-posta sayısı değişmez |
| Worker çökmesi sonrası olaylar kaybolmaz (kaos) | ✅ | relay yayınlayıp işaretlemeden "çöker", tekrar yayınlar: 12 kaydın her biri için tam 1 görev, bekleyen olay yok |
| Retry + DLQ + replay | ✅ | geçici hata → `failed`, son deneme → `dead` + DLQ; neden düzeltilip gerçek kuyruk/tüketiciyle replay → tek kez uygulanır |

### Testler
API entegrasyon **84/84** (+7), DB 18/18, birim/lint/typecheck temiz, matris/katalog PASS.

### Sonraki adım
**P5b** — SLA motoru (çalışma saati, tatil, DST), webhook'lar (HMAC, retry, devre dışı bırakma, `call_webhook` aksiyonu), API anahtarları + `Idempotency-Key`, SSE, bildirim e-posta özeti.


## P4b — Faz 4 + G2: kayıt etrafı · 2026-11-21 · ✅ (CI PR'da çalışacak)

### Yapılanlar
- **`0005_records.sql`:** `activity_events` (append-only: güncelleme trigger'la, silme uygulama rolünden yasak), `comments` + `comment_revisions`, `mentions`, `notifications` (+ tercihler; alıcı yalnızca kendi bildirimini okur), `attachments`, `delegations`, `access_requests`, `role_grant_overrides` + `matrix_versions`. Başkası adına bildirim oluşturma ve geri çekme dar kapsamlı iki SECURITY DEFINER fonksiyonuyla (tenant ve aktör oturumdan).
- **Activity timeline:** kayıt oluşturma, alan diff'i (API alan adlarıyla), durum geçişi, atama, silme/geri alma, dönüştürme, merge, yorum, dosya, e-posta/arama logu — iş yazımıyla aynı transaction'da. Okurken **FLS**: gizli alanın diff'i ve yalnızca onu değiştiren olay görünmez.
- **Yorumlar + mention (ADR-0017):** sunucuda üretilen güvenli HTML, düzenleme geçmişi (revizyon kontrolüyle), mezar taşı silme; hedef kaydı göremeyen kişi anılamaz (422, adlarıyla), ekip mention'ı erişimi olmayanları atlar, düzenlemede yalnızca yeni anılanlara bildirim, kaldırılanların okunmamış bildirimi geri çekilir.
- **Bildirimler:** `mention` ve `assigned`; okuma anında yetki (SCN-17: erişim kalkınca başlık, kayıt, aktör ve bağlantı boş), okundu / tümü okundu / okunmamış sayısı, kanal tercihleri (A28).
- **Dosya ekleri:** imzalı yükleme/indirme, boyut + dosya imzası doğrulaması, ClamAV kancası, karantina/enfekte dosya indirilemez, 25 MB ve MIME beyaz listesi.
- **Audit okuma (A23):** Admin tümü, Yönetici yalnızca ekip üyelerinin eylemleri; filtre + cursor.
- **Delegasyon (A07) ve yetki talebi:** süreli rol/segment devri ve iptali, onay/ret/geri çekme; Yönetici sınırları (`managed_teams_only`, `own_segments_only`, `no_escalation`, `not_self`) aynen.
- **Matris yönetimi (A03, AUTH-11):** tenant'a özel hücre değişikliği, diff önizleme, sürümler, geri alma; kapalı modül izinleri görünmez; Admin'in korunan izinleri değiştirilemez; motor override'ları her istekte bağlamdan okur.
- **Altyapı:** S3 istemcisi (`infra/storage.ts`), ClamAV istemcisi (`infra/scanner.ts`), Compose'a SeaweedFS + bucket kurulum adımı; testlerde SeaweedFS kapsayıcısı (MinIO imajları artık çekilemiyor, B33).
- **API (60 yeni uç nokta).** Kararlar: `assumptions.md` B33–B36.

### Kabul kriterleri (P4b)
| Kriter | Durum | Kanıt |
|---|---|---|
| Timeline: diff, geçiş, atama, oluşturma/silme; değiştirilemez | ✅ | `records.int.test.ts` + DB testi (uygulama UPDATE/DELETE yapamaz, sahibi bile UPDATE yapamaz) |
| Gizli alanın diff'i timeline'da görünmez | ✅ | aynı |
| Mention: erişimsiz hedef 422, ekip genişletme, yalnızca yeniye bildirim, geri çekme | ✅ | aynı |
| Bildirim okuma anında yetki (SCN-17) | ✅ | paylaşım kaldırılınca içerik boş |
| Dosya: imzalı yükleme/indirme, dosya imzası, yetkisiz indirme 404, enfekte dosya indirilemez | ✅ | SeaweedFS kapsayıcısıyla gerçek S3 akışı |
| Audit: Yönetici yalnızca ekibinin eylemleri | ✅ | aynı |
| Delegasyon süresi dolunca yetki kalkar (SCN-18); sınırlar | ✅ | aynı |
| Matris düzenleme sonraki istekte geçerli; diff; geri alma; korunan izin | ✅ | aynı |

### Testler
API entegrasyon **77/77** (+10), DB **18/18** (+1), birim testleri yeşil (zengin metin, ClamAV protokolü, dosya imzaları), lint/typecheck temiz, kontrast/matris/katalog PASS.

**Performans:** ✅ Temiz Docker ortamında (başka projelerin kapsayıcıları kaldırıldıktan sonra) tüm senaryolar hedefin çok altında: Admin sayım p95 58 ms, Yönetici (ekip + kural + parent erişimi) 65 ms, Yönetici sayım 74 ms (`docs/perf/p2-task-list.md`). Önceki koşulardaki 200 ms aşımları makine yükündendi: P4a (`main`) aynı yük altında aynı biçimde aşıyordu.

### Sonraki adım
**P5** — outbox relay, kural motoru, SLA, webhook, API anahtarı, SSE (bildirimlerin anlık iletimi ve e-posta özeti dahil).


## P4a — Faz 4 + G2: tek yetki motoru · 2026-11-21 · ✅ (CI PR'da çalışacak)

> P4 iki adıma bölündü (`docs/p4-plan.md`): **P4a yetki motoru** (bu adım) ve **P4b** kayıt etrafı (timeline, yorum/mention, dosya, bildirim, audit okuma, delegasyon, matris yönetimi).

### Yapılanlar
- **`0004_authz.sql`:** `user_segment_grants` (süreli), `teams` (üst ekip, döngü trigger'ı) + `team_members` (member/manager), rol hiyerarşisi (`roles.parent_role_id`, döngü trigger'ı), `sharing_defaults` (OWD), `record_shares` (kullanıcı/ekip, okuma/düzenleme; kaydı görünmüyorsa paylaşım satırı da görünmez), `sharing_rules` (RQL koşulu → ekip), `field_policies`; davetlere segment + ekip. Mevcut üyelere geriye uyumlu segment yetkisi verildi.
- **Segment = kullanıcı yetkisi ∩ satış modu**, `X-Segment` başlığı yalnızca daraltır (segment değiştirici).
- **Kayıt düzeyi motor** (`common/record-access.ts`): own / queue / team (alt ekipler dahil) / rol hiyerarşisi / OWD / manuel paylaşım / paylaşım kuralı → tek SQL predicate. Tekil okuma, liste, sayım ve yazma kontrolleri aynı yoldan; sonradan filtreleme yok. Görevler bağlı CRM kaydı üzerinden okunabilir (parent'tan türetilmiş erişim).
- **Alan düzeyi güvenlik:** gizli alan yanıtta yok, RQL/sıralama/`fields` için var olmayan alanla aynı `UNKNOWN_FIELD`; gizli alana yazma adını vermeden 403, salt-okunura yazma adıyla 403 `FIELD_READ_ONLY`.
- **Yönetici sınırları:** `managed_teams_only`, `own_segments_only`, `not_self`, `no_escalation`, `no_admin_assignment` (rol atama `canAssignRole`), Yönetici davetleri (yönettiği ekibe, Satış Temsilcisi, kendi segmentleri), yeniden atama ekip içinde.
- **API (40 yeni uç nokta):** ekipler ve üyeleri, kuyruklar ve üyeleri, kullanıcı erişim özeti, segment ve rol atama, rol hiyerarşisi, OWD, paylaşım kuralları, 6 nesnede manuel paylaşım, alan politikaları. Her değişiklik audit'li; yeniden atama da audit'e yazılır.
- Matristeki bir tutarsızlık çözüldü: kayıt dışı referans verisi okuması (A17, A26) rol atamada kapsam karşılaştırmasına girmez; aksi hâlde Yönetici Satış Temsilcisi atayamazdı (`assumptions.md` B28). Diğer kararlar B29–B32.

### Kabul kriterleri
| Kriter | Durum | Kanıt |
|---|---|---|
| Matristen otomatik üretilen test paketi (rol × eylem × kapsam × segment) | ✅ | `authz.int.test.ts`: `matrix.json`'dan bağımsız kâhin; 5 rol × okuma/düzenleme/arşiv/oluşturma × kendi/ekip arkadaşı/başka ekip/gizli segment |
| Yetkisiz kullanıcı göremez/değiştiremez; liste sayıları ve sayfalama doğru | ✅ | aynı paket: `count=true` toplamı ve tam liste, görünür kayıtlarla birebir |
| Gizli alan filtre/sıralama ile sızdırılamaz | ✅ | FLS testi: yanıt, `q`, `sort`, `fields`, yazma; Admin etkilenmez; kaldırma sonraki istekte geçerli |
| Rol hiyerarşisi ve paylaşım kuralı senaryoları | ✅ | hiyerarşi (görür / döngü reddi / geri alma), alt ekipler, OWD, manuel paylaşım, kriter kuralı |
| Karar senaryoları 10.4.4 | ✅ | SCN-01, 05 (audit'li), 06, 07, 08, 11 |
| Yetki değişikliği en geç bir sonraki istekte | ✅ | paylaşım, segment, rol ve süresi dolan segment aynı token ile sonraki istekte |
| Audit log'a UPDATE/DELETE DB tarafından reddedilir | ✅ | P1'den beri `rls.int.test.ts` |
| Yetki kontrollü listede p95 < 200 ms | ✅ | `docs/perf/p2-task-list.md`: Yönetici (ekip + kural + parent) p95 56 ms, sayımlı 78 ms |

### Testler
API entegrasyon **67/67** (+15), DB 17/17, birim testleri yeşil (authz'a kapsam ve rol atama testleri), perf yeşil, lint/typecheck temiz, kontrast/matris/katalog PASS.

### Sonraki adım
**P4b** — activity timeline, yorum + mention, dosya ekleri, bildirim temeli, audit okuma, delegasyon ve yetki talebi, matris yönetim API'leri.


## P3 — Faz 3: CRM nesneleri · 2026-11-20 · ✅ (CI PR'da çalışacak)

### Yapılanlar
- **`0003_crm.sql`:** `accounts` (hiyerarşi + döngü trigger'ı, alan adı), `contacts` (üretilmiş `full_name`), `account_contact_roles`, `contact_points` (E.164, küçük harf e-posta, sahibine registry FK), `leads`, `lead_conversions`, `pipelines` + `pipeline_stages` (aşama → olasılık), `opportunities` (`numeric(18,4)` + para birimi, manuel/otomatik olasılık), `cases`, `notes` (polimorfik, özel/standart), `merges`; `pg_trgm` isim indeksleri. 12 yeni tablonun tamamı FORCE RLS + RESTRICTIVE tenant politikası.
- **Segment RLS (ADR-0010) devrede:** `app.segments()`; CRM tablolarında, `tasks`, `notes` ve `record_registry`'de RESTRICTIVE `segment_isolation`; `contact_points` yalnızca sahibi görünürse görünür. Yeni şema koruma testi: segment sütunu olan her tablo segment politikası taşımalı.
- **Varsayılan akışlar** (`app.seed_crm_workflows`, migration + provisioning tek kaynak): lead (new → working → qualified / unqualified / converted), satış hattı (10/25/50/75/100/0; `win` tutar, `lose` gerekçe ister), destek talebi (new → in_progress ↔ waiting → resolved → closed, reopen).
- **API (56 yeni uç nokta):** 5 nesne için RQL'li liste, CRUD, `If-Match`, soft delete/restore, ilişkili görevler; lead/fırsat/talep geçişleri; iletişim noktaları; kişi–firma rolleri; atomik lead dönüştürme; firma/kişi merge ve mükerrer listesi; satış hatları; notlar. Görevler artık CRM kayıtlarına bağlanabilir ve kaydın segmentini devralır.
- **Yetki:** `recordScope` kaynağa duyarlı (modül kapısı + Matris A `resources`); `own` = sahip veya oluşturan; başkasına kayıt vermek `reassign`.
- **Seed:** `pnpm --filter @flexa/api seed:demo` — demo çalışma alanı API üzerinden (doğrulama, yetki ve RLS aynen uygulanır).
- Ayrıntılar ve kararlar: `docs/p3-plan.md`, `docs/assumptions.md` B24–B27.

### Kabul kriterleri (Faz 3)
| Kriter | Durum | Kanıt |
|---|---|---|
| Lead dönüştürme atomik; hata durumunda hiçbir kayıt kalmaz | ✅ | `crm.int.test.ts`: firma + kişi (iletişim noktaları, rol) + fırsat tek adımda; geçersiz pipeline → 422 ve tablo sayıları değişmez; ikinci çağrı 409 |
| Opportunity aşama değişiminde olasılık doğru | ✅ | 10 → 50, manuel 33 korunur, `probabilityManual:false` → 75, kazan → 100 + `closedAt`, yeniden açınca 75 |
| Merge sonrası ilişkili task/aktiviteler taşınır | ✅ | kişi: görev, not, iletişim noktası (mükerrer e-posta düşer), fırsat; firma: fırsat, talep, kişi rolü, alt firma |
| Tüm CRM nesnelerinde tenant izolasyonu | ✅ | şema koruması (otomatik, 17/17) + API çapraz tenant (id ile bile 404) + segment testi (b2b-only alanda b2c kayıt, görevi, notu ve telefonu görünmez — uygulama rolüyle DB'de de 0 satır) |

### Testler
API entegrasyon **52/52** (P1 25 + P2 14 + P3 13), DB izolasyon 17/17, birim testleri yeşil (authz'a kaynak daraltma testi eklendi), görev listesi perf testi yeşil (ortak liste motoruna geçiş sonrası), lint/typecheck temiz, kontrast/matris/katalog PASS.

### Bilinen sınırlar
- Kullanıcı bazlı segment yetkisi, ekip/kuyruk kapsamı ve FLS P4'te (şimdilik segment = tenant satış modu, kapsam fail-closed `own`).
- CRM için özel workflow/pipeline yönetimi P6 ayar ekranlarıyla.
- CRM ekranları P6 (bu adım yalnızca API + veri katmanı).
- Outbox olayları ve activity timeline P4/P5.

### Sonraki adım
**P4 — Faz 4 + G2:** tek yetki motoru (predicate, rol hiyerarşisi, OWD, sharing, FLS, kullanıcı segment yetkisi), timeline, yorum, dosya, audit, bildirim temeli.


## P2 — Faz 2: Task çekirdeği · 2026-11-20 · ✅ (CI PR'da çalışacak)

### Marka değişikliği (aynı dalda)
- Ürün adı **Runvara → Flexa** (kullanıcı kararı). Tek kaynak `packages/ui/brand.json`, kurallar `docs/brand.md` (kaynak prompt §12'nin yerini alır).
- Teknik ön ekler: `@flexa/*`, `flexa_owner/app/relay`, `FLEXA_*`, çerezler `fx_rt`/`fx_csrf`. Yeni palet (mor `#7B3CFF`, antrasit yan menü) token'lara döküldü: kontrast **90/90**. JSON'daki ikincil metin `#8B93A7` normal metin için yetersiz (2.92–3.07:1) olduğundan metinde `#646B7E` kullanılır; gerekçe `docs/brand.md` §3.
- Resmi Flexa logosu `packages/brand/`'e eklendi (verilen SVG birebir + açık zemin ve yalnız sembol türevleri); giriş ekranı ve favicon bu dosyaları kullanır.
- **Yerel geliştirme:** 0001 migration'ındaki rol adları değiştiği için mevcut yerel Compose veritabanı eski şemayla uyumsuzdur: `docker compose down -v` ve `node scripts/dev-env.mjs --force` gerekir.

### Yapılanlar
- **Yeni paketler** (arayüzler `docs/p2-plan.md`):
  - `@flexa/query-lang` (RQL) — lexer, Pratt parser, Türkçe anahtar kelimeler, tip/operatör denetimi, saat dilimine duyarlı göreli tarihler, değerler daima parametre; 214 test (fast-check property: 600–3000 koşu, injection korpusu değer ve alan konumunda).
  - `@flexa/formula` — eval'siz formül dili, null semantiği, döngü tespiti; 39 test.
  - `@flexa/recurrence` — RRULE yerel duvar saatinde, DST boşluğu → sonraki geçerli dakika, çakışma → ilk oluşum; 26 test (Berlin, New York, İstanbul).
  - `@flexa/workflow` — durum makinesi (koşul, doğrulayıcı, post-function), fractional indexing, DAG döngü tespiti; 33 test.
- **`0002_tasks.sql`:** `record_registry` + bileşik FK (polimorfik bütünlük), kuyruklar (work/call tek kavram), workflow/status/geçiş, görevler (sahiplik CHECK'leri, derinlik ≤ 5 ve ebeveyn döngüsü trigger'ı), bağımlılık DAG trigger'ı (tenant başına advisory lock), etiketler, tekrar serileri, custom field tanımları, varsayılan görev akışı fonksiyonu (`app.seed_task_workflow`). 12 tablonun tamamı FORCE RLS + RESTRICTIVE (şema koruma testi otomatik doğruladı).
- **`@flexa/authz.recordScope`:** Matris A A08–A13/A24'ten kayıt kapsamı; ekip/kuyruk/segment kapsamı P4'e kadar **fail-closed** olarak "kendi kayıtları".
- **API (21 yeni uç nokta):** görev CRUD + soft delete/restore, `If-Match` iyimser kilit (428/412), geçişler (`/transition`, PATCH ile statü değişimi 409), fractional sıralama + yeniden dengeleme (`/move`), alt görevler + ilerleme, bağımlılıklar (döngü yolu raporlanır), toplu güncelleme (atomik/değil), tekrar serileri (kapanınca sonraki örnek, çift üretim imkânsız), workflow ve custom field yönetimi, RQL listeleme (imzalı, sorguya bağlı keyset cursor; NULLS LAST; alan seçimi; sayım), `/v1/rql/validate` ve `/v1/rql/fields`.

### Kabul kriterleri (Faz 2)
| Kriter | Durum | Kanıt |
|---|---|---|
| Geçersiz workflow geçişi reddediliyor, geçerlisi kaydediliyor | ✅ | `tasks.int.test.ts` (izinli liste, doğrulayıcı, closedAt) + `workflow` 33 birim |
| Döngü oluşturan bağımlılık engelleniyor | ✅ | API (yol raporlu), eşzamanlı ters kenar (biri 201 biri 422), API atlanınca DB trigger |
| Tekrarlayan görev kapanınca doğru tarihte yeni örnek (DST dahil) | ✅ | Berlin 2026-03-28 08:00Z → 2026-03-29 07:00Z, kapat-aç-kapat sonrası tek örnek |
| Sorgu dili SQL injection'a karşı güvenli (fuzz/property) | ✅ | `query-lang` property testleri + API'de injection korpusu (200, boş sonuç, tablo yerinde) |
| 10 bin kayıtla liste p95 < 200 ms | ✅ | `docs/perf/p2-task-list.md`: p95 30–33 ms (sayımlı 52 ms) |

### Testler
API entegrasyon **39/39** (P1 25 + P2 14), DB izolasyon 16/16, tüm birim test görevleri yeşil (23), lint/typecheck temiz, kontrast/matris/katalog PASS.

### Bilinen sınırlar
- Outbox/olay yayını, activity timeline ve audit'e görev olayları P4/P5'te (ADR-0006 notu); görev değişiklikleri henüz olay üretmez.
- Workflow **düzenleme** ve yayım sihirbazı (sürümleme) P6 ayar ekranlarıyla; şimdilik yeni workflow oluşturulabilir, mevcut düzenlenemez.
- Undo (toplu işlem geri alma) P6.
- Custom field ifade indeksleri (`indexed: true`) için `CREATE INDEX CONCURRENTLY` işi P5 worker'ında; şimdilik GIN `jsonb_path_ops`.
- Görece tarihler tenant saat diliminde hesaplanır; kullanıcı saat dilimi P7 (i18n) ile.

### Sonraki adım
**P3 — Faz 3 CRM nesneleri** (segment sütunlarıyla).

## P1 — Faz 1 + G1 çekirdeği: İskelet, kimlik doğrulama, multi-tenancy · 2026-11-20 · ✅

### Yapılanlar
- **Monorepo:** pnpm 10 + Turborepo, TypeScript 5.9 strict, ESLint (strict-type-checked + sabit renk yasağı + `pg` import yasağı), Prettier, lint-staged + husky, commitlint. Sürüm sabitleme gerekçesi: ADR-0001 eki.
- **`packages/db`:** DB rolleri (`flexa_owner` BYPASSRLS / `flexa_app` NOBYPASSRLS / `flexa_relay`), `0001_foundation.sql` (16 tablo, hepsi FORCE RLS, tenant tablolarında RESTRICTIVE politika, değiştirilemez `audit_log` ve `auth_events`, 9 SECURITY DEFINER çözümleyici), checksum'lı ve advisory-lock'lu migration koşucusu, `withTenant / withUser / withAnonymous`.
- **`packages/security`:** argon2id, Ed25519 JWT, TOTP (tekrar koruması), kurtarma kodları, AES-256-GCM zarf şifreleme (tenant DEK), CSRF.
- **`packages/modules`:** 13 modüllük katalog (tek kaynak `src/catalog.json`), bağımlılık grafiği, `planToggle` (bağımlılık, bağımlı modül, cascade), rota → modül eşlemesi.
- **`packages/authz`:** `permission-matrix.yaml`'dan derleme anında üretilen `can()` (modül kapısı → rol yetkisi → politika); P4'te kayıt kapsamı aynı giriş noktasına eklenecek.
- **`packages/contracts`:** Zod şemaları, hata kodu kataloğu, uç nokta listesi → OpenAPI 3.1.
- **`apps/api`:** kayıt (tenant + 5 sistem rolü + core modülü + DEK tek transaction), e-posta doğrulama, giriş (hesap varlığı sızdırmaz, zamanlama eşitlenmiş, kilit), TOTP 2FA, refresh rotasyonu + yeniden kullanım tespiti, CSRF, çıkış, parola sıfırlama (tüm oturumlar kapanır), tenant seçimi, davetler, modül aç/kapat (audit + authz_epoch), OIDC (PKCE, nonce, state, alan adı kontrolü, JIT = Analist), SSRF korumalı giden URL denetimi, helmet/CORS/Redis hız sınırı, request-id, log redaksiyonu, `/healthz` `/readyz`, `/openapi.json` + `/docs`, OpenTelemetry (OTLP uç noktası verilirse).
- **`apps/worker`:** BullMQ e-posta kuyruğu, TR/EN şablonlar (HTML kaçışlı), health uç noktaları.
- **`apps/web`:** (alt ajanla) giriş, kayıt, 2FA, tenant seçimi, güvenlik/davet/modül ayarları, davet kabulü, parola sıfırlama, OIDC dönüşü; yalnızca token'lar, aynı-köken `/api` proxy, CSP.
- **Altyapı:** Docker Compose (postgres 18, redis 7, mailpit, migrate, api, worker, web; host portları `.env` ile değiştirilebilir), çok aşamalı Dockerfile'lar, `scripts/dev-env.mjs`, GitHub Actions iş akışı (`.github/workflows/ci.yml`), README.

### Kanıt
| Paket | Sonuç |
|---|---|
| DB izolasyon (Testcontainers, PG18) | 16/16 — bağlamsız 0 satır, çapraz tenant okuma/güncelleme/ekleme engeli, `SET row_security=off` reddi, havuz sızıntısı yok, audit değiştirilemez, şema koruması |
| API entegrasyon (PG18 + Redis7) | 25/25 — kayıt/doğrulama, kilit, TOTP + tekrar, refresh reuse, CSRF, parola sıfırlama, davetler, API düzeyi tenant izolasyonu, modüller, OIDC (sahte IdP), hız sınırı, rota ↔ sözleşme eşleşmesi |
| Birim | config 2, security 11, modules 9, authz 8, contracts 4, worker 3, api (SSRF) 3 |
| E2E (Playwright, Compose yığını) | 4/4 — kayıt → doğrulama → giriş → 2FA → çıkış → 2FA ile giriş; tenant seçimi; axe /login ve /signup (kritik/ciddi ihlal yok) |
| Lint + typecheck + build | 25/25 turbo görevi temiz (web: tsc + eslint temiz) |
| `docker compose up --build --wait` | 6 servis sağlıklı, migrate çıkış 0 |
| Doğrulama betikleri | kontrast 79/79, yetki matrisi, modül kataloğu PASS |

### Kabul kriterleri (Faz 1)
| Kriter | Durum |
|---|---|
| `docker compose up` ile tüm servisler sağlıklı ayağa kalkıyor | ✅ |
| Kayıt → giriş → 2FA → tenant seçimi E2E | ✅ |
| Tenant izolasyon testleri (API ve DB) | ✅ |
| CI yeşil | ✅ GitHub Actions, PR #1 (sukruertem-dev/Runvara-CRM): `checks` ve `e2e` işleri yeşil |

### Test sırasında bulunup düzeltilen hatalar
- `withTenant` geçersiz kimlikte Promise reddi yerine senkron hata fırlatıyordu.
- Davet kabulünde `accepted_by` yabancı anahtarı, kullanıcı satırından önce yazılıyordu (500).
- SSRF koruması: `::ffff:0:0/96` alt ağı Node `BlockList`'inde tüm IPv4 adreslerini engelliyordu; eşlemeli adresler artık açılıp IPv4 kurallarıyla denetleniyor.
- Turborepo katı ortam modu `API_INTERNAL_URL`'i Next derlemesine iletmiyordu (web proxy 500).

### Bilinen sınırlar / sonraki fazlara bırakılanlar
- Plan hakkı kontrolü (MOD-04), yapılandırma motoru, blueprint'ler, SAML, operatör konsolu, kota → P7 (G1 kalanı).
- Yönetici davetleri ekip kapsamı gerektirir → P4'te ekiplerle (şimdilik `MANAGER_LIMIT`).
- AuthzContext her istekte DB'den yükleniyor (doğru ama önbelleksiz); Redis önbelleği P4'te.
- E-posta kuyruğa commit sonrası ekleniyor; çökme anında kayıp olursa kullanıcı "yeniden gönder" kullanır. Outbox'a geçiş P5.
- TOTP kurulumunda QR kod yok (gizli anahtar + otpauth URI metni); tasarım sistemiyle P6'da.
- Web'in `next build` standalone adımı Windows'ta symlink izni nedeniyle yerelde tamamlanmıyor; Linux/Docker derlemesi sorunsuz.

### Sonraki adım
**P2 — Faz 2 Task çekirdeği:** status/workflow motoru, custom field, bağımlılık DAG, RRULE, RQL sorgu dili, cursor API.

## P0 — Faz 0 + G0: Mimari ve gereksinim analizi · 2026-11-20 · ✅ tamamlandı (onay bekliyor)

### Yapılanlar
- Kaynak promptun tamamı (Bölüm 1–12) analiz edildi; 27 tespit (6 kritik) ve düzeltmeleri: `docs/requirements-review.md`.
- 22 ADR (`docs/adr/`), mimari doküman, bütünleşik faz planı.
- ER diyagramı: 11 alan diyagramı, 148 tablo (`docs/er-diagram.md`) — 13/13 Mermaid bloğu ayrıştırıcıdan geçti.
- API taslağı, olay kataloğu (80+ olay tipi), risk kaydı (25 risk), varsayımlar (43) + tek toplu soru (Q1–Q5).
- Makine okunur yetki matrisi `docs/enterprise/permission-matrix.yaml` (Matris A 36 satır, AI 16 satır, 10 demo kullanıcı, 34 karar senaryosu) — kaynak tablolarla **hücre hücre** doğrulandı.
- Modül manifest şeması + 13 modüllük katalog — şema, §10.3.1 bağımlılık tablosu ve döngü kontrolü geçti.
- `packages/ui/tokens.json` (tam tema paritesi) + kontrast raporu: 79/79 kontrol geçti.
- Alt ajanlarla (Sonnet) üretilen ve gözden geçirilen: izlenebilirlik tablosu (246 gereksinim, 122 kabul kriteri, 474 test ID), 115 kullanıcı hikâyesi, 22 ekran wireframe'i.

### Kabul kriterleri
| Kriter | Durum | Kanıt |
|---|---|---|
| F0: ER diyagramı tüm referans gereksinimleri kapsıyor | ✅ | `er-diagram.md` 11 alan; izlenebilirlikte DM-* satırları |
| F0: Her kritik karar bir ADR'ye bağlı | ✅ | `adr/README.md`; `requirements-review.md` her maddede ADR |
| F0: Klasör yapısı ve modül sınırları net | ✅ | `architecture.md` §3 |
| F0: Riskler için azaltma planı mevcut | ✅ | `risks.md` |
| G0: Her gereksinim bir faza ve en az bir teste bağlı | ✅ | `enterprise/requirements-traceability.md` (eksik ID yok, grep ile doğrulandı) |
| G0: Yetki matrisi YAML'ı 10.4 tablolarıyla birebir tutarlı | ✅ | `node scripts/check-permission-matrix.mjs` → PASS; negatif test hücre bozulmasını yakaladı |
| G0: Yönetici sınırları ve tenant çözümü kuralları istisnasız yazılı | ✅ | ADR-0004 §7, ADR-0003 §4, ADR-0015 §4 |
| G0: Palet kontrast raporu tüm metin çiftlerinde ≥ 4.5:1 | ✅ | `contrast-report.md` (düzeltmelerle; Q4 onayı bekleniyor) |

### Bilinen sınırlar
- Kaynak §4 DoD'deki "docker compose up / CI yeşil" maddeleri P0 için uygulanamaz (kod yok); doğrulama betikleri şimdilik `yaml`/`ajv` paketlerini kök `package.json` olmadan çalıştırıyor — P1'de devDependency olarak eklenip CI adımı yapılacak.
- Depoda uzak sunucu (remote) yok → CI kurulamadı (Q3).
- Flexa adı için marka/alan adı araştırması yapılmadı (R-21).

### Sonraki adım
Q1–Q5 yanıtlandıktan sonra **P1** (Faz 1 + G1 çekirdeği): monorepo, Docker Compose, CI, kimlik doğrulama, RLS + DB rolleri, modül kayıt defteri/kapısı, tenant sızıntı testleri.
