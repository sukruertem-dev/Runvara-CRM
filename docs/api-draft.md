# API Taslağı (v1)

> Faz 0 + G0 · 2026-11-20. Sözleşme kuralları ADR-0012'dedir (RFC 9457 hata, imzalı cursor, `If-Match`, `Idempotency-Key`, toplu işlem, hız sınırı). Kesin şema Faz 1'den itibaren `packages/contracts` Zod tanımlarından üretilen OpenAPI 3.1'dir; bu doküman kaynak listesi ve davranış sözleşmesidir.
> Her uç nokta: **modül kapısı** (kapalı → 404 `MODULE_DISABLED`) → **kimlik** → **`can()`/predicate** (görünmez → 404, görünür ama yetkisiz → 403) → FLS maskesi.

## 1. Ortak sözleşmeler

### Liste yanıtı
```http
GET /v1/tasks?q=status%20%3D%20open%20AND%20owner%20%3D%20me()&sort=-due_at&fields=id,title,due_at,status&expand=status&limit=50&cursor=eyJ...
200 OK
{ "data": [ { "id": "0193…", "title": "…", "due_at": "2026-11-21T09:00:00Z", "status": { "id": "…", "key": "open", "category": "open", "label": "Açık" } } ],
  "page": { "nextCursor": "eyJ…", "hasMore": true } }
```

### Hata yanıtı
```http
422 Unprocessable Content
Content-Type: application/problem+json
{ "type": "https://docs.runvara.app/errors/WORKFLOW_TRANSITION_NOT_ALLOWED", "title": "Transition not allowed",
  "status": 422, "code": "WORKFLOW_TRANSITION_NOT_ALLOWED", "requestId": "req_…",
  "detail": "No transition from 'Kapalı' to 'Açık'.", "allowed": ["reopen"] }
```

### Temel hata kodları (ilk katalog)
| HTTP | code | Ne zaman |
|---|---|---|
| 400 | `VALIDATION_FAILED`, `RQL_SYNTAX`, `UNKNOWN_FIELD`, `CURSOR_INVALID` | Girdi |
| 401 | `UNAUTHENTICATED`, `TOKEN_EXPIRED`, `MFA_REQUIRED` | Kimlik |
| 402 | `QUOTA_EXCEEDED` | Sert kota |
| 403 | `FORBIDDEN`, `MANAGER_LIMIT`, `READ_ONLY_IMPERSONATION` | Görünür ama yetkisiz |
| 404 | `NOT_FOUND`, `MODULE_DISABLED` | Yok / görünmez / modül kapalı |
| 409 | `VERSION_CONFLICT`, `IDEMPOTENCY_IN_PROGRESS`, `USE_TRANSITION_ENDPOINT` | Eşzamanlılık |
| 412 / 428 | `PRECONDITION_FAILED` / `PRECONDITION_REQUIRED` | `If-Match` |
| 422 | `WORKFLOW_TRANSITION_NOT_ALLOWED`, `WORKFLOW_VALIDATION_FAILED`, `DEPENDENCY_CYCLE`, `SUBTASK_DEPTH_EXCEEDED`, `MENTION_TARGET_NO_ACCESS`, `CONSENT_REQUIRED`, `CALLING_HOURS`, `DNC_LISTED`, `MODULE_DEPENDENCY_UNMET`, `MODULE_HAS_DEPENDENTS`, `CONFIG_SCHEMA_VIOLATION`, `CONFIG_KEY_NOT_OVERRIDABLE`, `BRAND_CONTRAST_UNSATISFIABLE`, `APPROVAL_LIMIT_EXCEEDED`, `IDEMPOTENCY_KEY_REUSED`, `LEAD_ALREADY_CONVERTED` | İş kuralı |
| 429 | `RATE_LIMITED` | Hız sınırı |
| 504 | `UPSTREAM_TIMEOUT` | Data Servisi bütçe aşımı |

## 2. Kaynaklar

