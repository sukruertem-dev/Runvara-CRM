# ER Diyagramı

> Faz 0 + G0 · 2026-11-20. Okunabilirlik için alanlara bölünmüştür. Tüm tenant tablolarında `tenant_id` (RLS, ADR-0003) ve ortak sütunlar (`created_at, updated_at, created_by, updated_by, version`; uygun tablolarda `deleted_at`, `archived_at`) **vardır ama tekrar yazılmamıştır**. `segment` / `segments` sütunları ADR-0010'a göredir. Polimorfik `related_type + related_id` → `record_registry` bileşik FK (ADR-0005).
> Global (tenant'sız) tablolar `docs/architecture.md` §6'daki kapalı listededir ve diyagramlarda **[G]** ile işaretlidir.

## 1. Tenant, kimlik ve platform

```mermaid
erDiagram
  tenants ||--o{ tenant_domains : has
  tenants ||--o{ tenant_modules : enables
  tenants ||--|| tenant_plans : subscribes
  plans ||--o{ tenant_plans : "plan of"
  tenants ||--o{ tenant_quotas : limits
  tenants ||--o{ tenant_usage_counters : meters
  tenants ||--o{ tenant_keys : "DEK versions"
  tenants ||--o{ tenant_placements : "cluster (TEN-06 prep)"
  tenants ||--o{ memberships : has
  users ||--o{ memberships : "member of"
  users ||--o{ user_credentials : has
  users ||--o{ user_mfa : has
  users ||--o{ auth_sessions : has
  auth_sessions ||--o{ refresh_tokens : rotates
  tenants ||--o{ tenant_sso_providers : "OIDC/SAML"
  tenants ||--o{ invitations : issues
  platform_operators ||--o{ support_access_grants : requests
  tenants ||--o{ support_access_grants : approves

  tenants {
    uuid id PK "[G] RLS id=app_tenant_id()"
    text slug UK
    text name
    text status "trial|active|suspended|pending_deletion|deleted"
    text sales_mode "b2b_only|b2c_only|both"
    text locale
    text timezone
    text currency
    text country
    int authz_epoch
    timestamptz deletion_scheduled_at
  }
  users {
    uuid id PK "[G]"
    citext email UK
    text display_name
    text locale
    text timezone
    timestamptz email_verified_at
    timestamptz anonymized_at
  }
  memberships {
    uuid tenant_id PK
    uuid user_id PK
    text status "invited|active|suspended|left"
    uuid primary_team_id FK
    int authz_version
    text density "comfortable|compact"
  }
  user_credentials { uuid user_id PK "[G]" text password_hash "argon2id" jsonb params }
  user_mfa { uuid user_id PK "[G]" bytea totp_secret_enc jsonb recovery_code_hashes }
  auth_sessions { uuid id PK "[G]" uuid user_id FK uuid tenant_id inet ip text user_agent timestamptz revoked_at }
  refresh_tokens { uuid id PK "[G]" uuid session_id FK uuid family_id bytea token_hash timestamptz used_at timestamptz expires_at }
  tenant_domains { uuid id PK text hostname UK bool is_custom timestamptz verified_at }
  tenant_modules { uuid tenant_id PK text module_id PK bool enabled uuid enabled_by timestamptz enabled_at jsonb config }
  plans { text id PK "[G]" jsonb limits jsonb included_modules }
  tenant_plans { uuid tenant_id PK text plan_id FK jsonb add_on_modules timestamptz renews_at }
  tenant_quotas { uuid tenant_id PK text dimension PK bigint soft_limit bigint hard_limit }
  tenant_usage_counters { uuid tenant_id PK date day PK text dimension PK bigint value }
  tenant_keys { uuid tenant_id PK int version PK bytea wrapped_dek text kek_ref timestamptz retired_at }
  tenant_placements { uuid tenant_id PK text cluster_id }
  tenant_sso_providers { uuid id PK text kind "oidc|saml" jsonb config bytea secret_enc text email_domain }
  invitations { uuid id PK citext email uuid role_id uuid team_id bytea token_hash timestamptz expires_at }
  platform_operators { uuid id PK "[G]" citext email bytea password_hash bytea totp_secret_enc }
  support_access_grants { uuid id PK uuid operator_id FK text reason jsonb scope text state timestamptz approved_at timestamptz expires_at }
```

## 2. Yetki, ekip, segment, kuyruk

```mermaid
erDiagram
  roles ||--o{ role_permissions : "versioned grants"
  roles ||--o{ user_roles : assigned
  memberships ||--o{ user_roles : has
  memberships ||--o{ user_segment_entitlements : has
  memberships ||--o{ user_scope_overrides : has
  roles ||--o{ field_policies : defines
  teams ||--o{ team_members : has
  teams ||--o{ team_managers : "managed by"
  teams ||--o| teams : "parent team"
  queues ||--o{ queue_members : has
  queues ||--o{ telephony_queue_mappings : "PBX queue"
  memberships ||--o{ delegations : "delegator/delegate"
  memberships ||--o{ access_requests : files
  record_registry ||--o{ record_shares : "shared to"

  roles { uuid id PK text key UK text name bool is_system text path "ltree hierarchy" int version }
  role_permissions { uuid role_id PK int role_version PK text permission_key PK text mode "full|read|approve|request" jsonb scope jsonb constraints text policy numeric approve_limit }
  user_roles { uuid user_id PK uuid role_id PK timestamptz valid_until }
  user_segment_entitlements { uuid user_id PK segment segment PK timestamptz valid_from timestamptz valid_until uuid granted_by }
  user_scope_overrides { uuid user_id PK text permission_key PK jsonb scope bool export_allowed }
  field_policies { uuid role_id PK text resource_type PK text field PK text access "hidden|read|write" }
  teams { uuid id PK text name uuid parent_team_id FK segment_array segments }
  team_members { uuid team_id PK uuid user_id PK bool is_primary }
  team_managers { uuid team_id PK uuid user_id PK }
  queues { uuid id PK text kind "work|call" text name segment segment "nullable" }
  queue_members { uuid queue_id PK uuid user_id PK text role "member|supervisor" }
  telephony_queue_mappings { uuid queue_id FK uuid provider_id FK text provider_queue_ref UK }
  delegations { uuid id PK uuid delegator_id uuid delegate_id jsonb permissions timestamptz starts_at timestamptz ends_at timestamptz revoked_at }
  access_requests { uuid id PK uuid requester_id jsonb requested uuid approval_request_id FK text state }
  record_shares { text record_type PK uuid record_id PK text grantee_type PK uuid grantee_id PK text access "read|write" text source "manual|rule|mention" }
  sharing_rules { uuid id PK text resource_type jsonb criteria text grantee_type uuid grantee_id text access }
  record_queue_links { text record_type PK uuid record_id PK uuid queue_id PK text source timestamptz linked_at }
  call_access_grants { uuid user_id PK uuid call_id PK text record_type uuid record_id timestamptz expires_at }
```

## 3. Görev çekirdeği

```mermaid
erDiagram
  workflows ||--o{ statuses : has
  workflows ||--o{ workflow_transitions : allows
  statuses ||--o{ tasks : "current status"
  tasks ||--o{ tasks : "parent_id (subtasks)"
  tasks ||--o{ task_dependencies : "blocks"
  tasks ||--o{ task_tags : tagged
  tags ||--o{ task_tags : ""
  task_series ||--o{ tasks : "occurrences"
  queues ||--o{ tasks : "owner_type=queue"
  record_registry ||--o{ tasks : "related_type/related_id"
  custom_field_definitions }o--|| workflows : "resource_type"

  tasks {
    uuid id PK
    text title
    jsonb description "ProseMirror JSON"
    text description_html
    uuid status_id FK
    smallint priority
    text owner_type "user|queue"
    uuid owner_id
    uuid owner_user_id "derived"
    uuid queue_id "derived"
    uuid assignee_user_id
    timestamptz start_at
    timestamptz due_at
    interval estimate
    uuid parent_id FK
    smallint depth "max 5"
    text position "fractional, COLLATE C"
    text related_type
    uuid related_id
    segment segment "nullable, derived"
    uuid series_id FK
    int occurrence_index
    int workflow_version
    jsonb custom
    tsvector search
  }
  statuses { uuid id PK text resource_type uuid workflow_id FK text key text category "open|in_progress|closed" jsonb label_i18n text color_token bool is_initial text position }
  workflows { uuid id PK text resource_type text key int version segment segment timestamptz published_at }
  workflow_transitions { uuid id PK uuid workflow_id FK uuid from_status_id uuid to_status_id text key jsonb conditions jsonb validators jsonb post_functions text required_permission }
  task_dependencies { uuid blocker_id PK uuid blocked_id PK text kind "blocks" }
  task_series { uuid id PK text rrule text tzid timestamp dtstart_local int next_index text catch_up jsonb template }
  tags { uuid id PK text name text color_token }
  task_tags { uuid task_id PK uuid tag_id PK }
  custom_field_definitions { uuid id PK text resource_type text key UK text type jsonb label_i18n bool required jsonb default_value jsonb options text relation_target jsonb formula bool indexed segment segment }
  record_registry { uuid tenant_id PK text record_type PK uuid record_id PK segment segment timestamptz deleted_at }
```

## 4. CRM

```mermaid
erDiagram
  accounts ||--o{ accounts : "parent_account_id"
  accounts ||--o{ account_contact_roles : has
  contacts ||--o{ account_contact_roles : "role in"
  contacts ||--o{ contact_points : has
  accounts ||--o{ contact_points : has
  leads ||--o{ contact_points : has
  leads ||--o| lead_conversions : converted
  lead_conversions }o--|| accounts : created
  lead_conversions }o--|| contacts : created
  lead_conversions }o--o| opportunities : created
  pipelines ||--o{ pipeline_stages : has
  pipeline_stages ||--o{ opportunities : "stage"
  accounts ||--o{ opportunities : has
  accounts ||--o{ cases : has
  contacts ||--o{ cases : raises
  queues ||--o{ cases : "assigned queue"
  contacts ||--o| customer_profiles : "B2C profile"
  record_registry ||--o{ notes : "related"
  merges }o--|| record_registry : "survivor"

  accounts { uuid id PK text name text domain uuid parent_account_id FK segment_array segments uuid owner_user_id text industry jsonb custom tsvector search }
  contacts { uuid id PK text first_name text last_name text company_name segment_array segments uuid owner_user_id jsonb custom tsvector search timestamptz anonymized_at }
  account_contact_roles { uuid account_id PK uuid contact_id PK text role "decision_maker|influencer|user|approver|other" bool is_primary }
  contact_points { uuid id PK text owner_type uuid owner_id text kind "phone|email|address|social" text value text e164 "indexed" bool is_primary timestamptz verified_at }
  leads { uuid id PK text name text company segment segment uuid status_id FK text source int score uuid owner_user_id uuid queue_id jsonb custom }
  lead_conversions { uuid lead_id PK uuid account_id uuid contact_id uuid opportunity_id uuid converted_by timestamptz converted_at }
  pipelines { uuid id PK text key text name segment segment uuid workflow_id FK }
  pipeline_stages { uuid id PK uuid pipeline_id FK uuid status_id FK numeric probability text position }
  opportunities { uuid id PK text name uuid account_id FK uuid primary_contact_id uuid pipeline_id FK uuid stage_id FK segment segment numeric amount char3 currency numeric probability bool probability_manual date expected_close text competitor text won_lost_reason uuid owner_user_id jsonb custom }
  cases { uuid id PK text subject uuid account_id uuid contact_id uuid status_id FK smallint priority text channel text category uuid queue_id uuid owner_user_id segment segment uuid sla_policy_id jsonb custom }
  customer_profiles { uuid contact_id PK segment segment "b2c" smallint rfm_r smallint rfm_f smallint rfm_m text rfm_segment numeric ltv jsonb preferences }
  notes { uuid id PK text related_type uuid related_id jsonb body text body_html text visibility "standard|private" segment segment uuid author_id }
  merges { uuid id PK text record_type uuid survivor_id jsonb merged_ids jsonb field_choices uuid merged_by }
  products { uuid id PK text sku UK text name text category uuid tax_rate_id bool active segment_array segments numeric unit_cost }
  price_lists { uuid id PK text name char3 currency segment segment uuid account_id "customer-specific" date valid_from date valid_to }
  price_list_items { uuid price_list_id PK uuid product_id PK numeric unit_price numeric min_qty }
  tax_rates { uuid id PK text name numeric rate text country }
  fx_rates { char3 base PK char3 quote PK date valid_on PK numeric rate }
```

## 5. B2B satış ve ortak satış çekirdeği

```mermaid
erDiagram
  opportunities ||--o{ quotes : has
  quotes ||--o{ quote_versions : "immutable versions"
  quote_versions ||--o{ quote_lines : has
  products ||--o{ quote_lines : priced
  quotes ||--o| contracts : "won →"
  contracts ||--o{ orders : "B2B order"
  approval_rules ||--o{ approval_requests : triggers
  quote_versions ||--o{ approval_requests : "subject"
  teams ||--o{ sales_targets : "team target"
  sales_targets ||--o{ forecast_snapshots : ""
  record_registry ||--o{ sales_activity_links : "TRK-01"

  quotes { uuid id PK uuid opportunity_id FK uuid account_id segment segment "b2b" uuid status_id int current_version char3 currency uuid owner_user_id }
  quote_versions { uuid quote_id PK int version PK jsonb totals numeric discount_percent date valid_until uuid price_list_id text pdf_object_key bytea content_hash timestamptz submitted_at jsonb note }
  quote_lines { uuid id PK uuid quote_id FK int version FK uuid product_id numeric qty numeric unit_price numeric discount_percent uuid tax_rate_id numeric line_total }
  contracts { uuid id PK uuid account_id uuid opportunity_id uuid quote_id date start_date date end_date bool auto_renew int renewal_notice_days segment segment }
  approval_rules { uuid id PK text kind "discount|return|campaign|access_request" jsonb condition text approver_strategy jsonb levels int timeout_hours }
  approval_requests { uuid id PK text subject_type uuid subject_id text kind uuid requested_by numeric amount numeric percent int level uuid assigned_to text state uuid decided_by text reason }
  sales_targets { uuid id PK text subject_type "user|team|segment" uuid subject_id segment segment text period "month|quarter" date period_start text metric numeric target_value }
  forecast_snapshots { uuid id PK uuid owner_id text period date taken_on segment segment numeric weighted numeric committed numeric manager_adjustment }
  sales_activity_links { uuid task_id PK text record_type PK uuid record_id PK text activity_kind "call|meeting|follow_up" }
```

## 6. B2C satış

```mermaid
erDiagram
  contacts ||--o{ orders : places
  orders ||--o{ order_lines : has
  orders ||--o{ order_status_history : transitions
  orders ||--o{ returns : "return/cancel"
  returns ||--o{ approval_requests : "subject"
  campaigns ||--o{ coupons : issues
  coupons ||--o{ orders : "applied"
  contacts ||--o{ consents : grants
  contacts ||--o{ addresses : has

  orders { uuid id PK text number UK uuid contact_id FK uuid account_id "B2B order" segment segment text channel "web|store|phone|social" uuid status_id text payment_status text fulfillment_status numeric total char3 currency uuid coupon_id uuid source_call_id jsonb note }
  order_lines { uuid id PK uuid order_id FK uuid product_id numeric qty numeric unit_price numeric discount numeric line_total }
  order_status_history { uuid id PK uuid order_id FK uuid from_status_id uuid to_status_id uuid actor_id timestamptz at }
  returns { uuid id PK uuid order_id FK text kind "return|cancel" text reason numeric amount text state jsonb note }
  campaigns { uuid id PK text name segment segment timestamptz starts_at timestamptz ends_at jsonb target_criteria text channel text state }
  coupons { uuid id PK uuid campaign_id FK text code UK int usage_limit int used_count text stacking_rule }
  consents { uuid id PK uuid contact_id FK text channel "phone|sms|email|whatsapp" text purpose bool granted text source timestamptz recorded_at timestamptz withdrawn_at text external_ref "IYS etc." }
  addresses { uuid id PK uuid contact_id FK text kind text line1 text city text country bool is_default }
  dnc_entries { uuid id PK text e164 text reason timestamptz expires_at }
```

## 7. Çağrı merkezi ve Data Servisi

```mermaid
erDiagram
  telephony_providers ||--o{ telephony_numbers : owns
  telephony_providers ||--o{ agent_extensions : maps
  memberships ||--o{ agent_extensions : "user ↔ ext"
  telephony_numbers }o--o| queues : "routes to"
  calls ||--o{ call_events : "normalized events"
  calls ||--o{ call_recordings : has
  calls }o--o| dispositions : "wrap-up"
  calls }o--o| record_registry : "related customer"
  memberships ||--o{ agent_state_history : has
  dialer_campaigns ||--o{ dialer_lists : uses
  dialer_lists ||--o{ dialer_attempts : "attempts"
  dialer_attempts }o--o| calls : produced
  qa_forms ||--o{ qa_evaluations : "used by"
  calls ||--o{ qa_evaluations : evaluated
  data_service_clients ||--o{ data_service_field_policies : has
  data_service_clients ||--o{ data_service_access_log : logs

  telephony_providers { uuid id PK text kind "asterisk_ari|freeswitch_esl|webhook_ccaas" jsonb config bytea credentials_enc bytea webhook_secret_enc cidr_array ip_allowlist text status }
  telephony_numbers { uuid id PK "[G] lookup via resolve_tenant_by_did()" uuid tenant_id uuid provider_id FK text e164 UK uuid queue_id }
  agent_extensions { uuid provider_id PK text extension PK uuid user_id }
  calls { uuid id PK uuid provider_id text provider_call_id text direction "in|out" text from_e164 text to_e164 segment segment uuid agent_user_id uuid queue_id text related_type uuid related_id text state timestamptz ringing_at timestamptz answered_at timestamptz ended_at int hold_seconds uuid disposition_id jsonb note text source "live|manual|reconciliation" }
  call_events { uuid id PK uuid call_id FK uuid provider_id text provider_event_id UK text type timestamptz occurred_at timestamptz received_at jsonb raw }
  call_recordings { uuid id PK uuid call_id FK text object_key int duration_sec timestamptz retain_until bool paused_segments }
  dispositions { uuid id PK text code text label segment segment jsonb required_fields jsonb follow_up }
  agent_state_history { uuid id PK uuid user_id text state "ready|on_call|wrap_up|break|offline" text reason timestamptz started_at timestamptz ended_at }
  dialer_campaigns { uuid id PK text mode "preview|progressive" segment segment jsonb calling_hours int max_attempts jsonb retry_rules text state }
  dialer_lists { uuid id PK uuid campaign_id FK text source jsonb criteria }
  dialer_attempts { uuid id PK uuid list_id FK uuid contact_id int attempt_no text outcome timestamptz next_attempt_at text blocked_reason }
  qa_forms { uuid id PK text name jsonb criteria int version }
  qa_evaluations { uuid id PK uuid call_id FK uuid form_id FK uuid evaluator_id uuid agent_user_id numeric score jsonb answers jsonb coaching_note }
  data_service_clients { uuid id PK text name bytea key_hash text cert_fingerprint cidr_array ip_allowlist text_array scopes segment_array segments int rate_limit_rpm }
  data_service_field_policies { uuid client_id PK text field PK bool allowed int policy_version }
  data_service_access_log { uuid id PK uuid client_id text endpoint bytea phone_hash text result int latency_ms text_array fields_returned timestamptz at }
```

## 8. Timeline, audit, yorum, dosya, mention, bildirim

```mermaid
erDiagram
  record_registry ||--o{ activity_events : timeline
  record_registry ||--o{ comments : has
  comments ||--o{ comment_revisions : "edit history"
  record_registry ||--o{ attachments : has
  record_registry ||--o{ mentions : "record"
  mentions ||--o{ notifications : creates
  notifications ||--o{ notification_deliveries : "per channel"
  memberships ||--o{ notification_preferences : has
  memberships ||--o{ push_subscriptions : has
  memberships ||--o{ realtime_event_log : "SSE replay"

  activity_events { uuid id PK "append-only" text record_type uuid record_id segment segment text kind "created|field_changed|status_changed|assigned|comment|email_log|call_log|deleted" uuid actor_id jsonb diff timestamptz occurred_at }
  audit_log { uuid id PK "append-only, UPDATE/DELETE blocked by trigger" text action jsonb actor text target_type uuid target_id inet ip jsonb details timestamptz at }
  comments { uuid id PK text record_type uuid record_id jsonb body text body_html uuid author_id timestamptz edited_at timestamptz deleted_at }
  comment_revisions { uuid comment_id PK int revision PK jsonb body timestamptz at }
  attachments { uuid id PK text record_type uuid record_id text object_key text file_name text mime bigint size_bytes text scan_status "quarantine|clean|infected|unscanned" }
  mentions { uuid id PK text source_type text source_id_field uuid source_id text record_type uuid record_id uuid mentioned_user uuid mentioned_team uuid via_team_id uuid mentioned_by timestamptz retracted_at }
  notifications { uuid id PK uuid user_id text kind text source_type uuid source_id text record_type uuid record_id segment segment uuid actor_id timestamptz read_at timestamptz retracted_at }
  notification_deliveries { uuid id PK uuid notification_id FK text channel "in_app|push|email" text status int latency_ms timestamptz at }
  notification_preferences { uuid user_id PK text kind PK jsonb channels jsonb dnd "quiet hours + tz" }
  push_subscriptions { uuid id PK uuid user_id text endpoint bytea p256dh_enc bytea auth_enc }
  realtime_event_log { uuid id PK "uuidv7 = SSE id" uuid user_id text type jsonb payload timestamptz expires_at }
```

## 9. Otomasyon, SLA, webhook, olay altyapısı

```mermaid
erDiagram
  automation_rules ||--o{ automation_runs : executes
  outbox_events ||--o{ processed_events : "consumed by"
  automation_runs ||--o| dead_letters : "failed"
  sla_policies ||--o{ sla_timers : instantiates
  business_calendars ||--o{ sla_policies : uses
  webhook_subscriptions ||--o{ webhook_deliveries : delivers
  api_keys }o--|| memberships : "service user"

  outbox_events { uuid id PK "[G-scan] tenant_id + RLS; relay role bypass" text type smallint version text resource_type uuid resource_id segment segment jsonb actor jsonb payload uuid causation_id uuid correlation_id smallint depth timestamptz occurred_at timestamptz published_at }
  processed_events { text consumer PK uuid event_id PK timestamptz at }
  dead_letters { uuid id PK text queue uuid event_id jsonb job text error int attempts timestamptz at timestamptz replayed_at }
  automation_rules { uuid id PK text name text trigger_kind jsonb trigger jsonb conditions jsonb actions bool enabled int version }
  automation_runs { uuid id PK uuid rule_id FK uuid event_id uuid record_id text status "ok|skipped|halted_depth|halted_loop|failed|throttled" jsonb input_summary jsonb result int duration_ms text error }
  sla_policies { uuid id PK text name jsonb applies_to jsonb milestones uuid calendar_id FK jsonb pause_statuses }
  business_calendars { uuid id PK text tzid jsonb weekly_hours jsonb holidays }
  sla_timers { uuid id PK uuid policy_id FK text record_type uuid record_id text milestone timestamptz target_at timestamptz warn_at text state "running|paused|met|breached" int paused_seconds }
  webhook_subscriptions { uuid id PK text url text_array event_types bytea secret_enc text status "active|disabled_auto|disabled" }
  webhook_deliveries { uuid id PK uuid subscription_id FK uuid event_id int attempt int status_code int latency_ms timestamptz next_retry_at }
  api_keys { uuid id PK text prefix UK bytea key_hash uuid service_user_id text_array scopes timestamptz expires_at timestamptz revoked_at }
  idempotency_keys { uuid principal_id PK text key PK bytea request_hash text status jsonb response timestamptz expires_at }
  bulk_operations { uuid id PK text resource_type text action int total int succeeded int failed jsonb undo timestamptz undo_until }
```

## 10. Yapılandırma, rapor, arama, içe/dışa aktarma

```mermaid
erDiagram
  tenant_settings_head ||--|| tenant_settings : "current version"
  config_blueprints ||--o{ blueprint_applications : applied
  saved_views }o--|| memberships : owner
  report_definitions ||--o{ report_schedules : scheduled
  import_jobs ||--o{ import_job_errors : reports
  dashboards ||--o{ dashboard_widgets : has

  tenant_settings { text scope_type PK uuid scope_id PK text key PK int version PK jsonb value int schema_version uuid created_by text change_note }
  tenant_settings_head { text scope_type PK uuid scope_id PK text key PK int version }
  tenant_secrets { text key PK bytea value_enc int key_version }
  config_blueprints { text id PK "[platform-shipped, versioned files]" int version jsonb content }
  blueprint_applications { uuid id PK text blueprint_id int version jsonb plan jsonb result timestamptz applied_at }
  saved_views { uuid id PK text resource_type text name text rql jsonb columns jsonb grouping bool shared text share_token }
  report_definitions { uuid id PK text name text source jsonb fields jsonb group_by jsonb aggregates text rql bool is_builtin }
  report_schedules { uuid id PK uuid report_id FK text cron text tzid uuid_array recipients }
  dashboards { uuid id PK text scope "personal|team|tenant" uuid owner_id }
  dashboard_widgets { uuid id PK uuid dashboard_id FK text kind jsonb config jsonb layout }
  import_jobs { uuid id PK text resource_type text object_key jsonb mapping text duplicate_policy bool dry_run text state int total int processed int failed }
  import_job_errors { uuid job_id PK int row_no PK jsonb errors }
  export_jobs { uuid id PK text resource_type text rql jsonb columns text format text state text object_key bool watermark }
  privacy_requests { uuid id PK text kind "export|erase" text subject_type uuid subject_id text state timestamptz due_at }
```

## 11. AI asistan

```mermaid
erDiagram
  ai_models ||--o{ ai_tenant_settings : "allowed"
  ai_report_definitions ||--o{ ai_report_runs : runs
  ai_report_runs ||--o{ ai_report_sources : cites
  ai_report_runs ||--o| ai_transparency_log : "about subject"
  ai_summaries ||--o{ ai_feedback : rated
  ai_report_runs ||--o{ ai_feedback : rated

  ai_models { uuid id PK "[G]" text name text version text license text license_url bool commercial_ok text_array languages int context_tokens text endpoint_kind text status }
  ai_tenant_settings { uuid tenant_id PK bool enabled text_array allowed_features uuid_array allowed_model_ids bool external_provider_approved jsonb quota text byo_endpoint bool kill_switch }
  ai_glossary { uuid id PK text term text meaning text kind "stage|disposition|segment|custom" }
  ai_requests { uuid id PK "metadata only: NO prompt/response columns" uuid user_id text kind uuid model_id text model_version int tokens_in int tokens_out int latency_ms text status uuid_array source_record_ids }
  ai_summaries { uuid id PK uuid user_id date day text authz_hash text status jsonb content uuid model_id }
  ai_report_definitions { uuid id PK uuid owner_id jsonb params text schedule_cron }
  ai_report_runs { uuid id PK uuid requested_by uuid subject_user timestamptz period_start timestamptz period_end jsonb scope text authz_hash uuid model_id text model_version text status jsonb content }
  ai_report_sources { uuid run_id PK text record_type PK uuid record_id PK }
  ai_transparency_log { uuid id PK uuid subject_user uuid requested_by uuid report_run_id jsonb scope }
  ai_feedback { uuid id PK text target_type uuid target_id uuid user_id smallint rating text comment }
  ai_query_history { uuid id PK uuid user_id text question_hash jsonb answer_meta timestamptz expires_at }
```

## Bütünlük kuralları özeti

| Kural | Mekanizma |
|---|---|
| Tenant izolasyonu | `tenant_id` + FORCE RLS (RESTRICTIVE) her tenant tablosunda |
| Segment izolasyonu | RESTRICTIVE segment politikası (ADR-0010) |
| Polimorfik bütünlük | `record_registry` bileşik FK, DEFERRABLE |
| Bağımlılık DAG | Servis katmanında DFS + `task_dependencies` yazımında `pg_advisory_xact_lock(tenant)` ile seri hale getirme; ek olarak yinelemeli CTE ile DB kontrolü (trigger) |
| Alt görev derinliği | CHECK `depth <= 5` + trigger ile `parent.depth + 1` |
| Değiştirilemez tablolar | `audit_log`, `activity_events`, gönderilmiş `quote_versions`/`quote_lines`: `BEFORE UPDATE OR DELETE` trigger `RAISE EXCEPTION` + `REVOKE UPDATE, DELETE` |
| Tekrarlayan görev çift üretimi | `UNIQUE (series_id, occurrence_index)` |
| Çağrı olay idempotency | `UNIQUE (tenant_id, provider_id, provider_event_id)`; `UNIQUE (tenant_id, provider_call_id)` |
| Bir hat tek tenant | `telephony_numbers.e164 UNIQUE` |
