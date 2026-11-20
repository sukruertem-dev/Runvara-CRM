# P2 — Görev listesi performansı

> Üretildi: 2026-11-20T18:58:02.945Z · `pnpm --filter @flexa/api test:perf` · 10000 görev, senaryo başına 200 ardışık istek (10 ısınma isteği hariç).
> Ölçüm süreç içi (Fastify inject): kimlik doğrulama, tenant guard, RLS, RQL derleme, yetki kapsamı ve JSON serileştirme dahil; ağ gecikmesi hariç. PostgreSQL 18 kapsayıcıda.

| Senaryo | İstek | p50 (ms) | p95 (ms) | p99 (ms) | Hedef p95 < 200 ms |
|---|---|---|---|---|---|
| Admin, default sort (created desc), limit 50 | 200 | 20.2 | 32.0 | 36.2 | ✅ |
| Admin, RQL filter + sort by due (NULLS LAST) | 200 | 22.5 | 30.3 | 37.0 | ✅ |
| Admin, page 5 via cursor | 200 | 18.3 | 30.6 | 35.3 | ✅ |
| Admin, with total count | 200 | 28.0 | 51.8 | 76.2 | ✅ |
| Sales rep (own scope), default sort | 200 | 19.7 | 32.9 | 38.9 | ✅ |

## Ana liste sorgusunun planı (EXPLAIN ANALYZE)

```text
Limit (actual time=0.607..0.654 rows=51.00 loops=1)
  Buffers: shared hit=12
  ->  Nested Loop (actual time=0.605..0.648 rows=51.00 loops=1)
        Buffers: shared hit=12
        ->  Index Scan using tasks_list on tasks t (actual time=0.041..0.051 rows=51.00 loops=1)
              Index Cond: (tenant_id = '3c2c2429-d32d-42be-9fce-ac3bdb78acc4'::uuid)
              Index Searches: 1
              Buffers: shared hit=4
        ->  Memoize (actual time=0.011..0.011 rows=1.00 loops=51)
              Cache Key: t.status_id
              Cache Mode: logical
              Hits: 47  Misses: 4  Evictions: 0  Overflows: 0  Memory Usage: 1kB
              Buffers: shared hit=8
              ->  Index Only Scan using statuses_tenant_id_id_key on statuses s (actual time=0.133..0.133 rows=1.00 loops=4)
                    Index Cond: ((tenant_id = '3c2c2429-d32d-42be-9fce-ac3bdb78acc4'::uuid) AND (id = t.status_id))
                    Heap Fetches: 4
                    Index Searches: 4
                    Buffers: shared hit=8
Planning:
  Buffers: shared hit=451
Planning Time: 7.166 ms
Execution Time: 1.077 ms
```