### Kimlik ve oturum (Faz 1)
| Yöntem | Yol | Not |
|---|---|---|
| POST | `/v1/auth/signup` | Self-servis: kullanıcı + tenant (trial) + blueprint seçimi |
| POST | `/v1/auth/login` | → `mfa_required` veya token; birden çok tenant → `tenants[]` |
| POST | `/v1/auth/mfa/verify` | TOTP / kurtarma kodu |
| POST | `/v1/auth/tenant` | Tenant seçimi → erişim token'ı |
| POST | `/v1/auth/refresh` | Çerez + CSRF; rotasyon |
| POST | `/v1/auth/logout` | Aile iptali |
| POST | `/v1/auth/password/forgot`, `/v1/auth/password/reset`, `/v1/auth/email/verify` | Tek kullanımlık token |
| GET/POST | `/v1/auth/oidc/{provider}/start`, `/callback` | PKCE |
| POST/DELETE | `/v1/me/mfa` | TOTP kurulum/kaldırma |
| GET | `/v1/me`, `/v1/me/navigation`, `/v1/me/permissions` | Etkin modüller + yetkiye göre menü |
| POST | `/v1/invitations`, `/v1/invitations/{token}:accept` | Davet |

### Tenant, modül, yapılandırma (G1)
| Yöntem | Yol | Not |
|---|---|---|
| GET/PATCH | `/v1/tenant` | Ad, dil, saat dilimi, para birimi |
| POST | `/v1/tenant:transition` | Yaşam döngüsü (Admin: yalnızca `pending_deletion` başlat/iptal) |
| GET | `/v1/modules` | Katalog + durum + bağımlılık + plan hakkı |
| POST | `/v1/modules/{id}:enable`, `/v1/modules/{id}:disable` | Bağımlılık doğrulaması, `?cascade=true` |
| PUT | `/v1/tenant/sales-mode` | `b2b_only|b2c_only|both`; etkilenen sayılarla önizleme `?dryRun=true` |
| GET | `/v1/config/{key}` | Birleştirilmiş değer + katman kaynağı |
| POST | `/v1/config/{key}:preview` | Doğrulama + JSON Patch diff |
| PUT | `/v1/config/{key}?scope=tenant|team:{id}|user` | `If-Match` |
| GET | `/v1/config/{key}/versions`, POST `/v1/config/{key}/versions/{v}:restore` | Geri alma |
| GET | `/v1/blueprints`; POST `/v1/blueprints/{id}:apply?dryRun=` | Kuru çalıştırma |
| GET/POST | `/v1/config:export`, `/v1/config:import?dryRun=` | Çakışma raporu |
| PUT | `/v1/tenant/branding` | Logo + renk → türetilmiş token önizlemesi / ret |
| GET | `/v1/tenant/usage`, `/v1/tenant/quotas` | Kullanım |
| POST | `/v1/tenant:export`, `/v1/privacy-requests` | KVKK/GDPR |
| GET/POST | `/v1/support-access` , `/v1/support-access/{id}:approve|revoke` | Operatör erişimi onayı |

**Operatör API'si** (ayrı alan adı, ayrı kimlik): `/operator/v1/tenants`, `/operator/v1/tenants/{id}:transition`, `/operator/v1/tenants/{id}/plan`, `/operator/v1/support-access` (talep).

### Yetki, ekip, kuyruk (Faz 4 + G2)
| Yöntem | Yol | Not |
|---|---|---|
| GET/POST/PATCH | `/v1/roles`, `/v1/roles/{id}` | Sistem rolü korumalı |
| GET | `/v1/authz/matrix?version=` | Kapalı modül satırları yok |
| POST | `/v1/authz/matrix:preview` | Diff + **etkilenen kullanıcılar** |
| PUT | `/v1/authz/matrix` | Yeni sürüm; `If-Match` |
| POST | `/v1/authz/matrix/versions/{v}:restore` | |
| GET/PUT | `/v1/users/{id}/entitlements` | Segment, kapsam, telefoni, export (Yönetici sınırları) |
| POST | `/v1/delegations`, `/v1/delegations/{id}:revoke` | Tarihli |
| POST | `/v1/access-requests`; `/v1/access-requests/{id}:decide` | Talep akışı |
| GET/POST/PATCH | `/v1/teams`, `/v1/teams/{id}/members` | |
| GET/POST | `/v1/queues`, `/v1/queues/{id}/members` | `kind=work|call` |
| GET/POST | `/v1/field-policies` | FLS |
| GET/POST | `/v1/sharing-rules`; POST `/v1/{resource}/{id}/shares` | Manuel paylaşım |
| POST | `/v1/authz/impersonate` | Admin, salt okuma, 15 dk, audit |

