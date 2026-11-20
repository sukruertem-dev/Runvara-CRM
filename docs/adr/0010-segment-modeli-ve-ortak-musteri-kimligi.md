# ADR-0010: Segment modeli ve segmentler arası ortak müşteri kimliği

- Durum: Önerildi · Tarih: 2026-11-20 · Kapsam: Faz 3'ten itibaren, G2–G5, G7 · Gereksinimler: SEG-01…06, B2C-01, CC-05

## Karar

### 1. Tip ve sütunlar
```sql
CREATE TYPE segment AS ENUM ('b2b', 'b2c');
```
| Tablo sınıfı | Sütun | Örnek |
|---|---|---|
| Kimlik | `segments segment[] NOT NULL CHECK (cardinality(segments) >= 1)` | `accounts`, `contacts` |
| İşlem | `segment segment NOT NULL` | `leads`, `opportunities`, `quotes`, `contracts`, `orders`, `returns`, `campaigns`, `coupons`, `consents`, `calls`, `dialer_campaigns`, `sales_targets`, `forecast_snapshots` |
| Bağlamsal | `segment segment NULL` (NULL = segmentten bağımsız) | `tasks`, `cases`, `notes`, `activity_events`, `attachments`, `mentions`, `notifications`, `record_registry` |

Bağlamsal tablolarda `segment`, ilişkili kayıttan **yazma anında türetilir** (trigger) ve kullanıcı tarafından değiştirilemez.

### 2. RLS
```sql
CREATE FUNCTION app_segments() RETURNS segment[] LANGUAGE sql STABLE AS
$$ SELECT coalesce(nullif(current_setting('app.segments', true), '')::segment[], '{}') $$;

CREATE POLICY segment_isolation ON opportunities AS RESTRICTIVE
  USING (segment = ANY (app_segments())) WITH CHECK (segment = ANY (app_segments()));
CREATE POLICY segment_isolation ON contacts AS RESTRICTIVE
  USING (segments && app_segments()) WITH CHECK (segments && app_segments());
CREATE POLICY segment_isolation ON tasks AS RESTRICTIVE
  USING (segment IS NULL OR segment = ANY (app_segments()));
```
Boş segment kümesi (bağlam yok / yetki yok) → yalnızca segmentten bağımsız satırlar görünür.

### 3. Ortak kimlik (SEG-05)
- Bir kişi/firma tek `contacts`/`accounts` satırıdır; `segments` dizisi her iki segmenti içerebilir.
- Segmente özgü bilgiler ayrı tablolarda: `customer_profiles(contact_id, segment='b2c', rfm_*, preferences, ltv)`, B2B satın alma rolleri `account_contact_roles`.
- **Kimlik alanlarının görünürlüğü:** B2C yetkili kullanıcı, `segments` içinde `b2c` olan contact'ı görür; ancak B2B'ye özgü ilişkiler (account rolleri, opportunity'ler) kendi tablolarındaki segment politikasıyla gizlenir. Timeline olayları segment etiketlidir; Okan (B2B+B2C) iki segmenti rozetlerle görür, Tuba (B2C) yalnızca B2C olaylarını.
- Bir contact'a yeni segment ekleme: yalnızca iki segmentte de yetkili kullanıcı veya bir işlem kaydının (ör. B2C siparişi) oluşturulmasıyla otomatik; işlem audit'li.

### 4. Ekran açma ve lookup'ta segment (CC-05, DS-01)
Eşleştirme sorgusu `contact_points.e164 = $1` **ve** `predicate(agentCtx, contact, read)` ile yapılır. Eşleşme segment nedeniyle elenirse yanıt "bilinmeyen numara" ile **aynıdır** (yanıt süresi de sabitlenir: 50 ms hedef zamanlama tamponu, zamanlama yan kanalı engeli).

### 5. Satış modu değişikliği (SEG-06)
- `both → b2b_only`: B2C verisi silinmez; etkin segment kümesi hesaplamasında `b2c` düşer, B2C modülleri menü/API'den kalkar, B2C zamanlanmış işleri durur.
- Geri açma: veri ve yapılandırma aynen geri gelir. Değişiklik onay diyaloğu etkilenen kullanıcı ve kayıt sayılarını gösterir; audit + `tenant.sales_mode_changed` olayı.

## Sonuçlar
- (+) Segment izolasyonu kapsam/rol hatalarından bağımsız olarak DB'de garanti.
- (−) Kimlik tablolarında dizi kesişimi (`&&`) için GIN indeksi gerekir; çok yüksek hacimde `segments` yerine iki boolean sütun (`in_b2b`, `in_b2c`) + B-tree alternatifi Faz 8 ölçümüne göre değerlendirilir.
