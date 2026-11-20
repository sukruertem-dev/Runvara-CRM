# ADR-0004: Merkezi yetki motoru (`can()` + SQL predicate)

- Durum: Önerildi · Tarih: 2026-11-20 · Kapsam: Faz 4 + G2 (tek motor), tüm yüzeyler · Gereksinimler: AZ-*, AUTH-01…11, SEG-03, 10.2.3, CC-05, DS-04, MEN-03/09, AIQ-02, AIR-03/04/05

## Bağlam
Kaynak iki yetki tanımı içerir: Faz 4 (RBAC + rol hiyerarşisi + OWD + sharing rule + FLS) ve 10.2.3 (modül ∧ rol ∧ segment ∧ kapsam ∧ alan). Bunlar ayrı motorlar olarak yazılırsa yüzeyler arasında karar farkı (= sızıntı) oluşur. Ayrıca liste sorgularında "sonradan filtreleme yok" şartı, kararın SQL'e derlenebilir olmasını gerektirir.

## Karar

### 1. Tek model
```text
allow(ctx, action, resource) =
     moduleEnabled(ctx.tenant, module(action))                  → değilse 404 MODULE_DISABLED
   ∧ rolePermits(ctx, action) = scope ≠ none                     → değilse 403 (kayıt görünürse) / 404
   ∧ segmentAllowed(ctx.segments, resource.segment[s])           → değilse 404
   ∧ inScope(ctx, scope, resource) ∨ shared(ctx, resource)
       ∨ hierarchyAllows(ctx, resource) ∨ owdBaseline(resource)  → değilse 404
   ∧ fieldPolicy(ctx, resource.type, fields)                     → gizli alan yanıtta yok; yazma girişiminde 403
```
Faz 4'teki OWD, rol hiyerarşisi ve sharing rule'lar **kapsamı genişleten** ek terimlerdir; segment ve modül koşulunu hiçbir terim aşamaz.

### 2. İzin anahtarları ve kapsam
- Anahtar: `<modül>.<kaynak>.<eylem>` (ör. `sales_b2b.quote.send`, `call_center.recording.listen`). Tam katalog: `docs/enterprise/permission-matrix.yaml`.
- Değer: kapsam `none | own | queue | team | segment | all` + isteğe bağlı bayraklar (`approve_limit`, `policy`, `request_only`).
- Kapsam tanımları (10.4.2) predicate olarak:

| Kapsam | Predicate (özet) |
|---|---|
| own | `owner_user_id = :me` ∨ `assignee_user_id = :me` ∨ (`owner_type='queue'` ∧ `owner_id ∈ :myWorkQueues` ve kaynak görev ise) |
| queue | `queue_id = ANY(:myQueues)` ∨ `EXISTS record_queue_links(record, queue ∈ :myQueues)` ∨ aktif/wrap-up çağrı erişimi (`call_access_grants`, çağrı bitişinden sonra 24 saat) |
| team | `owner_user_id = ANY(:teamMemberIds)`; Yönetici için yönettiği ekipler + alt ekipler, üye için üyesi olduğu ekipler |
| segment | segment koşulu dışında ek kısıt yok |
| all | ek kısıt yok |

- Kapsam sırası (delegasyon/yetki verme karşılaştırması için): `own < {queue, team} < segment < all`; `queue` ve `team` birbirinin üstü değildir.

### 3. API
```ts
can(ctx: AuthzContext, action: PermissionKey, resource: ResourceRef): Decision
predicate(ctx: AuthzContext, resourceType: ResourceType, action: 'read' | 'update' | 'delete' | …): SQL
fieldMask(ctx: AuthzContext, resourceType: ResourceType, mode: 'read' | 'write'): FieldMask
type Decision = { allow: true } | { allow: false; status: 404 | 403; reason: DenyReason }
```
- `predicate()` tüm okuma yüzeylerinde **zorunlu** tek giriş noktasıdır: liste, sayım, arama, öneri, rapor, dashboard, export, SSE abonelik süzgeci, bildirim okuma, ekran açma, Data Servisi, AI veri toplayıcı. Repository katmanı predicate'siz okuma fonksiyonu sunmaz.
- Tekil erişim: `SELECT … WHERE id = $1 AND <predicate>`; satır yoksa 404 (kaydın var olup olmadığı ayırt edilemez). Satır var ama eylem yetkisizse 403.
- Görev/aktivite erişiminin parent'tan türetilmesi: `related_type` başına `related_id IN (SELECT id FROM <tablo> WHERE <predicate(tablo)>)` alt sorgusu; yalnızca kullanıcının okuma izni olan tipler için üretilir.

