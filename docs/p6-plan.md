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
