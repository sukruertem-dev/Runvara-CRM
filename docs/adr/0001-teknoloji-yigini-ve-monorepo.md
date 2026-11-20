# ADR-0001: Teknoloji yığını ve monorepo

- Durum: Önerildi · Tarih: 2026-11-20 · Kapsam: tümü

## Bağlam
Kaynak (Bölüm 3) yığını önerir ve iki seçeneği açık bırakır: NestJS **veya** Next.js route handler'ları; Drizzle **veya** Prisma. Sistem; API, arka plan işçileri, kalıcı santral bağlantıları tutan bir telefoni ağ geçidi ve iki ayrı web uygulamasından (tenant + operatör) oluşur.

## Karar
- **pnpm workspaces + Turborepo**, Node 24 LTS, TypeScript `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`.
- **API: NestJS 11 + Fastify adaptörü.** Gerekçe: modül sınırları (DI), guard/interceptor zinciri (tenant bağlamı, modül kapısı, yetki), aynı kodun `apps/worker` içinde `NestFactory.createApplicationContext` ile HTTP'siz çalışabilmesi. Next.js route handler'ları uzun ömürlü işçi ve telefoni bağlantıları için uygun değildir.
- **Web: Next.js (App Router)** yalnızca arayüz; iş mantığı içermez, API'yi çağırır (BFF yok; tek sözleşme kaynağı API).
- **Sözleşme:** `packages/contracts` içindeki Zod şemaları hem doğrulama hem OpenAPI 3.1 üretimi (`zod-openapi`) için tek kaynak; web istemcisi bu şemalardan tip üretir.
- **Test:** Vitest (birim + entegrasyon), Testcontainers (PostgreSQL 18, Redis 7), Playwright (E2E + axe), fast-check (property/fuzz), k6 (yük).
- **Kalite:** ESLint (flat config, `typescript-eslint` strict-type-checked), Prettier, lint-staged + husky, Conventional Commits (commitlint).
- **Gözlemlenebilirlik:** Pino (yapılandırılmış log, `tenant_id`, `request_id`, `user_id` alanları; kişisel veri redaksiyonu), OpenTelemetry SDK (HTTP, pg, ioredis, BullMQ enstrümantasyonu).

## Değerlendirilen alternatifler
| Alternatif | Neden seçilmedi |
|---|---|
| Next.js route handler'ları (tek uygulama) | İşçi/ağ geçidi için ayrı süreç yine gerekir; guard zinciri ve modül sınırları zayıf |
| Express | Fastify daha hızlı ve şema dostu; NestJS ikisini de destekler |
| Nx | Turborepo daha yalın; ihtiyaç duyulan görev önbelleği yeterli |

## Sonuçlar
- (+) API ve worker aynı servis katmanını paylaşır; çifte mantık yok.
- (+) Sözleşme tek kaynak → OpenAPI, istemci tipleri ve doğrulama tutarlı.
- (−) NestJS dekoratör/DI yükü; servisler saf TypeScript sınıfları tutularak `packages/*` içinde çerçeveden bağımsız kalır (alan mantığı Nest'e bağımlı değildir).
