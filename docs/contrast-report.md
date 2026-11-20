# Kontrast Raporu

> Otomatik üretildi: `node scripts/contrast-report.mjs --write docs/contrast-report.md`. Elle düzenlemeyin.
> Kaynak: `packages/ui/tokens.json` v0.1.0. Eşikler: metin ≥ 4.5:1, metin dışı ≥ 3:1 (WCAG 2.2 AA, 1.4.3 / 1.4.11).

**Sonuç:** GEÇTİ · 79 kontrol · 0 hata · tema paritesi tam

## Açık tema

| Ön plan | Zemin | Tür | Oran | Eşik | Durum |
|---|---|---|---|---|---|
| `--text-primary` #2B2D31 | `--bg-canvas` #F4F1EA | text | 12.23 | 4.5 | ✅ |
| `--text-primary` #2B2D31 | `--bg-surface` #FFFFFF | text | 13.79 | 4.5 | ✅ |
| `--text-primary` #2B2D31 | `--bg-subtle` #ECE8DF | text | 11.28 | 4.5 | ✅ |
| `--text-primary` #2B2D31 | `--bg-raised` #FFFFFF | text | 13.79 | 4.5 | ✅ |
| `--text-secondary` #5C5F66 | `--bg-canvas` #F4F1EA | text | 5.67 | 4.5 | ✅ |
| `--text-secondary` #5C5F66 | `--bg-surface` #FFFFFF | text | 6.40 | 4.5 | ✅ |
| `--text-secondary` #5C5F66 | `--bg-subtle` #ECE8DF | text | 5.23 | 4.5 | ✅ |
| `--text-secondary` #5C5F66 | `--bg-raised` #FFFFFF | text | 6.40 | 4.5 | ✅ |
| `--on-primary` #F4F1EA | `--primary` #2B2D31 | text | 12.23 | 4.5 | ✅ |
| `--on-accent` #FFFFFF | `--accent-btn` #C8102E | text | 5.88 | 4.5 | ✅ |
| `--on-accent` #FFFFFF | `--accent-btn-hover` #9E0C24 | text | 8.29 | 4.5 | ✅ |
| `--accent` #C8102E | `--bg-canvas` #F4F1EA | text | 5.22 | 4.5 | ✅ |
| `--accent` #C8102E | `--bg-surface` #FFFFFF | text | 5.88 | 4.5 | ✅ |
| `--accent` #C8102E | `--bg-raised` #FFFFFF | text | 5.88 | 4.5 | ✅ |
| `--accent` #C8102E | `--accent-soft` #FBE7E9 | text | 4.96 | 4.5 | ✅ |
| `--b2b` #3A3C41 | `--b2b-soft` #E6E4DF | text | 8.69 | 4.5 | ✅ |
| `--b2b` #3A3C41 | `--bg-surface` #FFFFFF | text | 11.04 | 4.5 | ✅ |
| `--b2c` #C8102E | `--b2c-soft` #FBE7E9 | text | 4.96 | 4.5 | ✅ |
| `--b2c` #C8102E | `--bg-surface` #FFFFFF | text | 5.88 | 4.5 | ✅ |
| `--success` #1E6B45 | `--success-soft` #E3F2EA | text | 5.60 | 4.5 | ✅ |
| `--success` #1E6B45 | `--bg-surface` #FFFFFF | text | 6.47 | 4.5 | ✅ |
| `--warning` #8A5A00 | `--warning-soft` #FFF2D6 | text | 5.34 | 4.5 | ✅ |
| `--warning` #8A5A00 | `--bg-surface` #FFFFFF | text | 5.93 | 4.5 | ✅ |
| `--danger` #9B1B1F | `--danger-soft` #FBE3E1 | text | 6.68 | 4.5 | ✅ |
| `--danger` #9B1B1F | `--bg-surface` #FFFFFF | text | 8.17 | 4.5 | ✅ |
| `--info` #2F5272 | `--info-soft` #E6EDF3 | text | 6.91 | 4.5 | ✅ |
| `--info` #2F5272 | `--bg-surface` #FFFFFF | text | 8.17 | 4.5 | ✅ |
| `--border-strong` #7E8187 | `--bg-surface` #FFFFFF | non-text | 3.91 | 3 | ✅ |
| `--border-strong` #7E8187 | `--bg-canvas` #F4F1EA | non-text | 3.46 | 3 | ✅ |
| `--border-strong` #7E8187 | `--bg-subtle` #ECE8DF | non-text | 3.19 | 3 | ✅ |
| `--accent` #C8102E | `--bg-surface` #FFFFFF | non-text (focus ring) | 5.88 | 3 | ✅ |
| `--spark` #E63946 | `--bg-surface` #FFFFFF | non-text (live/notification dot) | 4.17 | 3 | ✅ |
| `--chart-1` #2B2D31 | `--bg-surface` #FFFFFF | non-text | 13.79 | 3 | ✅ |
| `--chart-2` #C8102E | `--bg-surface` #FFFFFF | non-text | 5.88 | 3 | ✅ |
| `--chart-3` #7E8187 | `--bg-surface` #FFFFFF | non-text | 3.91 | 3 | ✅ |
| `--chart-4` #D9545D | `--bg-surface` #FFFFFF | non-text | 3.91 | 3 | ✅ |
| `--chart-5` #7A0A1C | `--bg-surface` #FFFFFF | non-text | 11.12 | 3 | ✅ |
| `--on-primary` #F4F1EA | `--primary` #2B2D31 | button:primary | 12.23 | 4.5 | ✅ |
| `--on-accent` #FFFFFF | `--accent-btn` #C8102E | button:accent | 5.88 | 4.5 | ✅ |