### Görev çekirdeği (Faz 2)
| Yöntem | Yol | Not |
|---|---|---|
| GET/POST | `/v1/tasks` | RQL, cursor, alan seçimi |
| GET/PATCH/DELETE | `/v1/tasks/{id}` | Soft delete |
| POST | `/v1/tasks/{id}:restore`, `/v1/tasks/{id}:transition`, `/v1/tasks/{id}:move` | `move` = konum (fractional) + opsiyonel status geçişi |
| POST | `/v1/tasks:bulk` | ≤ 1000, undo bilgisi |
| GET/POST/DELETE | `/v1/tasks/{id}/dependencies` | Döngü → 422 `DEPENDENCY_CYCLE` |
| GET | `/v1/tasks/{id}/subtasks` | İlerleme yüzdesi |
| GET/POST/PATCH | `/v1/task-series` | RRULE |
| GET/POST/PATCH | `/v1/workflows`, `/v1/workflows/{id}:publish` | Yayım sihirbazı (`dryRun`) |
| GET/POST/PATCH | `/v1/statuses` | Kategori sabit |
| GET/POST/PATCH | `/v1/custom-fields` | Tanım API'si |
| POST | `/v1/rql:validate` | Otomatik tamamlama ve hata konumu (arayüz filtre çubuğu) |
| GET | `/v1/rql/fields?resource=` | Kullanıcının görebildiği alanlar (FLS) |

