# Görev listesi performansı (P2 + P4a yetki senaryoları)

> Üretildi: 2026-11-20T21:03:31.848Z · `pnpm --filter @flexa/api test:perf` · 10000 görev, senaryo başına 200 ardışık istek (10 ısınma isteği hariç).
> Ölçüm süreç içi (Fastify inject): kimlik doğrulama, tenant guard, RLS, RQL derleme, yetki kapsamı ve JSON serileştirme dahil; ağ gecikmesi hariç. PostgreSQL 18 kapsayıcıda.

| Senaryo | İstek | p50 (ms) | p95 (ms) | p99 (ms) | Hedef p95 < 200 ms |
|---|---|---|---|---|---|
| Admin, default sort (created desc), limit 50 | 200 | 24.7 | 34.8 | 40.9 | ✅ |
| Admin, RQL filter + sort by due (NULLS LAST) | 200 | 35.0 | 53.1 | 67.6 | ✅ |
| Admin, page 5 via cursor | 200 | 22.6 | 36.0 | 57.8 | ✅ |
| Admin, with total count | 200 | 51.5 | 93.2 | 106.6 | ✅ |
| Sales rep (own scope), default sort | 200 | 32.1 | 45.9 | 60.3 | ✅ |
| P4a Manager (team + rule + parent access), default sort | 200 | 33.2 | 56.5 | 70.0 | ✅ |
| P4a Manager, RQL filter + total count | 200 | 56.4 | 78.1 | 92.4 | ✅ |
| P4a Sales rep accounts (own + rule), with total count | 200 | 32.6 | 43.5 | 48.8 | ✅ |

## Ana liste sorgusunun planı (EXPLAIN ANALYZE)

```text
Limit (actual time=0.067..0.166 rows=51.00 loops=1)
  Buffers: shared hit=86
  ->  Nested Loop (actual time=0.066..0.161 rows=51.00 loops=1)
        Buffers: shared hit=86
        ->  Index Scan using tasks_list on tasks t (actual time=0.033..0.078 rows=51.00 loops=1)
              Index Cond: (tenant_id = 'fb57e433-ea8f-4a90-b4ae-08db0de18ac7'::uuid)
              Index Searches: 1
              Buffers: shared hit=54
        ->  Memoize (actual time=0.001..0.001 rows=1.00 loops=51)
              Cache Key: t.status_id
              Cache Mode: logical
              Hits: 35  Misses: 16  Evictions: 0  Overflows: 0  Memory Usage: 3kB
              Buffers: shared hit=32
              ->  Index Only Scan using statuses_tenant_id_id_key on statuses s (actual time=0.003..0.003 rows=1.00 loops=16)
                    Index Cond: ((tenant_id = 'fb57e433-ea8f-4a90-b4ae-08db0de18ac7'::uuid) AND (id = t.status_id))
                    Heap Fetches: 16
                    Index Searches: 16
                    Buffers: shared hit=32
Planning:
  Buffers: shared hit=446
Planning Time: 5.054 ms
Execution Time: 0.448 ms
```
