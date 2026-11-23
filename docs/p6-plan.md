# P6 — Faz 6: arayüz çekirdeği ve tasarım sistemi · uygulama planı

> 2026-11-21 · Kaynak: prompt Faz 6 ve §5.5, §10.5 (tasarım dili), Faz G9 (kabuk ve bileşen maddeleri), ADR-0007 (SSE), ADR-0024 (ön yüz yığını). Faz 6 tek PR için çok büyük olduğundan üç adıma bölündü:
> - **P6a (bu dal, `feat/p6-ui-core`):** tasarım sistemi (token → Tailwind teması, yoğunluk, açık/koyu), bileşen kütüphanesi + Storybook, uygulama kabuğu (modüle duyarlı yan menü, tenant ve segment değiştirici, rol rozeti, kullanıcı menüsü, bildirim zili ve merkezi, bağlantı göstergesi), komut paleti ve kısayollar, gerçek zamanlı güncelleme, görev görünümleri (liste, Kanban, tablo) ve görev detay sayfası, geri alma toast'u.
> - **P6b:** takvim, Gantt/timeline, opportunity pipeline, CRM kayıt listeleri ve kayıt detayı, dashboard widget'ları, kayıtlı görünümler + RQL filtre çubuğu (otomatik tamamlama) + paylaşılabilir bağlantı.
> - **P6c:** ayar ekranları (workflow editörü, custom field yöneticisi, rol/izin matrisi, otomasyon kural oluşturucu, webhook ve API anahtarı, SLA ve takvim), Lighthouse ve ekran görüntüsü regresyonu CI'da.

