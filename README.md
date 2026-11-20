# Flexa

Çok kiracılı CRM + görev yönetimi + B2B/B2C satış + çağrı merkezi + AI asistan platformu.
Gereksinimler: [`CRM_TASK_PLATFORM_PROMPT.md`](CRM_TASK_PLATFORM_PROMPT.md) · Mimari: [`docs/architecture.md`](docs/architecture.md) · Faz planı: [`docs/phase-plan.md`](docs/phase-plan.md) · Durum: [`docs/progress.md`](docs/progress.md)

## Gereksinimler
- Node.js 24+, pnpm 10 (`npm i -g pnpm@10.34.9` — yönetici izni gerekmez)
- Docker Desktop (Compose v2; testler Testcontainers kullanır)

## Hızlı başlangıç (Docker Compose, sıfırdan)
```bash
pnpm install
node scripts/dev-env.mjs          # .env: rastgele parolalar, ana anahtar, JWT anahtarı
docker compose up --build --wait  # postgres, redis, mailpit, migrate, api, worker, web
```
| Servis | Adres (varsayılan port) |
|---|---|
| Web | http://localhost:3000 |
| API + OpenAPI | http://localhost:4000 · `/docs` · `/openapi.json` · `/healthz` · `/readyz` |
| Mailpit (gelen e-postalar) | http://localhost:8025 |

Portlar başka bir projeyle çakışıyorsa `.env` içine `FLEXA_WEB_PORT`, `FLEXA_API_PORT`, `FLEXA_PG_PORT`, `FLEXA_REDIS_PORT`, `FLEXA_MAILPIT_PORT` yazın.

## Geliştirme komutları
```bash
pnpm build        # tüm paketler (turbo)
pnpm typecheck
pnpm lint
pnpm test         # birim testleri
pnpm test:int     # entegrasyon: PostgreSQL 18 + Redis 7 kapsayıcıları (Docker gerekir)
pnpm check        # kontrast raporu, yetki matrisi ve modül kataloğu doğrulaması
pnpm e2e          # Playwright; çalışan Compose yığınına karşı (E2E_BASE_URL, MAILPIT_URL)
```

## Depo yapısı
```text
apps/api        NestJS + Fastify REST API (auth, tenancy, modules, invitations, SSO)
apps/worker     BullMQ işçileri (e-posta)
apps/web        Next.js arayüz (P1: kimlik doğrulama ekranları)
packages/db     Şema, SQL migration'lar, RLS, withTenant/withUser/withAnonymous
packages/authz  Merkezi yetki kararı (permission-matrix.yaml'dan üretilir)
packages/modules Modül kataloğu, bağımlılık grafiği, modül kapısı
packages/security Parola (argon2id), JWT (EdDSA), TOTP, zarf şifreleme, CSRF
packages/contracts Zod sözleşmeleri, hata kodları, OpenAPI üretimi
packages/config Ortam değişkeni doğrulaması (Zod)
packages/ui     Tasarım token'ları (tokens.json → tokens.css)
docs/           ADR'ler, ER, API, olaylar, riskler, varsayımlar, izlenebilirlik
```

## Güvenlik kuralları (özet)
Tenant bağlamı yalnızca imzalı token'dan gelir; uygulama veritabanı rolü RLS'i atlayamaz; yetki kararı yalnızca `@flexa/authz` üzerinden verilir. Ayrıntı: [`CLAUDE.md`](CLAUDE.md), [`docs/adr/`](docs/adr/README.md).
