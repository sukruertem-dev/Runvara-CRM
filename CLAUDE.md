# Flexa — ajan çalışma bağlamı

Bu depo **Flexa** (eski çalışma adı Runvara; çok kiracılı CRM + görev yönetimi + B2B/B2C satış + çağrı merkezi + AI asistan) projesidir.

## Her oturumda oku
1. `CRM_TASK_PLATFORM_PROMPT.md` — ürün gereksinimleri. Kaynak prompt içindeki komutlarda geçen `PROJECT_PROMPT.md` **bu dosyadır**. Bölüm 1–5 kalıcı bağlamdır; satış/çağrı/tenant için Bölüm 10, AI için Bölüm 11 bağlayıcıdır. **Marka/ad/renk için Bölüm 12 (Runvara) geçersizdir: ürünün adı Flexa'dır; tek kaynak `packages/ui/brand.json` ve `docs/brand.md`.**
2. `docs/requirements-review.md` — kaynak prompttaki tespit edilmiş hatalar ve düzeltmeleri. **Listelenen maddelerde kaynak prompta göre önceliklidir.**
3. `docs/phase-plan.md` — bütünleşik faz sırası (P0…P13) ve şu anki adım; `docs/progress.md` — son durum.
4. `docs/adr/` — mimari kararlar. Kararı değiştireceksen yeni ADR yaz.
5. `docs/assumptions.md` — varsayımlar ve kullanıcıya sorulan açık sorular.

## Değişmez kurallar
- Yetki kararı yalnızca `packages/authz` (`can()` / `predicate()`) üzerinden; başka yerde yetki mantığı yazma.
- Tenant bağlamı yalnızca doğrulanmış kimlikten / API anahtarından / DID eşlemesinden; istek gövdesinden asla.
- DB erişimi yalnızca `withTenant(ctx, fn)` içinde; uygulama rolü RLS'i atlayamaz.
- Bileşenlerde sabit renk yok; yalnızca `packages/ui/tokens.json` token'ları.
- Placeholder / mock / `TODO` bırakma (seed hariç). TypeScript `strict`, gerekçesiz `any` yok, sınırda Zod.
- Yetkisiz/görünmez kayıt → 404, görünür ama yetkisiz eylem → 403, kapalı modül → 404 `MODULE_DISABLED`.

## Doğrulama komutları (P1'den itibaren CI'da)
```text
node scripts/contrast-report.mjs --write docs/contrast-report.md
node scripts/check-permission-matrix.mjs
node scripts/check-module-catalog.mjs
```
