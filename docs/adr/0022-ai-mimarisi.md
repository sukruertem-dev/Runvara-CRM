# ADR-0022: AI asistan mimarisi (çerçeve; model seçimi G11'de)

- Durum: Önerildi (çerçeve) · Tarih: 2026-11-20 · Kapsam: G11–G13 · Gereksinimler: AIP-*, AIG-*, 11.2.3

## Karar (bu fazda bağlayıcı olanlar)
1. **Model seçilmedi.** Kaynak açıkça G11 başında güncel araştırma ister. G11'de `docs/adr/0023-ai-model-secimi.md` yazılır (lisans, Türkçe eval, bağlam, donanım, tarihli kaynaklar).
2. **LLM Gateway** (`packages/ai-gateway`): `complete(req)` / `stream(req)` iç arayüzü, OpenAI uyumlu adaptör (Ollama, vLLM, llama.cpp sunucusu, BYO uç nokta), isteğe bağlı dış sağlayıcı adaptörü **varsayılan kapalı**. Zaman aşımı, retry, devre kesici, token bütçesi, tenant kotası gateway'de.
3. **Hat:** yetki motoru → deterministik veri toplayıcı (RQL + rapor motoru; araçlar salt okuma) → temizleyici (FLS, PII maskeleme, `<data>` bloğu, bütçe) → gateway → doğrulayıcı (sayı eşleşmesi, kaynak kimliği, yasaklı içerik) → çıktı. Model DB'ye ve araçlara **yazma** erişimi olmadan çalışır.
4. **Sayılar:** model çıktısı metrikleri yalnızca `{{metric:key}}` yer tutucularıyla referans verir; değerler motor çıktısından sunucuda yerleştirilir. Doğrulayıcı serbest sayısal ifadeyi motor değerleriyle karşılaştırır; uyuşmazlık → anlatı reddedilir, fallback.
5. **Saklama:** `ai_requests` yalnızca üst veri; ham istem/yanıt sütunu **yok**; hata ayıklama kaydı yalnızca tenant Admin onayıyla, süreli ve maskeli ayrı tabloda (`ai_debug_captures`, varsayılan devre dışı, TTL 72 saat).
6. **Önbellek anahtarı:** `tenant + user + authzHash + tür + dönem + parametre hash + model sürümü`. `authzHash` = AuthzContext'in kanonik özeti (sürüm numaraları dahil).
7. **Dağıtım:** Compose `ai` profili (CPU: Ollama; GPU: vLLM) — G11'de ölçüm (`docs/ai/sizing.md`).
8. **Kill switch:** platform (`platform_flags.ai_enabled`) ve tenant (`ai_tenant_settings.enabled`) bayrakları her istek/iş başında okunur (Redis 5 sn önbellek; değişimde silme).
