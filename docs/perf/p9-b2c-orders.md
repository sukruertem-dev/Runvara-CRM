# B2C sipariş listesi performansı (P9f, AC-G5-4)

> Üretildi: 2026-11-28T07:01:36.892Z · `pnpm --filter @flexa/api test:perf` · 100000 sipariş, 5000 müşteri, senaryo başına 200 ardışık istek (10 ısınma isteği hariç).
> Ölçüm süreç içi (Fastify inject): kimlik doğrulama, tenant guard, RLS, müşteriden türeyen kayıt kapsamı ve JSON serileştirme dahil; ağ gecikmesi hariç. PostgreSQL 18 kapsayıcıda.

| Senaryo | İstek | p50 (ms) | p95 (ms) | p99 (ms) | Hedef p95 < 200 ms |
|---|---|---|---|---|---|
| Admin, newest first, limit 50 | 200 | 22.5 | 32.5 | 39.7 | ✅ |
| Admin, status = delivered | 200 | 20.7 | 26.8 | 31.7 | ✅ |
| Admin, channel = phone and status = new | 200 | 63.5 | 77.4 | 90.4 | ✅ |
| Admin, one customer (customer 360) | 200 | 18.5 | 21.4 | 22.6 | ✅ |
| Admin, page 5 via cursor | 200 | 19.3 | 24.0 | 30.0 | ✅ |
| Sales rep (own customers), newest first | 200 | 34.0 | 40.3 | 44.0 | ✅ |
| Sales rep, status = new | 200 | 29.8 | 40.2 | 47.0 | ✅ |

## Ana liste sorgusunun planı (EXPLAIN ANALYZE)

```text
Limit (actual time=0.100..0.268 rows=51.00 loops=1)
  Buffers: shared hit=159
  ->  Nested Loop (actual time=0.099..0.261 rows=51.00 loops=1)
        Buffers: shared hit=159
        ->  Index Scan Backward using orders_pkey on orders o (actual time=0.020..0.045 rows=51.00 loops=1)
              Filter: ((tenant_id = 'd41438a4-0bcb-43e3-8311-1365e289d03b'::uuid) AND (segment = 'b2c'::segment))
              Index Searches: 1
              Buffers: shared hit=6
        ->  Memoize (actual time=0.004..0.004 rows=1.00 loops=51)
              Cache Key: o.customer_id
              Cache Mode: logical
              Hits: 0  Misses: 51  Evictions: 0  Overflows: 0  Memory Usage: 8kB
              Buffers: shared hit=153
              ->  Index Scan using contacts_pkey on contacts t (actual time=0.002..0.002 rows=1.00 loops=51)
                    Index Cond: (id = o.customer_id)
                    Filter: ((deleted_at IS NULL) AND (tenant_id = 'd41438a4-0bcb-43e3-8311-1365e289d03b'::uuid))
                    Index Searches: 51
                    Buffers: shared hit=153
Planning:
  Buffers: shared hit=478
Planning Time: 2.785 ms
Execution Time: 0.351 ms
```

## Durum süzgeçli sorgunun planı

```text
Limit (actual time=0.174..0.315 rows=51.00 loops=1)
  Buffers: shared hit=161
  ->  Nested Loop (actual time=0.173..0.309 rows=51.00 loops=1)
        Buffers: shared hit=161
        ->  Index Scan Backward using orders_pkey on orders o (actual time=0.039..0.085 rows=51.00 loops=1)
              Filter: ((tenant_id = 'd41438a4-0bcb-43e3-8311-1365e289d03b'::uuid) AND (segment = 'b2c'::segment) AND (status = 'delivered'::text))
              Rows Removed by Filter: 85
              Index Searches: 1
              Buffers: shared hit=8
        ->  Memoize (actual time=0.004..0.004 rows=1.00 loops=51)
              Cache Key: o.customer_id
              Cache Mode: logical
              Hits: 0  Misses: 51  Evictions: 0  Overflows: 0  Memory Usage: 8kB
              Buffers: shared hit=153
              ->  Index Scan using contacts_pkey on contacts t (actual time=0.001..0.001 rows=1.00 loops=51)
                    Index Cond: (id = o.customer_id)
                    Filter: ((deleted_at IS NULL) AND (tenant_id = 'd41438a4-0bcb-43e3-8311-1365e289d03b'::uuid))
                    Index Searches: 51
                    Buffers: shared hit=153
Planning:
  Buffers: shared hit=481
Planning Time: 2.996 ms
Execution Time: 0.372 ms
```

