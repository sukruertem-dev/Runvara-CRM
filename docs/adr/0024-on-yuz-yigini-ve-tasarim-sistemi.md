# ADR-0024: Ön yüz yığını ve tasarım sistemi

- Durum: Kabul edildi · Tarih: 2026-11-21 · Kapsam: Faz 6 (P6a–P6c), G9 · Gereksinimler: §3 ön yüz yığını, §5.5, §10.5, Faz 6 kabul kriterleri

## Bağlam
P1–P5'te web uygulaması yalnızca kimlik doğrulama ekranlarını el yazımı CSS ile sunuyordu (requirements-review A3). Faz 6'nın görünümleri (sanal liste, Kanban, tablo, takvim, Gantt), komut paleti, erişilebilir açılır katmanlar ve bileşen dokümantasyonu bir bileşen kütüphanesi, bir durum/önbellek katmanı ve token'lardan üretilen bir yardımcı sınıf sistemi gerektirir. Kaynak §3 yığını önerir: Tailwind CSS, shadcn/ui, TanStack Query/Table, dnd-kit, Framer Motion.

## Karar
- **Stil: Tailwind CSS v4 (CSS-first).** `packages/ui/scripts/build-tokens.mjs`, `tokens.json`'dan iki dosya üretir:
  - `dist/tokens.css`: CSS değişkenleri. Açık tema `:root`'ta, koyu tema `[data-theme="dark"]` altında ve `prefers-color-scheme` ile.
  - `dist/theme.css`: Tailwind `@theme inline`. Renkler değişkene bağlanır (`--color-canvas: var(--bg-canvas)`), dolayısıyla tema değişimi sınıf değiştirmeden çalışır. Varsayılan palet `--color-*: initial` ile silinir; token dışı renk sınıfı derlenmez. Radius, font, metin ölçeği, boşluk, gölge ve hareket de token'dan gelir.
- **Bileşenler: shadcn/ui kalıbı.** Erişilebilir davranış Radix primitive'lerinden (`radix-ui`) gelir; kaynak kod `packages/ui/src` içindedir; stiller yalnızca token sınıflarıdır; varyantlar `class-variance-authority`, sınıf birleştirme `tailwind-merge` ile yapılır. shadcn CLI kullanılmaz; bileşenler ürünün token'larıyla doğrudan yazılır (tek kaynak kuralı).
  - Ek kütüphaneler: komut paleti `cmdk`, tarih seçici `react-day-picker`, zengin metin `@tiptap/react` (görev açıklaması zaten ProseMirror JSON), ikonlar `lucide-react` (modül kataloğundaki ikon adları lucide adlarıdır).
- **Paket sınırı.** `@flexa/ui` derleme gerektirmeyen TSX kaynağı dışa aktarır; Next `transpilePackages` ile derler. Uygulamaya özgü (API'ye bağlı) bileşenler `apps/web`'de kalır. `packages/ui` API'yi bilmez.
- **Veri: TanStack Query v5.** Sunucu durumunun tek önbelleği budur. Optimistic güncelleme `onMutate` + geri alma ile yapılır. SSE olayları sorgu anahtarlarını geçersiz kılar (ADR-0007). Global istemci durumu (tema, yoğunluk, segment) küçük bir React context + `localStorage`'dadır; durum kütüphanesi eklenmez.
- **Görünüm kütüphaneleri:**
  - `@tanstack/react-table` v8: tablo. v9 yeni bir major; ekosistemi oturunca değerlendirilir.
  - `@tanstack/react-virtual`: liste ve tablo sanallaştırma.
  - `@dnd-kit/core` + `sortable`: Kanban; fare, dokunma ve klavye sensörleriyle, ekran okuyucu duyurularıyla.
- **Hareket: `motion`** (Framer Motion'ın yeni paket adı). `MotionConfig reducedMotion="user"` kullanılır; token süreleri `prefers-reduced-motion`'da 0'dır.
- **Dokümantasyon: Storybook 10** (`@storybook/react-vite`, `addon-a11y`, `addon-docs`), `packages/ui` içinde. Araç çubuğunda tema ve yoğunluk seçilir. CI'da `build-storybook` derlenir.
- **Bileşen testleri:** Vitest + jsdom + Testing Library + `axe-core`. Uçtan uca testler Playwright + `@axe-core/playwright` ile mevcut düzende sürer.
- **Sürümler tam sabitlenir** (depo kuralı). Seçilen sürümler en az birkaç haftalık kararlı sürümlerdir.

## Sonuçlar
- (+) Renkler, boşluklar ve yarıçaplar tek kaynaktan gelir; token dışı renk ne lint'ten ne Tailwind derlemesinden geçer.
- (+) Açılır katmanlarda odak yönetimi ve ARIA Radix'ten gelir; özel kod yalnızca ürün davranışıdır.
- (−) Bağımlılık sayısı artar. Hepsi tek amaçlı ve yaygın paketlerdir; `pnpm` lockfile ile sabittir.
- (−) Tailwind sınıfları JSX'i uzatır. Tekrarlayan desenler bileşen varyantına taşınır.

## Kanıt
`packages/ui/src/**`, `packages/ui/.storybook/**`, `packages/ui/scripts/build-tokens.mjs`, `apps/web/app/globals.css`.
