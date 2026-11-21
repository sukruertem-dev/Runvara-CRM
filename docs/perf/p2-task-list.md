# Görev listesi performansı (P2 + P4a yetki senaryoları)

> Üretildi: 2026-11-21T06:00:25.781Z · `pnpm --filter @flexa/api test:perf` · 10000 görev, senaryo başına 200 ardışık istek (10 ısınma isteği hariç).
> Ölçüm süreç içi (Fastify inject): kimlik doğrulama, tenant guard, RLS, RQL derleme, yetki kapsamı ve JSON serileştirme dahil; ağ gecikmesi hariç. PostgreSQL 18 kapsayıcıda.

| Senaryo | İstek | p50 (ms) | p95 (ms) | p99 (ms) | Hedef p95 < 200 ms |
|---|---|---|---|---|---|
| Admin, default sort (created desc), limit 50 | 200 | 34.2 | 72.2 | 83.6 | ✅ |
| Admin, RQL filter + sort by due (NULLS LAST) | 200 | 47.3 | 90.8 | 140.7 | ✅ |
| Admin, page 5 via cursor | 200 | 34.6 | 116.9 | 175.5 | ✅ |
| Admin, with total count | 200 | 67.0 | 138.6 | 251.0 | ✅ |
| Sales rep (own scope), default sort | 200 | 49.1 | 86.0 | 113.2 | ✅ |
| P4a Manager (team + rule + parent access), default sort | 200 | 49.5 | 98.1 | 140.4 | ✅ |
| P4a Manager, RQL filter + total count | 200 | 85.3 | 230.2 | 381.2 | ❌ |
| P4a Sales rep accounts (own + rule), with total count | 200 | 57.7 | 111.6 | 138.3 | ✅ |

## Ana liste sorgusunun planı (EXPLAIN ANALYZE)

```text
Limit (actual time=1.403..2.362 rows=51.00 loops=1)
  Buffers: shared hit=86
  ->  Nested Loop (actual time=1.401..2.356 rows=51.00 loops=1)
        Buffers: shared hit=86
        ->  Index Scan using tasks_list on tasks t (actual time=0.769..1.657 rows=51.00 loops=1)
              Index Cond: (tenant_id = '19dd687a-daf4-40ba-8f17-1647a87fb7cc'::uuid)
              Index Searches: 1
              Buffers: shared hit=54
        ->  Memoize (actual time=0.013..0.013 rows=1.00 loops=51)
              Cache Key: t.status_id
              Cache Mode: logical
              Hits: 35  Misses: 16  Evictions: 0  Overflows: 0  Memory Usage: 3kB
              Buffers: shared hit=32
              ->  Index Only Scan using statuses_tenant_id_id_key on statuses s (actual time=0.011..0.011 rows=1.00 loops=16)
                    Index Cond: ((tenant_id = '19dd687a-daf4-40ba-8f17-1647a87fb7cc'::uuid) AND (id = t.status_id))
                    Heap Fetches: 16
                    Index Searches: 16
                    Buffers: shared hit=32
Planning:
  Buffers: shared hit=446
Planning Time: 8.483 ms
Execution Time: 2.980 ms
```
