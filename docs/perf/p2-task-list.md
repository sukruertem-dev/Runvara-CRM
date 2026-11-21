# Görev listesi performansı (P2 + P4a yetki senaryoları)

> Üretildi: 2026-11-21T07:03:14.315Z · `pnpm --filter @flexa/api test:perf` · 10000 görev, senaryo başına 200 ardışık istek (10 ısınma isteği hariç).
> Ölçüm süreç içi (Fastify inject): kimlik doğrulama, tenant guard, RLS, RQL derleme, yetki kapsamı ve JSON serileştirme dahil; ağ gecikmesi hariç. PostgreSQL 18 kapsayıcıda.

| Senaryo | İstek | p50 (ms) | p95 (ms) | p99 (ms) | Hedef p95 < 200 ms |
|---|---|---|---|---|---|
| Admin, default sort (created desc), limit 50 | 200 | 19.2 | 25.6 | 44.9 | ✅ |
| Admin, RQL filter + sort by due (NULLS LAST) | 200 | 35.4 | 70.0 | 93.8 | ✅ |
| Admin, page 5 via cursor | 200 | 21.9 | 29.5 | 34.2 | ✅ |
| Admin, with total count | 200 | 46.7 | 58.3 | 83.3 | ✅ |
| Sales rep (own scope), default sort | 200 | 30.1 | 39.0 | 44.7 | ✅ |
| P4a Manager (team + rule + parent access), default sort | 200 | 30.7 | 64.6 | 97.1 | ✅ |
| P4a Manager, RQL filter + total count | 200 | 55.9 | 74.0 | 84.5 | ✅ |
| P4a Sales rep accounts (own + rule), with total count | 200 | 32.9 | 41.8 | 45.8 | ✅ |

## Ana liste sorgusunun planı (EXPLAIN ANALYZE)

```text
Limit (actual time=0.066..0.152 rows=51.00 loops=1)
  Buffers: shared hit=86
  ->  Nested Loop (actual time=0.065..0.147 rows=51.00 loops=1)
        Buffers: shared hit=86
        ->  Index Scan using tasks_list on tasks t (actual time=0.034..0.082 rows=51.00 loops=1)
              Index Cond: (tenant_id = '8ef592f1-3304-4da5-8ad5-fd092cc1ad65'::uuid)
              Index Searches: 1
              Buffers: shared hit=54
        ->  Memoize (actual time=0.001..0.001 rows=1.00 loops=51)
              Cache Key: t.status_id
              Cache Mode: logical
              Hits: 35  Misses: 16  Evictions: 0  Overflows: 0  Memory Usage: 3kB
              Buffers: shared hit=32
              ->  Index Only Scan using statuses_tenant_id_id_key on statuses s (actual time=0.002..0.002 rows=1.00 loops=16)
                    Index Cond: ((tenant_id = '8ef592f1-3304-4da5-8ad5-fd092cc1ad65'::uuid) AND (id = t.status_id))
                    Heap Fetches: 16
                    Index Searches: 16
                    Buffers: shared hit=32
Planning:
  Buffers: shared hit=446
Planning Time: 3.763 ms
Execution Time: 0.272 ms
```
