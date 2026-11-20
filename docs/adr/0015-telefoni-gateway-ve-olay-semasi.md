# ADR-0015: Telefoni ağ geçidi, adaptör arayüzü ve normalize olay şeması

- Durum: Önerildi · Tarih: 2026-11-20 · Kapsam: G7 · Gereksinimler: CC-01…21, 10.3.5

## 1. Bileşen
`apps/telephony-gateway`: santrallere kalıcı bağlantı (Asterisk ARI websocket, FreeSWITCH ESL) ve CCaaS webhook alıcıları. İş mantığı içermez; olayları normalize eder, doğrular, tenant'ı çözer ve kuyruğa koyar. Komutları (originate, hold…) API'den alır ve sağlayıcıya iletir.

## 2. Adaptör arayüzü
```ts
interface TelephonyProvider {
  readonly kind: 'asterisk_ari' | 'freeswitch_esl' | 'webhook_ccaas' | string;
  capabilities(): ProviderCapabilities;        // recording, monitoring, transfer types, agent state sync, CDR pull
  connect(cfg: ProviderConfig, sink: EventSink): Promise<Connection>;
  originate(cmd: OriginateCmd): Promise<CommandResult>;
  answer(callRef: string): Promise<CommandResult>;
  hold(callRef: string, on: boolean): Promise<CommandResult>;
  transfer(callRef: string, target: TransferTarget, mode: 'blind' | 'attended'): Promise<CommandResult>;
  hangup(callRef: string): Promise<CommandResult>;
  setAgentState(ext: string, state: AgentState, reason?: string): Promise<CommandResult>;
  setRecording(callRef: string, action: 'pause' | 'resume'): Promise<CommandResult>;   // PCI duraklatma
  monitor?(callRef: string, mode: 'listen' | 'whisper' | 'barge', supervisorExt: string): Promise<CommandResult>;
  fetchCdr(since: Date, until: Date): AsyncIterable<CdrRecord>;                         // mutabakat
  verifyWebhook?(req: RawRequest): VerifiedWebhook;                                    // imza + IP
}
```
Desteklenmeyen yetenek → `CommandResult { ok: false, code: 'CAPABILITY_UNSUPPORTED' }`; arayüz yeteneklere göre düğmeleri gizler.

## 3. Normalize olay şeması (v1)
```json
{
  "schema": "runvara.telephony.v1",
  "providerEventId": "string (sağlayıcı benzersizi; yoksa deterministik hash)",
  "providerId": "uuid", "providerCallId": "string",
  "type": "call.ringing | call.answered | call.held | call.resumed | call.transferred | call.ended | recording.ready | agent.state_changed | queue.stats",
  "occurredAt": "RFC 3339 (sağlayıcı saati)", "receivedAt": "RFC 3339",
  "direction": "in | out", "from": "E.164", "to": "E.164 (DID)",
  "agentExtension": "string?", "queueRef": "string?",
  "cause": "string?", "durationSec": "int?", "recordingRef": "string?",
  "raw": { "…sağlayıcıya özgü alanlar…": "" }
}
```
Gövdede tenant alanı **yoktur**; varsa yok sayılır.

## 4. Tenant çözümü
Gelen çağrı: `resolve_tenant_by_did(to)`; giden: `providerId` + `agentExtension` → `agent_extensions` (her ikisi tenant'a bağlı). Webhook ayrıca sağlayıcı yapılandırmasının sırrıyla imza + IP izin listesi doğrulanır; sağlayıcı yapılandırması zaten tek tenant'a aittir. Çözülemeyen olay → `telephony_unrouted_events` (operatör görünümü), işlenmez.

## 5. İşleme: idempotent ve sıra bağımsız
- Kuyruk: `telephony.<shard>` (ADR-0014), anahtar `(tenantId, providerCallId)` → aynı çağrının olayları aynı işçide seri (BullMQ grup yerine çağrı başına Redis kilidi).
- `call_events UNIQUE (tenant_id, provider_id, provider_event_id)` → tekrar olay etkisiz.
- **Durum makinesi** olayları `occurredAt`'e göre birleştirir: her olay ilgili zaman damgasını set eder (`answered_at`, `ended_at`…), durum = zaman damgalarından türetilir (en ileri durum kazanır; `ended` terminaldir). Böylece `ended` önce, `answered` sonra gelse bile sonuç doğrudur ve süre hesapları zaman damgalarından yapılır.
- Sürekli eksik olay: `ringing` sonrası 2 saat olay yoksa çağrı `stale` → mutabakat işine aday.

## 6. Mutabakat (CC-21) ve kopma davranışı
- Her 15 dk + yeniden bağlanmada `fetchCdr(son başarılı pencere - 10 dk, şimdi)`; CDR ↔ `calls` eşleştirilir: eksik çağrı oluşturulur (`source = reconciliation`), farklı süre/sonuç düzeltilir, fark raporu kaydedilir.
- Santral bağlantısı koparsa: `telephony.connection_lost` olayı → arayüz "manuel kayıt" modu (temsilci çağrıyı elle kaydeder; kayıt `source = manual`), mutabakat sonrası manuel kayıt CDR ile birleştirilir (aynı numara ± 2 dk penceresi).

## 7. Simülatör
`packages/telephony/simulator`: senaryo DSL'i (gelen arama, cevap, bekletme, aktarma, kapanış, tekrar/sırasız/kayıp olay enjeksiyonu, bağlantı kopması) hem ARI benzeri websocket hem webhook olarak yayın yapar. Tüm G7 E2E ve kaos testleri simülatörle çalışır; demo verisi de simülatörü kullanır.

## Sonuçlar
- (+) Sağlayıcı değişimi üst katmanı etkilemez; sıra/tekrar sorunları tasarım gereği zararsız.
- (−) Sağlayıcı saat kayması `occurredAt`'i bozabilir; `receivedAt` ile farkı > 5 sn ise uyarı metriği ve süre hesaplarında sağlayıcı süresi (`durationSec`) tercih edilir.