## Koyu tema

| Ön plan | Zemin | Tür | Oran | Eşik | Durum |
|---|---|---|---|---|---|
| `--text-primary` #F4F1EA | `--bg-canvas` #1C1D20 | text | 14.94 | 4.5 | ✅ |
| `--text-primary` #F4F1EA | `--bg-surface` #25272B | text | 13.26 | 4.5 | ✅ |
| `--text-primary` #F4F1EA | `--bg-subtle` #2E3035 | text | 11.71 | 4.5 | ✅ |
| `--text-primary` #F4F1EA | `--bg-raised` #2E3035 | text | 11.71 | 4.5 | ✅ |
| `--text-secondary` #B9B5AC | `--bg-canvas` #1C1D20 | text | 8.24 | 4.5 | ✅ |
| `--text-secondary` #B9B5AC | `--bg-surface` #25272B | text | 7.31 | 4.5 | ✅ |
| `--text-secondary` #B9B5AC | `--bg-subtle` #2E3035 | text | 6.46 | 4.5 | ✅ |
| `--text-secondary` #B9B5AC | `--bg-raised` #2E3035 | text | 6.46 | 4.5 | ✅ |
| `--on-primary` #1C1D20 | `--primary` #F4F1EA | text | 14.94 | 4.5 | ✅ |
| `--on-accent` #F4F1EA | `--accent-btn` #C8102E | text | 5.22 | 4.5 | ✅ |
| `--on-accent` #F4F1EA | `--accent-btn-hover` #A50D26 | text | 6.93 | 4.5 | ✅ |
| `--accent` #FF6B70 | `--bg-canvas` #1C1D20 | text | 6.09 | 4.5 | ✅ |
| `--accent` #FF6B70 | `--bg-surface` #25272B | text | 5.41 | 4.5 | ✅ |
| `--accent` #FF6B70 | `--bg-raised` #2E3035 | text | 4.77 | 4.5 | ✅ |
| `--accent` #FF6B70 | `--accent-soft` #3A2326 | text | 5.24 | 4.5 | ✅ |
| `--accent-hover` #FF8A8E | `--bg-surface` #25272B | text | 6.61 | 4.5 | ✅ |
| `--b2b` #D4D0C7 | `--b2b-soft` #34363B | text | 7.86 | 4.5 | ✅ |
| `--b2b` #D4D0C7 | `--bg-surface` #25272B | text | 9.72 | 4.5 | ✅ |
| `--b2c` #FF6B70 | `--b2c-soft` #3A2326 | text | 5.24 | 4.5 | ✅ |
| `--b2c` #FF6B70 | `--bg-surface` #25272B | text | 5.41 | 4.5 | ✅ |
| `--success` #4ADE9A | `--success-soft` #1F3329 | text | 7.81 | 4.5 | ✅ |
| `--success` #4ADE9A | `--bg-surface` #25272B | text | 8.70 | 4.5 | ✅ |
| `--warning` #FFC247 | `--warning-soft` #3A3020 | text | 8.04 | 4.5 | ✅ |
| `--warning` #FFC247 | `--bg-surface` #25272B | text | 9.30 | 4.5 | ✅ |
| `--danger` #FF8A80 | `--danger-soft` #3D2624 | text | 6.13 | 4.5 | ✅ |
| `--danger` #FF8A80 | `--bg-surface` #25272B | text | 6.55 | 4.5 | ✅ |
| `--info` #8AB4E0 | `--info-soft` #22303D | text | 6.22 | 4.5 | ✅ |
| `--info` #8AB4E0 | `--bg-surface` #25272B | text | 6.90 | 4.5 | ✅ |
| `--border-strong` #80838A | `--bg-surface` #25272B | non-text | 3.94 | 3 | ✅ |
| `--border-strong` #80838A | `--bg-canvas` #1C1D20 | non-text | 4.44 | 3 | ✅ |
| `--border-strong` #80838A | `--bg-subtle` #2E3035 | non-text | 3.48 | 3 | ✅ |
| `--accent` #FF6B70 | `--bg-surface` #25272B | non-text (focus ring) | 5.41 | 3 | ✅ |
| `--spark` #E63946 | `--bg-surface` #25272B | non-text (live/notification dot) | 3.59 | 3 | ✅ |
| `--chart-1` #D4D0C7 | `--bg-surface` #25272B | non-text | 9.72 | 3 | ✅ |
| `--chart-2` #FF6B70 | `--bg-surface` #25272B | non-text | 5.41 | 3 | ✅ |
| `--chart-3` #8A8D93 | `--bg-surface` #25272B | non-text | 4.50 | 3 | ✅ |
| `--chart-4` #E8858C | `--bg-surface` #25272B | non-text | 5.82 | 3 | ✅ |
| `--chart-5` #F2B8BC | `--bg-surface` #25272B | non-text | 8.80 | 3 | ✅ |
| `--on-accent` #F4F1EA | `--accent-btn` #C8102E | button:primary | 5.22 | 4.5 | ✅ |
| `--on-accent` #F4F1EA | `--accent-btn` #C8102E | button:accent | 5.22 | 4.5 | ✅ |
