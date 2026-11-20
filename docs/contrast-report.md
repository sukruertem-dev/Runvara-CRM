# Kontrast Raporu

> Otomatik üretildi: `node scripts/contrast-report.mjs --write docs/contrast-report.md`. Elle düzenlemeyin.
> Kaynak: `packages/ui/tokens.json` v1.0.0. Eşikler: metin ≥ 4.5:1, metin dışı ≥ 3:1 (WCAG 2.2 AA, 1.4.3 / 1.4.11).

**Sonuç:** GEÇTİ · 90 kontrol · 0 hata · tema paritesi tam

## Açık tema

| Ön plan | Zemin | Tür | Oran | Eşik | Durum |
|---|---|---|---|---|---|
| `--text-primary` #1A1B1F | `--bg-canvas` #F8F9FC | text | 16.34 | 4.5 | ✅ |
| `--text-primary` #1A1B1F | `--bg-surface` #FFFFFF | text | 17.21 | 4.5 | ✅ |
| `--text-primary` #1A1B1F | `--bg-subtle` #F0F1F6 | text | 15.25 | 4.5 | ✅ |
| `--text-primary` #1A1B1F | `--bg-raised` #FFFFFF | text | 17.21 | 4.5 | ✅ |
| `--text-secondary` #646B7E | `--bg-canvas` #F8F9FC | text | 5.05 | 4.5 | ✅ |
| `--text-secondary` #646B7E | `--bg-surface` #FFFFFF | text | 5.32 | 4.5 | ✅ |
| `--text-secondary` #646B7E | `--bg-subtle` #F0F1F6 | text | 4.72 | 4.5 | ✅ |
| `--text-secondary` #646B7E | `--bg-raised` #FFFFFF | text | 5.32 | 4.5 | ✅ |
| `--on-primary` #FFFFFF | `--primary` #7B3CFF | text | 5.34 | 4.5 | ✅ |
| `--on-accent` #FFFFFF | `--accent-btn` #7B3CFF | text | 5.34 | 4.5 | ✅ |
| `--on-accent` #FFFFFF | `--accent-btn-hover` #6A28F0 | text | 6.61 | 4.5 | ✅ |
| `--accent` #7B3CFF | `--bg-canvas` #F8F9FC | text | 5.07 | 4.5 | ✅ |
| `--accent` #7B3CFF | `--bg-surface` #FFFFFF | text | 5.34 | 4.5 | ✅ |
| `--accent` #7B3CFF | `--bg-raised` #FFFFFF | text | 5.34 | 4.5 | ✅ |
| `--accent` #7B3CFF | `--accent-soft` #F2ECFF | text | 4.63 | 4.5 | ✅ |
| `--accent-hover` #6A28F0 | `--bg-surface` #FFFFFF | text | 6.61 | 4.5 | ✅ |
| `--sidebar-text` #F8F9FC | `--sidebar-bg` #1A1B1F | text | 16.34 | 4.5 | ✅ |
| `--sidebar-muted` #B4BAC8 | `--sidebar-bg` #1A1B1F | text | 8.85 | 4.5 | ✅ |
| `--sidebar-on-active` #FFFFFF | `--sidebar-active` #7B3CFF | text | 5.34 | 4.5 | ✅ |
| `--sidebar-active` #7B3CFF | `--sidebar-bg` #1A1B1F | non-text (active item indicator) | 3.22 | 3 | ✅ |
| `--b2b` #2B2D31 | `--b2b-soft` #ECEDF2 | text | 11.80 | 4.5 | ✅ |
| `--b2b` #2B2D31 | `--bg-surface` #FFFFFF | text | 13.79 | 4.5 | ✅ |
| `--b2c` #7B3CFF | `--b2c-soft` #F2ECFF | text | 4.63 | 4.5 | ✅ |
| `--b2c` #7B3CFF | `--bg-surface` #FFFFFF | text | 5.34 | 4.5 | ✅ |
| `--success` #1E6B45 | `--success-soft` #E3F2EA | text | 5.60 | 4.5 | ✅ |
| `--success` #1E6B45 | `--bg-surface` #FFFFFF | text | 6.47 | 4.5 | ✅ |
| `--warning` #8A5A00 | `--warning-soft` #FFF2D6 | text | 5.34 | 4.5 | ✅ |
| `--warning` #8A5A00 | `--bg-surface` #FFFFFF | text | 5.93 | 4.5 | ✅ |
| `--danger` #B4232A | `--danger-soft` #FCE7E8 | text | 5.52 | 4.5 | ✅ |
| `--danger` #B4232A | `--bg-surface` #FFFFFF | text | 6.53 | 4.5 | ✅ |
| `--info` #2F5272 | `--info-soft` #E6EDF3 | text | 6.91 | 4.5 | ✅ |
| `--info` #2F5272 | `--bg-surface` #FFFFFF | text | 8.17 | 4.5 | ✅ |
| `--border-strong` #7D8599 | `--bg-surface` #FFFFFF | non-text | 3.69 | 3 | ✅ |
| `--border-strong` #7D8599 | `--bg-canvas` #F8F9FC | non-text | 3.51 | 3 | ✅ |
| `--border-strong` #7D8599 | `--bg-subtle` #F0F1F6 | non-text | 3.27 | 3 | ✅ |
| `--neutral` #8B93A7 | `--bg-surface` #FFFFFF | non-text | 3.07 | 3 | ✅ |
| `--accent` #7B3CFF | `--bg-surface` #FFFFFF | non-text (focus ring) | 5.34 | 3 | ✅ |
| `--spark` #7B3CFF | `--bg-surface` #FFFFFF | non-text (live/notification dot) | 5.34 | 3 | ✅ |
| `--chart-1` #7B3CFF | `--bg-surface` #FFFFFF | non-text | 5.34 | 3 | ✅ |
| `--chart-2` #2B2D31 | `--bg-surface` #FFFFFF | non-text | 13.79 | 3 | ✅ |
| `--chart-3` #8B93A7 | `--bg-surface` #FFFFFF | non-text | 3.07 | 3 | ✅ |
| `--chart-4` #9A6BFF | `--bg-surface` #FFFFFF | non-text | 3.55 | 3 | ✅ |
| `--chart-5` #4A1DB0 | `--bg-surface` #FFFFFF | non-text | 10.03 | 3 | ✅ |
| `--on-primary` #FFFFFF | `--primary` #7B3CFF | button:primary | 5.34 | 4.5 | ✅ |
| `--on-accent` #FFFFFF | `--accent-btn` #7B3CFF | button:accent | 5.34 | 4.5 | ✅ |

