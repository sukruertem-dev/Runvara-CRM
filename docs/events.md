# Domain Olay Kataloğu

> Faz 0 + G0 · 2026-11-20 · Altyapı: ADR-0006 (outbox), ADR-0007 (SSE). Tipler `packages/events` içinde Zod şemalarıyla sürümlenir. Ad biçimi `<kaynak>.<geçmiş zaman fiili>`; geriye uyumsuz değişiklik `version` artırır.

## Zarf

```json
{
  "id": "uuidv7", "type": "task.status_changed", "version": 1,
  "tenantId": "uuid", "occurredAt": "2026-11-20T10:15:00.000Z",
  "actor": { "type": "user | service | automation | operator | system", "id": "uuid", "ruleId": "uuid?" },
  "resource": { "type": "task", "id": "uuid", "segment": "b2b | b2c | null", "version": 7 },
  "causationId": "uuid?", "correlationId": "uuid", "depth": 0,
  "payload": { }
}
```
- `payload` **minimaldir**: değişen alan adları ve gerekiyorsa eski/yeni değerler; FLS gizli alanların değerleri olaya **yazılmaz** (yalnızca alan adı). Kişisel veri (telefon, e-posta) yalnızca gerekliyse ve maskeli.
- Webhook'a giden yük, abonenin servis bağlamının FLS maskesinden geçer.

## Katalog

