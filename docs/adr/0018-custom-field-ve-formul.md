# ADR-0018: Custom field saklama, indeksleme ve formül değerlendirici

- Durum: Önerildi · Tarih: 2026-11-20 · Kapsam: Faz 2–3 · Gereksinimler: DM-05

## Karar: JSONB (EAV değil)
- Tanım: `custom_field_definitions(tenant_id, resource_type, key, type, label_i18n, required, default, options jsonb, relation_target, formula, indexed, segment NULL, position, archived_at)`; `key` değişmez (`cf_` öneki, `[a-z0-9_]{1,48}`).
- Değer: kayıttaki `custom jsonb NOT NULL DEFAULT '{}'`. Yazma doğrulaması: tanımlardan üretilen Zod şeması (tip, zorunluluk, seçenek üyeliği, ilişki hedefinin var olması + okuma yetkisi); bilinmeyen anahtar reddedilir.
- Tip eşlemesi: text → string (≤ 10 000), number → JSON number (numeric olarak karşılaştırılır), date → ISO tarih string, select → seçenek `id`, multi-select → `id[]`, user → uuid, relation → `{type,id}` (`record_registry` ile doğrulanır, ama FK değil; silmede değer temizleme işi), formula → saklanmaz (okuma anında hesaplanır) veya `materialized: true` ise yazmada hesaplanır.
- **İndeksleme:** tablo başına `GIN (custom jsonb_path_ops)` (eşitlik/içerme). `indexed: true` alanlar için worker `CREATE INDEX CONCURRENTLY idx_<tablo>_<tenant8>_<key> ON <tablo> ((custom->>'<key>')::<tip>) WHERE tenant_id = '<tenant>'` (tenant'a özel kısmi ifade indeksi); tenant başına en fazla 20 indeksli alan (plan).
- Silme: tanım arşivlenir, değerler korunur; kalıcı silme arka plan işiyle `custom - key`.

## Formül değerlendirici (`packages/formula`)
- Kendi küçük dili: aritmetik, karşılaştırma, `IF`, `AND/OR/NOT`, `ROUND`, `ABS`, `MIN/MAX`, `COALESCE`, `DAYS_BETWEEN`, `TODAY`, `CONCAT`, `LEN`; alan referansı `{amount}`, `{custom.cf_x}`.
- Uygulama: Pratt ayrıştırıcı → AST → **saf yorumlayıcı** (eval/Function yok, prototip erişimi yok); en fazla 500 düğüm, 1 ms bütçe, sıfıra bölme `null`.
- Formüller arası bağımlılık döngüsü tanım kaydında reddedilir (topolojik sıralama).
- RQL'de formül alanı filtrelenebilir yalnızca `materialized: true` ise.

## Alternatifler
EAV: esnek ama her filtrede self-join ve tip kaybı; JSONB + seçici ifade indeksleri daha hızlı ve basit.