### 4. Alan düzeyi güvenlik (FLS)
- `field_policies(tenant_id, role_id, resource_type, field, access ∈ {hidden, read, write})`; varsayılanlar matristen (maliyet/marj Satış ve Çağrı Temsilcisi'nden gizli).
- Gizli alan: yanıttan çıkarılır; RQL/filtre/sıralama/gruplama/toplamada **"bilinmeyen alan"** hatası (var olmayan alanla aynı mesaj; varlığı sızdırmaz); arama indeks vurgulamasında kullanılmaz; export sütunlarında yok; AI temizleyicide düşürülür.

### 5. AuthzContext ve geçersiz kılma
- Bağlam: `{tenantId, userId, roleIds, permissions, segments(etkin + süreli), teamIds(member/managed), queueIds, roleHierarchyPath, fieldPolicies, enabledModules, salesMode, authzVersion, tenantAuthzEpoch, impersonatedBy?}`.
- Önbellek anahtarı: `t:{tenant}:authz:{user}:{memberships.authz_version}:{tenants.authz_epoch}`; TTL 5 dk.
- Kullanıcıya özgü değişiklik (rol ataması, segment, ekip, delegasyon, süre dolumu) → `memberships.authz_version += 1`. Rol matrisi/modül/satış modu değişikliği → `tenants.authz_epoch += 1`. Her istek sürümleri DB'den (tek satır, birincil anahtar) okur ve önbellekle karşılaştırır → **en geç bir sonraki istekte** yeni yetki (G2 kabul kriteri).
- SSE bağlantıları sürüm değişiminde `authz.changed` olayı alır; sunucu abonelik süzgecini yeniden kurar.

### 6. Segment
Etkin segment kümesi = kullanıcı yetkisi ∩ tenant satış modu ∩ (istekteki segment değiştirici seçimi). Değiştirici yalnızca **daraltır**. RLS'e `app.segments` olarak geçer (ADR-0010).

### 7. Yönetici sınırları (AUTH-06) — istisnasız kurallar
1. Yönetici yalnızca **yönettiği ekiplerin** üyeleri üzerinde işlem yapar.
2. Verdiği her izin anahtarı için kendi kapsamı ≥ verilen kapsam; verdiği her segment kendi segment kümesindedir.
3. Kendi rolünü, segmentini, kapsamını, delegasyonunu değiştiremez (hedef = kendisi → 403).
4. Admin sistem rolünü veya `admin.*` / `platform.*` / `authz.matrix.edit` içeren herhangi bir rolü atayamaz.
5. Rol × yetki matrisini düzenleyemez (yalnızca kendi ekibi için okuma).
6. Onay motorunda kendi `approve_limit` değerini aşan talebi onaylayamaz; talep bir üst onaylayıcıya eskale olur.
Bu kurallar `can()` içinde `authz.grant.*` eylemleri için kodlanır ve matris testlerinden ayrı, adlandırılmış testlerle doğrulanır (SCN-07, SCN-08).

### 8. Sistem rolleri ve korunan yetkiler
Sistem rolleri (Admin, Yönetici, Satış Temsilcisi, Çağrı Temsilcisi, Analist) silinemez. Admin'den `authz.matrix.edit`, `tenant.modules.manage`, `users.manage` kaldırılamaz; tenant'ta en az bir etkin Admin kalmalıdır (son Admin'in rolü değiştirilemez).

### 9. Özel notlar
`notes.visibility = 'private'` → yalnızca yazar okur (Admin dahil başkası okuyamaz; KVKK veri dışa aktarımında yazarın verisi olarak yer alır). Başkası adına üretilen rapor/özette yer almaz (AIR-05).

### 10. "Bu kullanıcı olarak gör"
Yalnızca Admin; hedef kullanıcının bağlamı **salt okuma** modunda kurulur (`impersonatedBy` dolu → tüm yazma eylemleri 403), süreli (15 dk), her açılış audit'li, hedef kullanıcıya bildirim.

### 11. Red nedenleri ve gözlemlenebilirlik
Her ret `authz.denied` debug logu: `{reason: module_disabled | no_permission | segment | scope | field | manager_limit, action, resourceType}` (kayıt id'si yalnızca hash olarak). Yanıt gövdesi red nedenini 404'te **içermez**.

## Kanıt
- `permission-matrix.yaml` → test üretici (`packages/test-utils/matrix`) rol × eylem × segment × kapsam kombinasyonlarını üretir (G2 kabul kriteri).
- 10.4.4 ve 11.4 karar senaryoları adlandırılmış entegrasyon testleri.
- Performans: predicate'li liste sorgusu p95 < 200 ms (10 bin kayıt), `EXPLAIN ANALYZE` kaydı.

## Alternatifler
| Alternatif | Neden seçilmedi |
|---|---|
| OPA/Rego veya Cedar | Kararı SQL predicate'e derlemek ayrı bir kısmi değerlendirme katmanı gerektirir; liste/sayım doğruluğu için tek kod yolu daha güvenli |
| Zanzibar tarzı ilişki grafiği (SpiceDB/OpenFGA) | Liste filtreleme için "lookup resources" + DB birleştirme maliyeti; harici bileşen; ölçek ihtiyacı şu an yok |
| Erişim kontrol listesi tablosu (her kayıt × kullanıcı) | Ekip/kapsam değişiminde patlayan yazma maliyeti |

## Sonuçlar
- (+) Tek kod yolu → yüzeyler arası tutarlılık; sayım ve sayfalama doğru.
- (−) Predicate karmaşıklığı sorgu planlarını etkiler; `(tenant_id, owner_user_id)`, `(tenant_id, queue_id)`, `(tenant_id, segment)` indeksleri zorunlu; `record_shares` için `(tenant_id, grantee, record_type, record_id)` indeksi.