| Olay | Yayıncı modül | Önemli payload alanları | Tüketiciler |
|---|---|---|---|
| `tenant.created` | core | plan, blueprint | provisioning, audit |
| `tenant.status_changed` | core | from, to, reason | operator, işler, telefoni |
| `tenant.sales_mode_changed` | core | from, to | authz (epoch), menü, işler |
| `module.toggled` | core | moduleId, enabled, cascade[] | authz (epoch), işler, SSE |
| `config.changed` | core | key, scope, version (değer yok) | önbellek, SSE, ilgili modül |
| `quota.threshold` | core | dimension, level (warning/soft/hard), used, limit, period | Admin e-postası, webhook |
| `user.invited` / `user.joined` / `user.suspended` / `user.anonymized` | core | userId, roleIds | bildirim, KVKK işi |
| `authz.changed` | core | userIds[] veya tenantEpoch | SSE (yeniden süzme), önbellek |
| `role.matrix_published` | core | version, diffSummary, affectedUserCount | audit, SSE |
| `delegation.started` / `delegation.expired` | core | delegationId | authz, bildirim |
| `access_request.created` / `.decided` | core | requestId, decision | onay, bildirim |
| `task.created` / `task.updated` / `task.deleted` / `task.restored` | core | changedFields[] | otomasyon, SSE, arama, webhook |
| `task.status_changed` | core | fromStatusId, toStatusId, category | otomasyon, SLA, tekrar üretici |
| `task.assigned` | core | ownerType, ownerId | bildirim, iş yükü |
| `task.dependency_added` / `_removed` | core | blockerId, blockedId | Gantt SSE |
| `task.recurrence_materialized` | core | seriesId, occurrenceIndex | SSE |
| `comment.created` / `.updated` / `.deleted` | core | recordRef | mention, SSE, timeline |
| `mention.created` / `mention.retracted` | core | mentionedUserId \| teamId, sourceRef | bildirim (G6) |
| `notification.created` / `.read` / `.retracted` | core | notificationId | SSE, push, e-posta |
| `attachment.uploaded` / `.scanned` | core | scanStatus | tarama, SSE |
| `lead.created` / `lead.converted` | crm | accountId, contactId, opportunityId | otomasyon, rapor |
| `opportunity.stage_changed` | crm | fromStageId, toStageId, probability, amount | forecast, otomasyon, hedef |
| `opportunity.won` / `.lost` | crm | reason | sözleşme önerisi, rapor |
| `case.created` / `case.status_changed` | crm | priority, queueId | SLA, atama |
| `record.merged` | crm | survivorId, mergedIds[] | arama, timeline taşıma |
| `contact_point.changed` | crm | e164 (maskeli) | Data Servisi önbellek geçersiz kılma |
| `sla.warning` / `sla.breached` / `sla.met` | automation_sla | milestone, targetAt | otomasyon, bildirim, eskalasyon |
| `automation.run.failed` / `automation.run.halted` | automation_sla | ruleId, reason (depth/loop) | DLQ, Admin bildirimi |
| `webhook.delivery_failed` / `webhook.disabled` | api_webhooks | subscriptionId, attempts | Admin bildirimi |
| `approval.requested` / `approval.decided` / `approval.escalated` | core (G3) | kind, subject, level, decision | konu modül, bildirim |
| `discount.approval_requested` | sales_b2b | quoteId, version, percent | onay motoru |
| `quote.created` / `quote.submitted` / `quote.revised` / `quote.sent` / `quote.accepted` / `quote.rejected` / `quote.expired` | sales_b2b | quoteId, version | otomasyon, timeline |
| `contract.created` / `contract.updated` / `contract.renewed` / `contract.terminated` / `contract.renewal_due` | sales_b2b | contractId (renewal_due: endDate, taskId) | hatırlatıcı görev |
| `order.created` / `order.fulfilled` / `order.cancelled` (B2B) | sales_b2b | orderId | otomasyon |
| `forecast.snapshot_taken` | sales_b2b | snapshotId, period, kind | rapor |
| `opportunity.stale` | sales_b2b | opportunityId, idleDays, staleDays | bildirim, otomasyon |
| `order.created` / `order.status_changed` | sales_b2c | fromStatus, toStatus, channel, sourceCallId | otomasyon, hedef, stok/finans webhook |
| `return.requested` / `return.decided` | sales_b2c | amount, reason | onay, finans webhook |
| `consent.changed` | sales_b2c | channel, granted | dialer, kampanya, tıkla-ara |
| `campaign.started` / `campaign.finished` | sales_b2c | | otomasyon |
| `customer.rfm_recomputed` | sales_b2c | segmentChanges | otomasyon (geri kazanım) |
| `target.at_risk` | sales_tracking | targetId, progress, expected | Yönetici bildirimi |
| `call.ringing` | call_center | callId, direction, match (known/multiple/unknown) | ekran açma (SSE), wallboard |
| `call.answered` / `call.held` / `call.resumed` / `call.transferred` | call_center | agentUserId | wallboard, durum |
| `call.ended` | call_center | durationSec, holdSec, cause | aktivite, SLA, rapor, dialer |
| `call.wrapped_up` | call_center | dispositionCode, followUp | görev/geri arama üretimi |
| `recording.ready` | call_center | recordingId | QA örnekleme |
| `agent.state_changed` | call_center | from, to, reason | wallboard, santral senkronu |
| `telephony.connection_lost` / `telephony.connection_restored` | call_center | providerId | arayüz manuel mod, mutabakat |
| `telephony.reconciliation_completed` | call_center | created, corrected | rapor, audit |
| `dialer.attempt.completed` / `dialer.campaign.finished` | dialer | outcome, blockedReason | kampanya raporu |
| `qa.evaluation.completed` | call_qa | score | bildirim (temsilci) |
| `dataservice.lookup.field_denied` | data_service | clientId, fields[] | audit |
| `report.scheduled_sent` / `export.completed` | reporting_advanced | rows, watermark | audit |
| `ai.summary.generated` / `ai.report.generated` / `ai.fallback_used` | ai_assistant | kind, status | bildirim, ölçüm |
| `privacy.request_completed` | core | kind (export/erase) | audit |

## Audit'e ayrıca yazılan kritik eylemler (outbox'tan bağımsız, aynı transaction)
Giriş/çıkış ve başarısız giriş, MFA değişikliği, rol/izin/segment/kapsam/delegasyon değişikliği, matris yayımı, modül aç/kapat, satış modu, yapılandırma değişikliği, dışa aktarma, kalıcı silme, KVKK talebi, çağrı kaydı dinleme, canlı izleme, "kullanıcı olarak gör", operatör destek erişimi, Data Servisi istemci/anahtar yönetimi, AI başka kullanıcı raporu, API anahtarı oluşturma/iptal.
