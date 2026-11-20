# ADR-0012: API sözleşmeleri (hata biçimi, sayfalama, idempotency, toplu işlem, sürüm)

- Durum: Önerildi · Tarih: 2026-11-20 · Kapsam: tümü · Gereksinimler: API-01…07

## Karar
- **Sürüm:** URL önekiyle `/v1`; Data Servisi bağımsız sürümlenir (`/dataservice/v1`). Geriye uyumsuz değişiklik yeni ana sürüm; eski sürüm en az 6 ay `Deprecation` + `Sunset` başlıklarıyla.
- **Hata biçimi:** RFC 9457 `application/problem+json`:
  ```json
  { "type": "https://docs.flexa.app/errors/WORKFLOW_TRANSITION_NOT_ALLOWED",
    "title": "Transition not allowed", "status": 422, "code": "WORKFLOW_TRANSITION_NOT_ALLOWED",
    "detail": "...", "instance": "/v1/tasks/…", "requestId": "…",
    "errors": [{ "path": "status_id", "code": "…", "message": "…" }] }
  ```
  Hata kodu kataloğu `packages/contracts/errors.ts` (tek kaynak, i18n mesaj anahtarı ile). 404'ler kayıt varlığını ayırt etmez.
- **Sayfalama:** cursor tabanlı. Yanıt `{ data: [], page: { nextCursor, hasMore }, meta?: { total? } }`. Cursor = sıralama anahtarlarının + `id`'nin base64url JSON'u, HMAC imzalı (istemci kurcalayamaz), sorgu parmak iziyle bağlı (farklı filtrede kullanılırsa 400). `limit` varsayılan 50, en fazla 200. `total` yalnızca `?count=true` ile ve yetki predicate'li `count(*)`; 100 binden büyükse `estimated: true` ile `EXPLAIN` tahmini.
- **Filtre / sıralama / alan seçimi:** `?q=<RQL>` veya `?filter=<JSON AST>`; `?sort=-due_at,priority`; `?fields=id,title,status` (FLS dışı alan istenirse sessizce düşmez → 400 `UNKNOWN_FIELD`, varlık sızdırmayan aynı mesajla); `?expand=owner,status` (en fazla 2 seviye).
- **İyimser kilit:** yanıtta `ETag: "<version>"`; PATCH/DELETE `If-Match` zorunlu (eksikse 428).
- **Idempotency-Key:** tüm POST'larda desteklenir, toplu ve dış entegrasyon uç noktalarında zorunlu. `idempotency_keys(tenant_id, principal_id, key, request_hash, status, response, expires_at)`; 24 saat. Aynı anahtar + farklı gövde → 422 `IDEMPOTENCY_KEY_REUSED`; işlem sürüyorsa 409.
- **Toplu işlem:** `POST /v1/<kaynak>:bulk` en fazla 1000 öğe; senkron (≤ 100) veya `202 + /v1/jobs/{id}` (asenkron, ilerleme SSE ile). Kısmi başarı: öğe başına sonuç dizisi; isteğe bağlı `atomic: true` (hepsi ya da hiçbiri). Her toplu işlem `bulk_operations` kaydı + undo bilgisi (Faz 6 undo için 10 dk).
- **Hız sınırı:** token bucket (Redis, kaygan pencere), anahtarlar: `ip`, `user`, `tenant`, `api_key`, `dataservice_client`; başlıklar `RateLimit-Policy`, `RateLimit` (IETF taslağı), 429 + `Retry-After`. Plan bazlı tenant sınırları (TEN-10).
- **Zaman:** tüm zamanlar ISO 8601 UTC (`Z`); kullanıcı saat dilimi yalnızca göreli tarih hesaplarında ve arayüzde.
- **OpenAPI 3.1:** `packages/contracts`'tan üretilir, `/docs` (Scalar arayüzü) ve `openapi.json`; CI'da yayınlanan şema ile kod farkı kontrolü; Bruno koleksiyonu üretilir (Faz 8).
- **GraphQL:** kapsam dışı (kaynak "isteğe bağlı" diyor); RQL + `expand` ihtiyacı karşılar.

## Sonuçlar
- (+) Tutarlı, makine okunur hatalar; istemci ve test üretimi kolay.
- (−) İmzalı cursor, sunucu anahtarı döndürmede eski cursor'ları geçersiz kılar (kabul edilebilir; istemci ilk sayfadan yeniler).
