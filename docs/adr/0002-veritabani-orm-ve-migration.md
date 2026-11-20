# ADR-0002: Veritabanı, ORM ve migration stratejisi

- Durum: Önerildi · Tarih: 2026-11-20 · Kapsam: Faz 1 ve sonrası

## Bağlam
RLS, `SET LOCAL` bağlam değişkenleri, trigger'lar (audit değiştirilemezliği, polimorfik bütünlük), ifade indeksleri ve FTS yoğun kullanılacak. ORM bu SQL'i gizlememeli, aksine kolay yazılmasını sağlamalı.

## Karar
- **PostgreSQL 18.** Gerekçe: yerel `uuidv7()` (zaman sıralı birincil anahtar; B-tree yerleşimi ve cursor sayfalama için kararlı sıra), olgun RLS, JSONB, `pg_trgm`, `unaccent`, ICU collation.
- **Drizzle ORM**: tip güvenli sorgu oluşturucu + `sql` şablonuyla parametreli ham SQL. Yetki predicate'leri ve RQL derleyicisi `SQL` parçaları üretir ve doğrudan birleştirilir.
- **Migration'lar elle yazılmış SQL dosyalarıdır** (`packages/db/migrations/NNNN_ad.sql`), `drizzle-kit generate` yalnızca şema farkını önermek için kullanılır. Gerekçe: RLS politikaları, trigger'lar, `SECURITY DEFINER` fonksiyonlar ve `CREATE INDEX CONCURRENTLY` drizzle-kit tarafından ifade edilemez.
- Migration koşucusu: kendi küçük koşucumuz (`packages/db/migrate.ts`), `schema_migrations` tablosu, her dosya kendi transaction'ında; `CONCURRENTLY` içeren dosyalar `-- no-transaction` başlığıyla işaretlenir.
- **Geri alma:** her migration için ileri-uyumlu strateji (expand → migrate → contract). Yıkıcı değişiklik (DROP) ayrı ve sonraki sürüm migration'ıdır. `down` dosyası yazılmaz; geri alma = önceki uygulama sürümü + uyumlu şema (runbook, Faz 8).
- **Ortak sütunlar** (tüm iş tabloları): `id uuid DEFAULT uuidv7()`, `tenant_id uuid NOT NULL`, `created_at`, `updated_at`, `created_by`, `updated_by`, `deleted_at` (soft delete olan tablolarda), `version int` (iyimser kilit; `If-Match` ile).
- **Bağlantı havuzu:** `pg` + uygulama başına havuz; PgBouncer transaction modunda uyumlu (yalnızca `SET LOCAL` kullanıldığı için).

## Alternatifler
| Alternatif | Neden seçilmedi |
|---|---|
| Prisma | RLS için her istekte etkileşimli transaction + `$executeRaw` gerekir; ham SQL birleştirme ve ifade indeksleri zayıf |
| PostgreSQL 17 + uygulama tarafı UUIDv7 | Çalışır; ancak PG18 yerel desteği varken ek bağımlılık gereksiz |
| Kysely | İyi bir seçenek; Drizzle'ın şema-tipi çıkarımı ve ekosistemi tercih edildi |

## Sonuçlar
- (+) Güvenlik açısından kritik SQL (RLS, trigger) gözden geçirilebilir düz SQL dosyalarında.
- (−) Şema tanımı (Drizzle TS) ile SQL migration'ın uyumu CI'da `drizzle-kit check` + şema dökümü karşılaştırmasıyla doğrulanmalı (Faz 1 görevi).