## Uygulama rolüyle (RLS, parametreli) aynı sorgu

```text
Nested Loop (actual time=85.723..86.122 rows=51.00 loops=1)
  Buffers: shared hit=115834
  CTE page
    ->  Limit (actual time=85.628..85.637 rows=51.00 loops=1)
          Buffers: shared hit=115375
          ->  Sort (actual time=85.626..85.631 rows=51.00 loops=1)
                Sort Key: o_1.id DESC
                Sort Method: top-N heapsort  Memory: 26kB
                Buffers: shared hit=115375
                ->  Nested Loop (actual time=0.338..81.754 rows=37500.00 loops=1)
                      Buffers: shared hit=115375
                      ->  Bitmap Heap Scan on contacts t_1 (actual time=0.313..4.529 rows=5000.00 loops=1)
                            Recheck Cond: (segments && COALESCE((NULLIF(current_setting('app.segments'::text, true), ''::text))::segment[], '{}'::segment[]))
                            Filter: ((deleted_at IS NULL) AND (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid))
                            Heap Blocks: exact=112
                            Buffers: shared hit=127
                            ->  Bitmap Index Scan on contacts_segments (actual time=0.289..0.289 rows=5000.00 loops=1)
                                  Index Cond: (segments && COALESCE((NULLIF(current_setting('app.segments'::text, true), ''::text))::segment[], '{}'::segment[]))
                                  Index Searches: 1
                                  Buffers: shared hit=15
                      ->  Index Scan using orders_customer on orders o_1 (actual time=0.004..0.014 rows=7.50 loops=5000)
                            Index Cond: ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid) AND (customer_id = t_1.id))
                            Filter: ((status = 'delivered'::text) AND (segment = ANY (COALESCE((NULLIF(current_setting('app.segments'::text, true), ''::text))::segment[], '{}'::segment[]))) AND (segment = 'b2c'::segment))
                            Rows Removed by Filter: 12
                            Index Searches: 5000
                            Buffers: shared hit=115248
  ->  Nested Loop (actual time=85.701..86.009 rows=51.00 loops=1)
        Buffers: shared hit=115732
        ->  Nested Loop (actual time=85.683..85.843 rows=51.00 loops=1)
              Buffers: shared hit=115579
              ->  CTE Scan on page (actual time=85.631..85.659 rows=51.00 loops=1)
                    Storage: Memory  Maximum Storage: 18kB
                    Buffers: shared hit=115375
              ->  Index Scan using orders_pkey on orders o (actual time=0.003..0.003 rows=1.00 loops=51)
                    Index Cond: (id = page.id)
                    Filter: ((tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid) AND (segment = ANY (COALESCE((NULLIF(current_setting('app.segments'::text, true), ''::text))::segment[], '{}'::segment[]))))
                    Index Searches: 51
                    Buffers: shared hit=204
        ->  Index Scan using contacts_pkey on contacts t (actual time=0.003..0.003 rows=1.00 loops=51)
              Index Cond: (id = o.customer_id)
              Filter: ((segments && COALESCE((NULLIF(current_setting('app.segments'::text, true), ''::text))::segment[], '{}'::segment[])) AND (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid))
              Index Searches: 51
              Buffers: shared hit=153
  ->  Index Scan using users_pkey on users u (actual time=0.002..0.002 rows=1.00 loops=51)
        Index Cond: (id = o.created_by)
        Filter: ((id = (NULLIF(current_setting('app.user_id'::text, true), ''::text))::uuid) OR (ANY (id = (hashed SubPlan 3).col1)))
        Index Searches: 51
        Buffers: shared hit=102
        SubPlan 3
          ->  Bitmap Heap Scan on memberships m (never executed)
                Recheck Cond: (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)
                ->  Bitmap Index Scan on memberships_pkey (never executed)
                      Index Cond: (tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)
                      Index Searches: 0
Planning:
  Buffers: shared hit=28
Planning Time: 1.261 ms
Execution Time: 86.340 ms
```