## Koyu tema

| Ön plan | Zemin | Tür | Oran | Eşik | Durum |
|---|---|---|---|---|---|
| `--text-primary` #F8F9FC | `--bg-canvas` #1A1B1F | text | 16.34 | 4.5 | ✅ |
| `--text-primary` #F8F9FC | `--bg-surface` #2B2D31 | text | 13.10 | 4.5 | ✅ |
| `--text-primary` #F8F9FC | `--bg-subtle` #24262A | text | 14.40 | 4.5 | ✅ |
| `--text-primary` #F8F9FC | `--bg-raised` #34363C | text | 11.47 | 4.5 | ✅ |
| `--text-secondary` #B4BAC8 | `--bg-canvas` #1A1B1F | text | 8.85 | 4.5 | ✅ |
| `--text-secondary` #B4BAC8 | `--bg-surface` #2B2D31 | text | 7.09 | 4.5 | ✅ |
| `--text-secondary` #B4BAC8 | `--bg-subtle` #24262A | text | 7.79 | 4.5 | ✅ |
| `--text-secondary` #B4BAC8 | `--bg-raised` #34363C | text | 6.21 | 4.5 | ✅ |
| `--on-primary` #FFFFFF | `--primary` #7B3CFF | text | 5.34 | 4.5 | ✅ |
| `--on-accent` #FFFFFF | `--accent-btn` #7B3CFF | text | 5.34 | 4.5 | ✅ |
| `--on-accent` #FFFFFF | `--accent-btn-hover` #6A28F0 | text | 6.61 | 4.5 | ✅ |
| `--accent` #C9A8FF | `--bg-canvas` #1A1B1F | text | 8.63 | 4.5 | ✅ |
| `--accent` #C9A8FF | `--bg-surface` #2B2D31 | text | 6.92 | 4.5 | ✅ |
| `--accent` #C9A8FF | `--bg-raised` #34363C | text | 6.05 | 4.5 | ✅ |
| `--accent` #C9A8FF | `--accent-soft` #33294A | text | 6.76 | 4.5 | ✅ |
| `--accent-hover` #DCC6FF | `--bg-surface` #2B2D31 | text | 8.91 | 4.5 | ✅ |
| `--sidebar-text` #F8F9FC | `--sidebar-bg` #141518 | text | 17.34 | 4.5 | ✅ |
| `--sidebar-muted` #B4BAC8 | `--sidebar-bg` #141518 | text | 9.39 | 4.5 | ✅ |
| `--sidebar-on-active` #FFFFFF | `--sidebar-active` #7B3CFF | text | 5.34 | 4.5 | ✅ |
| `--sidebar-active` #7B3CFF | `--sidebar-bg` #141518 | non-text (active item indicator) | 3.42 | 3 | ✅ |
| `--b2b` #D0D4DE | `--b2b-soft` #3A3D44 | text | 7.33 | 4.5 | ✅ |
| `--b2b` #D0D4DE | `--bg-surface` #2B2D31 | text | 9.30 | 4.5 | ✅ |
| `--b2c` #C9A8FF | `--b2c-soft` #33294A | text | 6.76 | 4.5 | ✅ |
| `--b2c` #C9A8FF | `--bg-surface` #2B2D31 | text | 6.92 | 4.5 | ✅ |
| `--success` #4ADE9A | `--success-soft` #1F3329 | text | 7.81 | 4.5 | ✅ |
| `--success` #4ADE9A | `--bg-surface` #2B2D31 | text | 8.02 | 4.5 | ✅ |
| `--warning` #FFC247 | `--warning-soft` #3A3020 | text | 8.04 | 4.5 | ✅ |
| `--warning` #FFC247 | `--bg-surface` #2B2D31 | text | 8.58 | 4.5 | ✅ |
| `--danger` #FF8A80 | `--danger-soft` #3D2624 | text | 6.13 | 4.5 | ✅ |
| `--danger` #FF8A80 | `--bg-surface` #2B2D31 | text | 6.04 | 4.5 | ✅ |
| `--info` #8AB4E0 | `--info-soft` #22303D | text | 6.22 | 4.5 | ✅ |
| `--info` #8AB4E0 | `--bg-surface` #2B2D31 | text | 6.36 | 4.5 | ✅ |
| `--border-strong` #8B93A7 | `--bg-surface` #2B2D31 | non-text | 4.49 | 3 | ✅ |
| `--border-strong` #8B93A7 | `--bg-canvas` #1A1B1F | non-text | 5.60 | 3 | ✅ |
| `--border-strong` #8B93A7 | `--bg-subtle` #24262A | non-text | 4.93 | 3 | ✅ |
| `--neutral` #8B93A7 | `--bg-surface` #2B2D31 | non-text | 4.49 | 3 | ✅ |
| `--accent` #C9A8FF | `--bg-surface` #2B2D31 | non-text (focus ring) | 6.92 | 3 | ✅ |
| `--spark` #B68CFF | `--bg-surface` #2B2D31 | non-text (live/notification dot) | 5.38 | 3 | ✅ |
| `--chart-1` #B68CFF | `--bg-surface` #2B2D31 | non-text | 5.38 | 3 | ✅ |
| `--chart-2` #F8F9FC | `--bg-surface` #2B2D31 | non-text | 13.10 | 3 | ✅ |
| `--chart-3` #8B93A7 | `--bg-surface` #2B2D31 | non-text | 4.49 | 3 | ✅ |
| `--chart-4` #9A6BFF | `--bg-surface` #2B2D31 | non-text | 3.89 | 3 | ✅ |
| `--chart-5` #DCC6FF | `--bg-surface` #2B2D31 | non-text | 8.91 | 3 | ✅ |
| `--on-primary` #FFFFFF | `--primary` #7B3CFF | button:primary | 5.34 | 4.5 | ✅ |
| `--on-accent` #FFFFFF | `--accent-btn` #7B3CFF | button:accent | 5.34 | 4.5 | ✅ |
