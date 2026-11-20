# Flexa Marka Kimliği

> 2026-11-20 · Ürün adı **Runvara → Flexa** olarak değiştirildi. Tek kaynak: [`packages/ui/brand.json`](../packages/ui/brand.json) (Flexa brand v1.0.0). Bu doküman, kaynak prompttaki **Bölüm 12'nin (Runvara) ve Bölüm 10.5'in renk/logo kurallarının yerini alır**. Bölüm 10.5'in kullanım ilkeleri (renk tek başına anlam taşımaz, segment rozeti ikon + etiket, hata ≠ marka rengi, `prefers-reduced-motion`, yoğunluk modları) aynen geçerlidir.

## 1. Ad ve ses
| Alan | Karar |
|---|---|
| Ürün adı | **Flexa** |
| Slogan | **İşini Tek Platformda Yönet** (EN: *Run your business on one platform*) |
| Kişilik | Modern · Profesyonel · Yenilikçi · Modüler · Premium |
| Teknik ön ek | Paketler `@flexa/…`, DB rolleri `flexa_owner / flexa_app / flexa_relay`, ortam değişkenleri `FLEXA_…`, çerezler `fx_rt`, `fx_csrf`, API anahtarı `fx_live_…` |

> Alan adı, marka tescili (TÜRKPATENT / EUIPO / WIPO, sınıf 9-35-38-42) ve npm/GitHub ad kontrolü **yapılmadı** (risk R-21 Flexa için geçerli; "Flexa" yaygın bir addır, çakışma olasılığı yüksektir).

## 2. Logo
- Konsept: katmanlı kurdele biçiminde **F** sembolü; birincil düzen sembol + "Flexa" yazısı; ikon düzeni yalnızca sembol.
- Yazı rengi: açık zeminde `#1A1B1F`, koyu zeminde `#F8F9FC`.
- **Resmi logo çizimi depoya henüz eklenmedi.** Kural gereği ("Do not invent or modify the official logo artwork") sembol çizilmedi; arayüz şimdilik yalnızca **yazı markası** (Inter 700) kullanır ve eski Runvara işareti kaldırıldı. Resmi SVG'ler gelince `packages/brand/` altına konur: `flexa-symbol.svg`, `flexa-logo-light.svg`, `flexa-logo-dark.svg`, favicon/PWA ikonları.

## 3. Renkler → token'lar (erişilebilirlik ayarlarıyla)
Token'ların tek kaynağı [`packages/ui/tokens.json`](../packages/ui/tokens.json); kontrol raporu [`docs/contrast-report.md`](contrast-report.md) (90/90 kontrol geçer).

| Marka rengi | Hex | Kullanım (token) |
|---|---|---|
| primary | `#7B3CFF` | `--primary`, `--accent`, `--accent-btn`, `--sidebar-active`, `--b2c` (açık) — beyaz metinle 5.34:1, beyaz zeminde metin olarak 5.34:1 |
| primaryLight | `#B68CFF` | koyu temada grafik serisi 1, `--spark` (koyu) |
| lavender | `#F2ECFF` | `--accent-soft`, `--b2c-soft` (açık) |
| surface | `#F8F9FC` | `--bg-canvas` (açık), `--sidebar-text` |
| charcoal | `#2B2D31` | `--b2b`, `--bg-surface` (koyu), grafik serisi 2 |
| charcoalDark | `#1A1B1F` | `--text-primary`, `--sidebar-bg` (açık), `--bg-canvas` (koyu) |
| neutralGray | `#8B93A7` | `--neutral`: **yalnızca metin dışı** öğeler (ikon, grafik, ayraç), koyu temada `--border-strong` |
| white | `#FFFFFF` | `--bg-surface` (açık), `--on-primary` |
| kart kenarı | `#E7E7EF` | `--border` (dekoratif) |

**Erişilebilirlik için yapılan ayarlar** (JSON'daki "Ensure accessible text contrast" talimatı gereği):
| Konu | JSON değeri | Sorun | Uygulanan |
|---|---|---|---|
| İkincil metin | `#8B93A7` | beyazda 3.07:1, `#F8F9FC`'de 2.92:1 (metin için < 4.5) | `--text-secondary: #646B7E` (aynı ton ailesi, 5.05:1); `#8B93A7` metin dışında `--neutral` olarak korunur |
| Girdi/kontrol kenarı | (tanımsız) | `#E7E7EF` 1.23:1 (bileşen sınırı için < 3) | `--border-strong: #7D8599` (≥ 3:1) |
| Hover tonları | (tanımsız) | — | `--accent-hover` / `--accent-btn-hover: #6A28F0` (beyazla 6.61:1) |
| Koyu tema | JSON yalnız açık tema tanımlar | parite kuralı (her token iki temada) | koyu tema charcoal/charcoalDark tabanlı, mor bağlantı `#C9A8FF` (6.05:1), buton yine `#7B3CFF` |
| Hata rengi | — | mor marka rengiyle karışmasın | `--danger: #B4232A` (ayrı token, her zaman ikon + metin) |

## 4. Tipografi ve şekil
- Yazı tipi **Inter** (başlık 700, gövde 400, buton 600); rakamlarda `tabular-nums`. Ölçek 12/14/16/20/24/32/44.
- Radius: buton **10px**, kart **14px**, girdi 8px, hero 20px. Kart kenarı `--border`.

## 5. Arayüz düzeni
- **Koyu antrasit yan menü** (`--sidebar-bg`, metin `--sidebar-text`, ikincil `--sidebar-muted`), **açık içerik alanı** (`--bg-canvas`, kartlar `--bg-surface`).
- Mor yalnızca **ana eylemler** ve **aktif gezinme** için (`--sidebar-active` + `--sidebar-on-active`); geniş yüzeyler nötr.
- Tüm modüller tek tasarım sistemi altında; modüller arayüzde işlev adlarıyla gösterilir (CRM, Görev yönetimi, Satış operasyonları …).