## 1. Tasarım sistemi (`packages/ui`)
- **Token'lar tek kaynak:** `tokens.json` → `dist/tokens.css` (CSS değişkenleri, açık/koyu, `prefers-color-scheme`) + `dist/theme.css` (Tailwind v4 `@theme inline`). Tailwind'in varsayılan paleti `--color-*: initial` ile kapatılır, yani `bg-red-500` gibi token dışı sınıflar **derlenmez**. Hex sabiti lint ile yasak (mevcut kural `packages/ui/src/**/*.tsx`'i de kapsayacak şekilde genişler).
- Yeni token grupları: `space` (4 px ızgara) ve `density` → `--row-h`, `--control-h` (`data-density="compact|comfortable"`).
- **Bileşenler** (Radix tabanlı, shadcn kalıbı: kaynak bizde, stiller token sınıflarıyla): Button, IconButton, Input, Textarea, Select, Combobox, Checkbox, Dialog, Sheet, Popover, Tooltip, DropdownMenu, Toast (eylemli: geri al), Tabs, Badge (rol, segment, durum, öncelik; renge ek olarak ikon + metin), Avatar, DatePicker, Skeleton, EmptyState, ErrorState, Kbd, Spinner, RichTextEditor (Tiptap; görev açıklaması zaten ProseMirror JSON).
- **Storybook** (`packages/ui`, `@storybook/react-vite`, a11y eklentisi): her bileşen için hikâye; açık/koyu ve yoğunluk araç çubuğundan. CI'da `build-storybook` derlenir.
- **Bileşen testleri:** Vitest + jsdom + Testing Library + axe-core: klavye etkileşimi, ARIA, kritik a11y ihlali yok.

## 2. Uygulama kabuğu (`apps/web`)
- **Yan menü:** `GET /v1/me/navigation`. Kapalı veya yetkisiz modül hiç gelmez (sunucu kararı). Daraltılabilir; mobilde çekmece.
- `GET /v1/me/navigation` genişler: `roles`, `segments` (kullanıcının etkin segmentleri ∩ satış modu, `X-Segment` daraltması **öncesi**) ve `capabilities` (ör. `task.create`). Değerler `can()` ile sunucuda hesaplanır; arayüz yalnızca gizler, yetki kararı vermez.
- **Segment değiştirici:** yalnızca iki segmenti olan kullanıcıda görünür. Seçim `X-Segment` başlığıyla tüm isteklere gider (sunucu yalnızca daraltır) ve oturum deposunda tutulur. Segment ikon + etiket ile gösterilir.
- **Tenant değiştirici:** birden çok tenant varsa açılır menü (mevcut `/select-tenant` akışı).
- **Kullanıcı menüsü:** tema (sistem / açık / koyu), yoğunluk (rahat / kompakt), güvenlik ayarları, çıkış.
- **Bildirim zili ve merkezi:** `GET /v1/notifications`, okundu / tümü okundu. SSE `notification.created` gelince kırmızı kıvılcım; "Anıldım" filtresi (mention türü).
- **Bağlantı göstergesi:** SSE kopunca ve `navigator.onLine` false olunca görünür şerit; yeniden bağlanınca `Last-Event-ID`; `resync.required` gelince tüm sorgular tazelenir.

## 3. Komut paleti ve kısayollar
- `Cmd/Ctrl+K`: menü öğelerine git, hızlı eylemler (yeni görev, tema değiştir), son görüntülenenler (yerel), görev arama (`GET /v1/tasks?q=title ~ "…"`, gerçek API).
- Kısayollar: `C` yeni görev, `/` arama (palet), `J`/`K` liste ve Kanban'da gezinme, `Enter` aç, `?` kısayol yardımı. Yazı alanındayken devre dışı.

## 4. Görev görünümleri
- **Ortak veri katmanı:** TanStack Query; görev sorgusu RQL + imleçli sayfalama (`useInfiniteQuery`). SSE `task.*` olayları ilgili sorguları geçersiz kılar.
- **Liste:** sanal kaydırma (`@tanstack/react-virtual`, 10 bin satır), satır içi başlık / öncelik düzenleme (`PATCH` + `If-Match`), çoklu seçim (Shift aralık seçimi), toplu eylem (`POST /v1/tasks/bulk`: durum, atanan, öncelik, sil) ve geri al.
- **Kanban:** iş akışı durumları sütun; dnd-kit (fare + klavye sensörü), optimistic güncelleme (önbellek hemen değişir, `POST /v1/tasks/{id}/move` ile kesirli konum + geçiş); hata olunca geri dönüş ve gerekçeli toast; WIP limiti (durum `wipLimit`, aşılınca uyarı), swimlane (atanan / öncelik).
- **Tablo:** TanStack Table; sütun göster/gizle, sıralama (sunucu `sort=`), gruplama (durum / atanan / öncelik), sabit ilk sütun, sütun tercihleri yerelde.
- **Görev detay** (`/tasks/[id]`): solda alanlar (satır içi düzenleme, gizli alan render edilmez), ortada açıklama (Tiptap) + timeline + yorumlar, sağda alt görevler, bağımlılıklar ve ilişkili kayıt. Başka kullanıcı kaydı değiştirince (SSE) "Bu kayıt güncellendi" şeridi; `412` gelince çakışma iletişim kutusu (yenile / üzerine yazma yok).
- **Geri alma:** silme ve toplu silme sonrası 8 sn toast; "Geri al" → `POST /v1/tasks/{id}/restore` (toplu: her biri). Toplu alan değişikliği önceki değerlerle ters bulk isteği.

## 5. Durumlar, hareket, erişilebilirlik
- Skeleton (yükleme), EmptyState (tek eylem), ErrorBoundary + ErrorState (yeniden dene), 403/404 sayfaları.
- `motion` ile mikro animasyonlar; `MotionConfig reducedMotion="user"` + token süreleri `prefers-reduced-motion`'da 0.
- WCAG 2.2 AA: odak halkası token'ı, odak tuzakları (Radix), `aria-live` duyuruları (sürükle-bırak, toast), atlama bağlantısı, minimum 24 px hedef.
- Responsive: < 768 px yan menü çekmece, Kanban yatay kaydırma, detayda sütunlar alt alta.

## 6. Kabul kriterleri ↔ testler (P6a)
| Kriter | Test |
|---|---|
| Görünümler gerçek API'ye bağlı, yetkiye duyarlı | E2E `shell.spec.ts`: Admin ve temsilci farklı menü görür; kapalı modül menüde yok |
| Axe: kritik ihlal yok; kritik akışlar yalnızca klavyeyle | E2E `tasks.spec.ts`: liste, Kanban, detay, palet sayfalarında axe; klavyeyle görev oluştur → Kanban'da taşı → detayda düzenle |
| Kanban sürükleme sonrası UI < 100 ms (optimistic) | E2E: sürükleme bitişinden kartın yeni sütunda görünmesine kadar süre (ağ isteği tutularak) |
| 10 bin satırlık listede akıcı kaydırma | bileşen testi: 10 bin satırda DOM'daki satır sayısı < 60; E2E: tohumlanmış 10 bin görevde kaydırma sonunda son satır |
| Açık/koyu tema ve mobil | E2E: iki tema + 375 px görünümde yatay taşma yok; ekran görüntüsü regresyonu P6c'de |
| Bileşenler belgeli | `build-storybook` CI'da; bileşen testleri (Vitest + axe) |

## 7. P6b — görünümler (`feat/p6b-views`)
- **API:**
  - `GET /v1/{tasks|accounts|contacts|leads|opportunities|cases}/aggregate`: liste motorunun FROM'u, kayıt kapsamı ve RQL süzgeciyle aynı kümede `count` / `sum:<sayı alanı>`, bir alana göre gruplama (tarih alanlarında `day|week|month`, tenant saat diliminde). Gizli alan gruplanamaz ve toplanamaz.
  - `GET /v1/task-dependencies?ids=`: iki ucu da okunabilir bağımlılık kenarları (Gantt).
  - `saved_views` (kişisel / çalışma alanı; sorgu ve sıralama kayıtta derlenerek doğrulanır), `user_dashboards` (kullanıcı başına yerleşim), `GET /v1/sla/summary` (okunabilir kayıtların SLA durumu).
- **Filtre çubuğu:** alan, işleç ve değer önerileri (`/v1/rql/fields`); API doğrulaması ve hata konumu; Enter ile uygulanır. Kayıtlı görünümler menüsü: uygula, kaydet, sil, bağlantıyı kopyala. Filtre URL'de olduğu için bağlantı paylaşılabilir.
- **Takvim** (ay/hafta/gün): bitiş tarihine göre. Fare, dokunma ya da Space + oklar + Space ile başka güne taşıma; saat korunur, başlangıç aynı miktarda kayar.
- **Gantt:** başlangıç → bitiş çubukları, bağımlılık okları, kritik yol (bağımlılık DAG'ında süreye göre en uzun zincir). Sürükleyerek taşıma ve sağ kenardan uzatma; klavyede ←/→ ile bir gün kaydırma, Shift ile süre değiştirme.
- **CRM:** firma, kişi, aday, fırsat ve talep listeleri (sunucu sıralaması, filtre çubuğu, kayıtlı görünümler). Kayıt sayfası: alanlar satır içi düzenlenir (If-Match), açıklama, yorumlar, etkinlik, ilişkili kayıtlar, durum geçişi, canlı değişiklik uyarısı.
- **Pipeline** (`/crm?type=opportunity&view=pipeline`, `/sales/b2b`): aşama sütunları; API'den toplam ve olasılığa göre ağırlıklı tutar; sürükle-bırak ve klavyeyle aşama geçişi.
- **Gösterge paneli** (ana sayfa): KPI'lar (açık, bana atanan, gecikmiş, SLA ihlali), duruma ve önceliğe göre görevler, son 14 gün açılan ve kapanan, fırsat hunisi. Düzenleme kipinde sürükle-bırak ya da klavyeyle sıralama, düğmelerle boyutlama, bileşen ekleme ve kaldırma; yerleşim kullanıcıya kaydedilir.

## 8. Kabul kriterleri ↔ testler (P6b)
| Kriter | Test |
|---|---|
| Sorgu dili için otomatik tamamlamalı filtre çubuğu | E2E `views.spec.ts` "RQL": öneri seçilir, geçersiz sorgu konumla bildirilir ve uygulanmaz |
| Kayıtlı görünümler ve paylaşılabilir bağlantı | aynı E2E: görünüm kaydedilir, bağlantı yeni oturumda aynı süzgeci açar; `views.int.test.ts` (kişisel/çalışma alanı, yalnızca sahibi değiştirir, doğrulama, If-Match) |
| Takvim: sürükleyerek tarih değiştirme | E2E: klavyeyle bir gün ileri; API'de bitiş saati korunur |
| Gantt: bağımlılık okları, süre ayarı, kritik yol | E2E: ok ve kritik yol vurgusu; klavyeyle bir gün kaydırma; `views.int.test.ts` bağımlılık kenarları yetkiye uyar |
| Pipeline: aşama toplamları, sürükle-bırak | E2E: aşama toplamı API'den; klavyeyle aşama geçişi; `views.int.test.ts` toplama ve FLS |
| Kayıt detay: satır içi düzenleme, timeline, ilişkili kayıtlar | E2E: firma sayfası, ilişkili kişi ve fırsat, alan düzenleme |
| Dashboard: sürüklenebilir/yeniden boyutlanır widget'lar | E2E: KPI'lar gerçek sayılarla; kaldırma ve genişletme yeniden yüklemeden sonra korunur; `views.int.test.ts` varsayılan yerleşim ve kapalı modül bileşenleri |
| Erişilebilirlik | E2E: filtre, takvim, Gantt, CRM listesi ve detayı, pipeline, pano için axe |

## 9. P6c — ayarlar, Lighthouse, ekran görüntüsü regresyonu (`feat/p6c-settings`)
- **API:**
  - `POST /v1/workflows/{id}/preview` (kuru çalıştırma) ve `PUT /v1/workflows/{id}` (If-Match). Var olan durumlar `id` ile eşleşir, anahtarları değişmez. Kaldırılan durumdaki kayıtlar `statusMap` ile başka duruma taşınır; eşleme yoksa 409 `WORKFLOW_STATUS_IN_USE` (ADR-0026). Opportunity aşamalarında `probability`.
  - `PATCH /v1/custom-fields/{id}` (If-Match; etiket, zorunluluk, varsayılan, seçenekler, dizin, sıralama) ve `POST …/restore`. Anahtar, tür, ilişki hedefi ve formül sabittir. Bir kayıtta kullanılan seçenek kaldırılamaz (409 `CUSTOM_FIELD_OPTION_IN_USE`).
  - `PATCH /v1/sla/policies/{id}` (If-Match); çalışan saatler başladıkları bütçeyle sürer.
  - Göç `0010_settings.sql`: `custom_field_definitions.version`, `sla_policies.version` + `updated_at`. Arayüz yeteneği `authz.matrix.edit`.
- **Ayarlar alanı** (`/settings`): alt menü (masaüstünde sütun, telefonda kaydırılabilir satır); yalnızca yetkili ve modülü açık bölümler görünür. Okuma yetkisi olan ama değiştiremeyen kullanıcı salt okuma notu görür, düzenleme denetimleri çizilmez. Sunucu aynı kuralları 403 / 404 `MODULE_DISABLED` ile uygular.
- **İş akışı editörü:** durum diyagramı (kategori sütunları, eğri oklar, "her durumdan" geçişleri kesik çizgi) ve altında klavyeyle düzenlenen durum ve geçiş listeleri. Durum adı, kategori, renk token'ı, WIP sınırı, başlangıç durumu, sıra; geçiş adı, nereden/nereye, koşullar (sahip, roller), doğrulayıcılar (alt görevler kapalı, açık engelleyici yok) ve atama son işlemi. Motorun kuralları canlı uyarı olarak gösterilir. Kaydetmede kuru çalıştırma; kaldırılan durumda kayıt varsa eşleme iletişim kutusu.
- **Özel alan yöneticisi:** kayıt türü seçimi, alan ekleme (tür, ilişki hedefi, formül, seçenekler), düzenleme, sıralama, arşivleme (geri al toast'u) ve arşivden çıkarma.
- **Rol/izin matrisi:** modüle göre gruplu tablo (sabit başlık ve ilk sütun, arama). Hücre açılır kutusunda kip ve kapsam seçilir; bekleyen değişiklikler vurgulanır ve sayılır. Önizleme farkı ve not ile uygulanır. Sürüm geçmişinden eski sürüme dönülebilir.
- **Otomasyon kural oluşturucu:** üç adım (ne zaman → hangi kayıtlarda → ne yapılsın). Tetikleyiciye göre alan, durum, cron, SLA olayı seçimi; koşul için RQL filtre çubuğu; en çok 10 eylem. Hedef kayıt sahibi, kişi (dizin araması) veya atama politikası olabilir. Webhook eylemi yalnızca modül açıksa sunulur. Kural tanımının JSON görünümü ve son 20 çalıştırma.
- **Webhook ve API anahtarı:** olay seçici (gruplu, `kayıt.*` ve `*`), imza anahtarı yalnızca bir kez gösterilir. Yanıtı açma/kapama, anahtar yenileme, teslimat geçmişi ve yeniden gönderme, silme onayı. API anahtarında kapsam, son geçerlilik ve dakikalık sınır; anahtar bir kez gösterilir, iptal onaylıdır.
- **SLA ve takvim:** haftalık çalışma saatleri (gün başına birden çok aralık), tatiller, saat dilimi. Politikada RQL ölçütü, takvim, ilk yanıt ve çözüm hedefleri, uyarı eşiği, sıra, saatin durduğu durumlar ve açma/kapama.
- **Lighthouse** (`apps/web/scripts/lighthouse.mjs`, `lighthouse` 13): üretim imajı, mobil profil. Oturum gerçek giriş formuyla açılır; Lighthouse aynı tarayıcıda depolamayı sıfırlamadan ölçer. Sayfalar `/login`, `/`, `/tasks`, `/crm`, `/settings/workflows`. Eşik: performans ≥ 90, erişilebilirlik ≥ 95. CI'da e2e işinde çalışır; özet adım özetine ve `lighthouse-report/` ekine yazılır.
- **Ekran görüntüsü regresyonu** (`e2e/visual.spec.ts`, `scripts/e2e-visual.mjs`): giriş, gösterge paneli, Kanban ve iş akışı editörü; açık/koyu × masaüstü (1280) / mobil (375). Sabit Playwright Linux imajında çalışır; böylece CI ile her makinede aynı yazı tipleri kullanılır. Temel görüntüler `e2e/__screenshots__/` altında depodadır. `--update` ile yenilenir ve fark gözden geçirilerek commit edilir.

## 10. Kabul kriterleri ↔ testler (P6c)
| Kriter | Test |
|---|---|
| Workflow editörü (görsel durum makinesi) | E2E `settings.spec.ts`: durum ekle/kaldır, geçiş bağla, eşleme iletişim kutusu, kayıt taşındı; `settings.int.test.ts`: kuru çalıştırma, 409/412/428, anahtar sabit, olasılık |
| Custom field yöneticisi | E2E: oluştur, seçenek yeniden adlandır, arşivle + geri al; int: kullanılan seçenek korunur, sıralama, arşivden çıkarma |
| Rol/izin matrisi arayüzü | E2E: hücre değiştir → önizle → uygula → sürüme dön |
| Otomasyon kural oluşturucu | E2E: tetikleyici + RQL koşulu + eylem kaydedilir, kapatılır |
| Webhook ve API anahtarı yönetimi | E2E: webhook oluştur (anahtar bir kez), API anahtarı oluştur ve iptal et |
| SLA politikası ve çalışma takvimi | E2E: takvim (cumartesi açık), politika, açma/kapama; int: If-Match ve ölçüt doğrulaması |
| Yetkiye duyarlı | E2E: yönetici salt okuma, temsilci erişemez |
| Erişilebilirlik | E2E: her ayar ekranı ve iletişim kutusu için axe |
| Lighthouse: Performance ≥ 90, Accessibility ≥ 95 | `pnpm --filter @flexa/web lighthouse` (CI) |
| Açık/koyu tema ve mobilde görsel bozulma yok | `pnpm --filter @flexa/web e2e:visual` (CI, 16 temel görüntü) |
