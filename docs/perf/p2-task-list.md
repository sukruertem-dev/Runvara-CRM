# P2 — Görev listesi performansı

> Üretildi: 2026-11-20T20:04:53.351Z · `pnpm --filter @flexa/api test:perf` · 10000 görev, senaryo başına 200 ardışık istek (10 ısınma isteği hariç).
> Ölçüm süreç içi (Fastify inject): kimlik doğrulama, tenant guard, RLS, RQL derleme, yetki kapsamı ve JSON serileştirme dahil; ağ gecikmesi hariç. PostgreSQL 18 kapsayıcıda.

| Senaryo | İstek | p50 (ms) | p95 (ms) | p99 (ms) | Hedef p95 < 200 ms |
|---|---|---|---|---|---|
| Admin, default sort (created desc), limit 50 | 200 | 18.3 | 24.9 | 32.0 | ✅ |
| Admin, RQL filter + sort by due (NULLS LAST) | 200 | 28.6 | 40.2 | 48.1 | ✅ |
| Admin, page 5 via cursor | 200 | 18.3 | 23.4 | 27.4 | ✅ |
| Admin, with total count | 200 | 31.4 | 51.0 | 60.4 | ✅ |
| Sales rep (own scope), default sort | 200 | 17.8 | 27.7 | 40.0 | ✅ |

## Ana liste sorgusunun planı (EXPLAIN ANALYZE)

```text
Limit (actual time=0.057..0.122 rows=51.00 loops=1)
  Buffers: shared hit=86
  ->  Nested Loop (actual time=0.056..0.118 rows=51.00 loops=1)
        Buffers: shared hit=86
        ->  Index Scan using tasks_list on tasks t (actual time=0.032..0.057 rows=51.00 loops=1)
              Index Cond: (tenant_id = '8e61c8ef-d1d5-447c-b550-996b255a82f1'::uuid)
              Index Searches: 1
              Buffers: shared hit=54
        ->  Memoize (actual time=0.001..0.001 rows=1.00 loops=51)
              Cache Key: t.status_id
              Cache Mode: logical
              Hits: 35  Misses: 16  Evictions: 0  Overflows: 0  Memory Usage: 3kB
              Buffers: shared hit=32
              ->  Index Only Scan using statuses_tenant_id_id_key on statuses s (actual time=0.002..0.002 rows=1.00 loops=16)
                    Index Cond: ((tenant_id = '8e61c8ef-d1d5-447c-b550-996b255a82f1'::uuid) AND (id = t.status_id))
                    Heap Fetches: 16
                    Index Searches: 16
                    Buffers: shared hit=32
Planning:
  Buffers: shared hit=452
Planning Time: 2.933 ms
Execution Time: 0.272 ms
```