### CRM (Faz 3)
`/v1/leads`, `/v1/accounts`, `/v1/contacts`, `/v1/opportunities`, `/v1/cases`, `/v1/notes`, `/v1/products`, `/v1/price-lists`, `/v1/pipelines` (CRUD + RQL + bulk). Ek:
| Yöntem | Yol | Not |
|---|---|---|
| POST | `/v1/leads/{id}:convert` | Tek transaction; `Idempotency-Key` zorunlu |
| POST | `/v1/opportunities/{id}:transition` | Aşama; olasılık türetme |
| GET | `/v1/accounts/{id}/contacts`, `/opportunities`, `/cases`, `/tasks` | İlişkili kayıtlar (predicate'li) |
| GET | `/v1/{resource}/{id}/timeline` | `activity_events` + yorum + not + çağrı (segment rozetli) |
| GET | `/v1/{resource}/{id}/duplicates` | Mükerrer adayları |
| POST | `/v1/{resource}:merge` | Survivor + alan seçimi |

### Timeline, yorum, dosya, audit, mention, bildirim (Faz 4, G6)
| Yöntem | Yol | Not |
|---|---|---|
| GET/POST/PATCH/DELETE | `/v1/{resource}/{id}/comments` | Mention doğrulaması |
| POST | `/v1/{resource}/{id}/activities` | E-posta/arama logu (manuel/API) |
| POST | `/v1/attachments:initiate`, `/v1/attachments/{id}:complete`; GET `/v1/attachments/{id}/download` | İmzalı URL |
| GET | `/v1/audit?q=` | Admin; Yönetici ekip filtresi |
| GET | `/v1/mentions/candidates?record=type:id&q=` | **Yalnızca erişimi olanlar** |
| GET | `/v1/notifications?filter=mentioned|unread` | Okuma anı yetki |
| POST | `/v1/notifications/{id}:read`, `/v1/notifications:read-all` | Çok cihaz senkron |
| GET/PUT | `/v1/me/notification-preferences` | DND |
| POST/DELETE | `/v1/me/push-subscriptions` | Web push |
| GET | `/v1/stream` | **SSE**, `Last-Event-ID` |

### Otomasyon, SLA, webhook, API anahtarı (Faz 5)
`/v1/automations` (CRUD, `:test` kuru çalıştırma, `/runs`), `/v1/automations/dlq` (`:replay`), `/v1/sla/policies`, `/v1/calendars`, `/v1/webhooks` (`/deliveries`, `:rotate-secret`, `:test`), `/v1/api-keys`, `/v1/jobs/{id}`.

### Satış çekirdeği, B2B, B2C (G3–G5)
| Önek | Kaynaklar |
|---|---|
| `/v1/approvals` | Gelen kutusu, `:decide` (toplu), kurallar `/v1/approval-rules` |
| `/v1/targets` | Hedef tanımı ve gerçekleşme |
| `/v1/sales/b2b` | `/quotes` (+ `/versions`, `:submit`, `:send`, `/pdf`), `/contracts`, `/forecast` (+ `:snapshot`, `:adjust`), `/orders` |
| `/v1/sales/b2c` | `/customers` (360: `/{id}/overview`), `/orders` (+ `:transition`, `:bulk-status`), `/returns` (+ `:decide`), `/campaigns`, `/coupons`, `/consents` (+ `:withdraw`), `/rfm`, `/imports` |

### Çağrı merkezi (G7)
| Yöntem | Yol | Not |
|---|---|---|
| GET/POST/PATCH | `/v1/telephony/providers`, `:test-connection` | Sırlar yalnızca yazılır |
| GET/POST | `/v1/telephony/numbers`, `/v1/telephony/extensions` | DID ↔ tenant, dahili ↔ kullanıcı |
| POST | `/v1/calls:originate` | Tıkla-ara: rıza/saat/DNC → 422 nedenli |
| POST | `/v1/calls/{id}:answer|hold|resume|transfer|hangup` | CTI komutları |
| POST | `/v1/calls/{id}:wrap-up` | Disposition + not (mention) + otomatik görev |
| POST | `/v1/calls:manual` | Kopma modunda manuel kayıt |
| GET | `/v1/calls`, `/v1/calls/{id}` | Predicate'li |
| GET | `/v1/calls/{id}/recording` | Yetki + politika → 60 sn imzalı URL, audit |
| POST | `/v1/calls/{id}/monitor` | `listen|whisper|barge`, politika + bildirim |
| PUT | `/v1/agents/me/state` | Durum + mola nedeni |
| GET | `/v1/wallboard?queue=` | Anlık + SSE |
| POST | `/telephony/v1/webhooks/{providerId}` | CCaaS alıcısı (gateway; imza + IP) |

### Data Servisi (G7, ayrı sürüm)
`GET /dataservice/v1/lookup?phone=`, `GET /dataservice/v1/routing?phone=`, `POST /dataservice/v1/events`, `POST /dataservice/v1/cdr:import`, `GET /dataservice/v1/dialer-lists/{id}:export`. Kimlik: `Authorization: Bearer rv_live_…` veya mTLS. Ayrıntı ADR-0016.

### Raporlama, arama, içe/dışa aktarma (Faz 7, G8)
`/v1/search?q=&types=` (yetki duyarlı, vurgulama), `/v1/reports` (hazır + oluşturucu, `:run`), `/v1/reports/{id}/schedules`, `/v1/dashboards` (+ widget'lar), `/v1/exports` (politika, filigran, audit), `/v1/imports` (eşleme, `dryRun`, hata raporu), `/v1/saved-views`, `/v1/manager/overview`, `/v1/dialer/*`, `/v1/qa/*`.

### AI (G11–G13)
| Yöntem | Yol | Not |
|---|---|---|
| GET | `/v1/ai/summary/today` | Önbellekli; fallback |
| POST | `/v1/ai/summary:generate` | İstek üzerine |
| POST | `/v1/ai/reports` | `subjectUserId` başkasıysa yetki + politika + şeffaflık kaydı |
| GET | `/v1/ai/reports/{id}` (+ `/stream` SSE, `:cancel`, `/export`) | |
| POST | `/v1/ai/query` | Doğal dil → RQL araçları |
| POST | `/v1/ai/notes:summarize`, `/v1/ai/suggestions/{id}:accept` | Onaysız kayıt yok |
| GET | `/v1/ai/transparency` | "Benim hakkımda" |
| POST | `/v1/ai/feedback` | |
| GET/PUT | `/v1/ai/settings`, `/v1/ai/glossary`; POST `/v1/ai/kill-switch` | Admin |

## 3. Gerçek zamanlı olay tipleri (SSE)
`record.changed {type,id,version,fields[]}`, `record.deleted`, `notification.created|read|retracted`, `mention.created`, `call.screen_pop {callId, match: known|multiple|unknown}`, `call.state_changed`, `agent.state_changed`, `wallboard.tick`, `job.progress`, `authz.changed`, `positions.rebalanced`, `resync.required`, `telephony.connection_lost|restored`, `ai.stream.delta|done`.
