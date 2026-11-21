# P4 — Faz 4 + G2: tek yetki motoru · uygulama planı

> 2026-11-20 · Dal `feat/p4-authz`. Kaynak: prompt Faz 4, Faz G2, ADR-0004, ADR-0010, ADR-0017, ADR-0013. Kapsam çok geniş olduğundan iki adıma bölündü (`phase-plan.md`):
> - **P4a — yetki motoru** (bu dosyanın §1–§9'u): ekipler, kullanıcı segment yetkisi, gerçek kapsamlar (own/queue/team/segment/all), OWD, kayıt paylaşımı, kriter tabanlı paylaşım kuralları, rol hiyerarşisi, görev erişiminin parent kayıttan türetilmesi, alan düzeyi güvenlik, Yönetici sınırları, matristen üretilen testler.
> - **P4b — kayıt etrafı** (§10): activity timeline, yorum + mention, dosya ekleri, e-posta/arama logu, bildirim temeli, audit okuma API'si, delegasyon ve yetki talebi, matris yönetim API'leri (diff/sürüm).
> Audit log'un DB seviyesinde değiştirilemezliği P1'den beri var ve test ediliyor (`rls.int.test.ts`).

## 1. Karar modeli (ADR-0004 §1, değişmedi)
`allow = modül ∧ rol(kapsam ≠ none) ∧ segment ∧ (kapsam ∨ paylaşım ∨ hiyerarşi ∨ OWD) ∧ alan`. Segment ve modül koşulunu hiçbir genişletici terim aşamaz (segment RLS'te, modül `recordScope`'ta).

## 2. Bağlam (`AuthzContext` genişler)
`TenantGuard` her istekte tek sorguyla yükler (önbellek yok → yetki değişikliği bir sonraki istekte geçerli, G2 kabul):
- `segments` = aktif `user_segment_grants` (süresi dolmamış) ∩ tenant satış modu.
- `teamIds` (üyesi), `managedTeamIds` (yönettiği + tüm alt ekipler), `teamMemberIds` (bu ekiplerin tüm üyeleri), `queueIds` (üyesi olduğu kuyruklar), `roleIds`, `subordinateUserIds` (rol hiyerarşisinde altındaki rollere sahip kullanıcılar).

## 3. Kapsam → SQL (tek yer: `apps/api/src/common/record-access.ts`)
`recordScope(ctx, action, resource)` artık `{kind:'all'} | {kind:'scoped', scopes:Set<own|queue|team>} | {kind:'none'}` döndürür (`segment` kapsamı = segment RLS dışında kısıt yok = `all`). Predicate (alias `t`):
| Terim | SQL |
|---|---|
| own | `t.owner_user_id = :me OR t.created_by = :me` (görevde `assignee_user_id` de) |
| queue | `t.queue_id = ANY(:queueIds)` (kuyruk sütunu olan nesneler: lead, case, task) |
| team | `t.owner_user_id = ANY(:teamMemberIds)` |
| hiyerarşi | `t.owner_user_id = ANY(:subordinateUserIds)` |
| OWD | nesne için `read` / `read_write` ise okuma (ve `read_write` ise yazma) için `TRUE` |
| paylaşım | `EXISTS record_shares (kayıt, grantee = ben ∨ ekiplerimden biri, access ≥ eylem)` |
| paylaşım kuralı | her etkin kural için `(:teamIds && kural.grantee) AND <kuralın RQL koşulu>` — kayıt anında materyalize edilmez; sorguda derlenir (kural değişince tutarsızlık olmaz) |
Yazma eylemleri (update/archive) yalnızca `own/queue/team/hiyerarşi`, `read_write` OWD ve `edit` paylaşımıyla; `reassign`, `purge`, `bulk` paylaşımla genişlemez.

## 4. Görev erişimi parent'tan (Faz 4 maddesi)
Görev okunabilir ⇔ görev kapsamı ∨ (`related_type` ∈ okunabilir CRM tipleri ∧ `related_id IN (SELECT id FROM <tablo> WHERE <predicate(tablo)>)`). Yalnızca okuma için; yazma görev kapsamına bağlı.

## 5. Alan düzeyi güvenlik (FLS)
- `field_policies(tenant, role_id, resource_type, field, access hidden|read)`; satır yoksa `write`. Kullanıcının etkin erişimi rollerinin **en geniş** olanı.
- Gizli alan: yanıttan çıkarılır, RQL/sıralama/`fields` parametresinde **UNKNOWN_FIELD** (var olmayanla aynı mesaj), duplicate/merge yanıtlarında yok. Salt-okunur alana yazma → 403 `FIELD_READ_ONLY`. Custom field'lar `custom.cf_x` adıyla aynı mekanizmada.
- Matristeki maliyet/marj alanları teklif/ürün nesneleriyle (G3/G4) gelir; mekanizma şimdi CRM nesnelerinde çalışır ve testlenir.

## 6. Ekipler, kuyruklar, segment yetkisi, roller — yönetim API'leri
| Uç nokta | İzin | Kısıt (matris `constraints`) |
|---|---|---|
| `GET/POST /v1/teams`, `PATCH /v1/teams/{id}` | `teams.manage` (Admin) | üst ekip döngüsü yok |
| `PUT/DELETE /v1/teams/{id}/members/{userId}` | `teams.members.manage` | Yönetici: yalnızca yönettiği ekip (`managed_teams_only`); `manager` rolü yalnızca Admin verir |
| `GET/POST /v1/queues`, `PUT/DELETE /v1/queues/{id}/members/{userId}` | `teams.manage` | — |
| `GET /v1/users`, `GET /v1/users/{id}/access` | üyelik | etkin rol/segment/ekip özeti |
| `PUT /v1/users/{id}/segments` | `authz.segments.grant` | `own_segments_only`, `managed_teams_only`, `not_self` |
| `PUT /v1/users/{id}/roles` | `users.manage` (Admin) | son Admin kalır; `not_self` (kendi rolü yok) |
| `GET/PUT /v1/sharing/defaults` | `tenant.config.manage` | — |
| `GET/POST/DELETE /v1/sharing/rules` | `tenant.config.manage` | koşul RQL ile doğrulanır |
| `GET/POST/DELETE /v1/{type}/{id}/shares` | kayıtta `update` | kendine paylaşım anlamsız (422) |
| `PUT /v1/roles/{id}/parent`, `GET /v1/roles` | `authz.matrix.edit` / okuma | hiyerarşi döngüsü yok |
| `GET/PUT /v1/field-policies` | `authz.matrix.edit` | Admin'in alanı gizlenemez |
Her yetki değişikliği: `audit_log` + ilgili kullanıcıların `memberships.authz_version += 1` (kural/OWD/alan/rol hiyerarşisi değişikliği → `tenants.authz_epoch += 1`).

## 7. 404/403
Görünmez (segment, kapsam, tenant) → 404; görünür ama eylem yetkisiz → 403; kapalı modül → 404 `MODULE_DISABLED`; red nedenleri gövdede yok.

## 8. Kabul kriterleri ↔ testler (P4a)
| Kriter | Test |
|---|---|
| Matristen üretilen test paketi (rol × eylem × kapsam × segment) | `authz-matrix.int.test.ts`: `matrix.json`'dan bağımsız bir kâhin beklentiyi hesaplar, 5 rol × {read, update, archive, reassign, create} × {kendi, ekip arkadaşı, başka ekip, gizli segment} API ile doğrulanır |
| Yetkisiz kullanıcı göremez/değiştiremez; liste sayıları ve sayfalama doğru | aynı + sayım (`count=true`) ve sayfalı listede kapsam dışı kayıt hiç görünmez |
| Gizli alan filtre/sıralama ile sızdırılamaz | FLS testi (RQL, sort, fields, yanıt) |
| Rol hiyerarşisi ve paylaşım kuralı senaryoları | ayrı entegrasyon testleri |
| Karar senaryoları (10.4.4): SCN-05, 06, 07, 08, 11 (+ 01, 12, 13 modül/segment) | `authz-scenarios.int.test.ts` |
| Yetki değişikliği bir sonraki istekte geçerli | segment/ekip değişimi sonrası aynı token ile sonraki istek |
| Yetki kontrollü listede p95 < 200 ms | perf testine ekip kapsamlı + paylaşım kurallı senaryo |

## 9. Bilinçli sınırlar (P4a)
Delegasyon, yetki talebi, matris düzenleme/diff/sürüm, "bu kullanıcı olarak gör" → P4b. Segment değiştirici (isteğe göre daraltma) P6 kabuğuyla (API başlığı `X-Segment` P4a'da daraltma olarak desteklenir).

## 10. P4b — kayıt etrafı (dal `feat/p4b-records`)
| Konu | Karar |
|---|---|
| **Activity timeline** | `activity_events` append-only (trigger + `REVOKE UPDATE, DELETE`); servisler iş yazımıyla **aynı transaction'da** yazar: `created`, `field_changed` (alan diff'i, API alan adlarıyla), `status_changed`, `assigned`, `deleted`, `restored`, `converted`, `merged`, `comment`, `attachment`, `email_log`, `call_log`. Segment kayıttan türetilir (RLS). `GET /v1/{type}/{id}/timeline`: kaydı okuyabilen görür; **FLS**: gizli alanların diff'i çıkarılır. |
| **E-posta / arama logu** | `POST /v1/{type}/{id}/activities` (`email_log` / `call_log`: yön, konu, metin, zaman, süre) — kayıtta `create` yetkisi + okuma. |
| **Yorumlar** | `comments` + `comment_revisions` (düzenleme geçmişi); gövde ProseMirror JSON → sunucuda izinli düğümlerle üretilen `body_html` + `body_text`. Silme: yazar veya kaynakta tenant geneli `archive`; yumuşak silme, geçmiş korunur. |
| **Mention (ADR-0017 §2)** | Kullanıcı mention'ı: hedef kaydı okuyamıyorsa **422 `MENTION_TARGET_NO_ACCESS`** (yalnızca çağıranın görebildiği kullanıcıları adlandırır). Ekip mention'ı: erişimi olmayan üyeler sessizce atlanır (`via_team_id`). Düzenlemede yalnızca yeni anılanlara bildirim; kaldırılanların mention'ı ve okunmamış bildirimi geri çekilir. En fazla 20 kullanıcı + 3 ekip. `mentions.create` izni (A27). |
| **Bildirimler** | `notifications` (referans, içerik değil) + `notification_preferences`. Türler: `mention`, `assigned` (kayıt başkasına atanınca). `GET /v1/notifications` **okuma anında yetki** (MEN-09): kayda erişim kaybedildiyse başlık/kayıt adı boş, `accessible:false`. Okundu, tümünü okundu, okunmamış sayısı, tercihler (A28). Push/e-posta özet kanalları ve SSE P5 (outbox + worker). |
| **Dosya ekleri (ADR-0013 §2)** | S3 uyumlu (dev/test: MinIO). `initiate` (yetki, boyut ≤ 25 MB, MIME beyaz listesi) → 5 dk imzalı PUT → `complete` (nesne boyutu ve **sihirli bayt** doğrulaması; uyuşmazlık → nesne silinir, 422) → tarama kancası (`ATTACHMENT_SCANNER`: yoksa durum açıkça `unscanned`) → indirme: her istekte yetki + 60 sn imzalı GET, `Content-Disposition: attachment`. Karantina/enfekte dosya indirilemez. |
| **Audit okuma (A23)** | `GET /v1/audit`: Admin tümü; Yönetici yalnızca ekip üyelerinin eylemleri; filtre (eylem öneki, aktör, hedef, tarih) + cursor. |
| **Delegasyon (A07)** | Delegator kendi rollerinden birini ve segmentlerinden bir alt kümeyi süreli devreder → `user_roles.valid_until` / `user_segment_grants.valid_until` ile gerçekleşir (süre dolunca bir sonraki istekte geçersiz, SCN-18); `delegations` kaydı + iptal. Admin herkese; Yönetici yalnızca yönettiği ekip üyelerine, kendine değil, kendi yetkisini aşmadan. Süre dolumunun audit satırı P5 zamanlanmış işiyle (yetki kaldırma zaten anında). |
| **Yetki talebi** | `access_requests` (rol veya segment, gerekçe, istenen süre) → Admin veya talep edenin Yöneticisi onaylar/reddeder (aynı sınırlarla); onay delegasyonla aynı yoldan uygulanır. |
| **Matris yönetimi (AUTH-11, A03)** | Tenant'a özel `role_grant_overrides` (rol × izin → grant ya da kaldırma) + `matrix_versions` anlık görüntüleri. `GET /v1/authz/matrix` (kapalı modül izinleri gizli), `POST …/preview` (diff), `PUT` (yeni sürüm), `POST …/versions/{n}/restore` (geri alma). Admin'in korunan izinleri kaldırılamaz; motor (`can`, `recordScope`) override'ları istek bağlamından okur. |

### P4b kabul kriterleri ↔ testler
| Kriter | Test |
|---|---|
| Timeline alan diff'leri, durum geçişi, atama, oluşturma/silme; değiştirilemez | `records.int.test.ts` + DB testi (UPDATE/DELETE reddi) |
| Gizli alanın diff'i timeline'da görünmez | aynı |
| Mention: erişimsiz hedef 422, ekip genişletme, düzenlemede yalnızca yeniye bildirim, geri çekme | aynı |
| Bildirim okuma anında yetki (SCN-17) | erişim kaldırıldıktan sonra içerik gizli |
| Dosya: imzalı yükleme/indirme, sihirli bayt, yetkisiz indirme 404 | MinIO kapsayıcısıyla |
| Audit: Yönetici yalnızca ekibinin eylemlerini görür | aynı |
| Delegasyon süresi dolunca yetki kalkar (SCN-18); Yönetici sınırları | aynı |
| Matris düzenleme bir sonraki istekte geçerli; diff; geri alma; korunan izin | aynı |
