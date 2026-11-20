# ADR-0019: Status sistemi ve workflow motoru (durum makinesi)

- Durum: Önerildi · Tarih: 2026-11-20 · Kapsam: Faz 2 (task), Faz 3 (CRM), G4/G5 (pipeline, sipariş) · Gereksinimler: DM-03, DM-04

## Karar
- `statuses(tenant_id, resource_type, workflow_id, key, label_i18n, category ∈ {open, in_progress, closed}, color_token, position, is_initial)`. `is_closed` = `category = 'closed'` (türetilir, saklanmaz). Renk yalnızca token adı (`--success` vb.), hex değil.
- `workflows(tenant_id, resource_type, key, version, segment NULL, published_at)`; bir kaynak tipinin aynı anda tek **yayımlanmış** sürümü; kayıtlar başladıkları sürüme bağlı kalır (`workflow_version`), yeni sürüm yayımlanınca eski durumlar eşleme tablosuyla taşınır (yayım sihirbazı, kuru çalıştırma).
- `workflow_transitions(workflow_id, from_status_id NULL (= herhangi), to_status_id, key, conditions jsonb, validators jsonb, post_functions jsonb, required_permission)`.
  - **conditions:** kim geçiş yapabilir (rol, izin, sahip mi, ekip üyesi mi) + kayıt koşulu (RQL alt kümesi, AST olarak saklanır).
  - **validators:** zorunlu alanlar, alan değer koşulu, alt görevlerin kapalı olması, ilişkili kayıt koşulu; başarısızlıkta 422 `WORKFLOW_VALIDATION_FAILED` + alan listesi.
  - **post_functions:** deklaratif aksiyonlar (alan set et, atama, yorum ekle) + `emit` → olay; Faz 5'te otomasyon motoru aynı aksiyon kütüphanesini kullanır (tek kod).
- Geçiş API'si: `POST /v1/{resource}/{id}:transition {transitionKey | toStatusId, fields?}`; doğrudan `PATCH status_id` **reddedilir** (409 `USE_TRANSITION_ENDPOINT`). Tanımsız geçiş → 422 `WORKFLOW_TRANSITION_NOT_ALLOWED` (izin verilen geçiş listesiyle).
- Geçiş tek transaction: koşul → validator → durum güncelleme → post-function'lar → `activity_events` + `outbox (…status_changed)`.
- Pipeline aşamaları (opportunity) aynı motorun özel kullanımıdır: aşama = status, `probability` aşama özniteliği, giriş koşulları = validators.

## Sonuçlar
Status ve geçişler tamamen yapılandırma; enum hardcode yok. Sistem kategorileri sabit olduğu için raporlar (açık/kapalı) tenant etiketinden bağımsız çalışır.
