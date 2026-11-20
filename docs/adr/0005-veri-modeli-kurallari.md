# ADR-0005: Veri modeli kuralları (polimorfik ilişki, sahiplik, kuyruklar, sıralama, para)

- Durum: Önerildi · Tarih: 2026-11-20 · Kapsam: Faz 2–3 ve sonrası · Gereksinimler: DM-02, DM-08, TRK-01

## 1. Polimorfik ilişki: `record_registry` ile gerçek FK

**Sorun:** `related_type + related_id` alanı normal FK ile korunamaz; yalnızca uygulama doğrulaması yarış koşullarında yetimi engelleyemez.

**Karar:**
```sql
CREATE TABLE record_registry (
  tenant_id   uuid NOT NULL,
  record_type text NOT NULL,          -- 'account','contact','lead','opportunity','case','quote','order','call', ...
  record_id   uuid NOT NULL,
  segment     segment NULL,           -- işlem kayıtları için; kimlik kayıtları NULL
  deleted_at  timestamptz NULL,
  PRIMARY KEY (tenant_id, record_type, record_id)
);
-- Her ilişkilendirilebilir tabloda AFTER INSERT/UPDATE OF deleted_at/DELETE trigger'ı kaydı senkron tutar.
-- tasks, notes, activity_events, attachments, mentions, calls ...:
ALTER TABLE tasks ADD CONSTRAINT tasks_related_fk
  FOREIGN KEY (tenant_id, related_type, related_id)
  REFERENCES record_registry (tenant_id, record_type, record_id)
  ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
```
- `related_type` değerleri `record_types` kataloğuyla CHECK edilir (kodda tek enum, migration'da üretilir).
- Kalıcı silmede (yalnızca Admin, KVKK) bağlı kayıtlar önce taşınır/anonimleştirilir; `RESTRICT` sessiz yetimi imkânsız kılar.
- Servis katmanı ayrıca hedef kaydın **okuma yetkisini** doğrular (var ama yetkisiz kayda bağlantı → 404).

## 2. Sahiplik
- `owner_type ∈ {user, queue}` + `owner_id`; ek olarak sorgu performansı için türetilmiş `owner_user_id` (owner_type=user ise) ve `queue_id` (owner_type=queue ise) sütunları, CHECK ile tutarlılık.
- Görevde ek `assignee_user_id` (kuyruktan çekildiğinde).

## 3. Kuyruklar (tek kavram)
```sql
CREATE TABLE queues (id uuid, tenant_id uuid, kind text CHECK (kind IN ('work','call')), name text, segment segment NULL, ...);
CREATE TABLE queue_members (tenant_id uuid, queue_id uuid, user_id uuid, role text CHECK (role IN ('member','supervisor')), PRIMARY KEY (tenant_id, queue_id, user_id));
CREATE TABLE telephony_queue_mappings (tenant_id uuid, queue_id uuid, provider_id uuid, provider_queue_ref text, UNIQUE (provider_id, provider_queue_ref));
CREATE TABLE record_queue_links (tenant_id uuid, record_type text, record_id uuid, queue_id uuid, linked_at timestamptz, source text, PRIMARY KEY (tenant_id, record_type, record_id, queue_id));
```
Görev sahipliği `work` kuyruğu, çağrı yönlendirmesi `call` kuyruğu kullanır; "Kuyruk" kapsamı ikisini de kapsar (ADR-0004).

## 4. Kişi iletişim noktaları
`contact_points(tenant_id, owner_type ∈ {contact, account, lead}, owner_id, kind ∈ {phone, email, …}, value, e164 NULL, is_primary, verified_at)`; `(tenant_id, e164)` indeksli → ekran açma ve lookup. Telefon değerleri yazılırken `libphonenumber-js` ile E.164'e normalize edilir (varsayılan ülke = tenant ülkesi).

## 5. Sıralama (fractional indexing)
- `position text COLLATE "C"`; anahtarlar `fractional-indexing` algoritmasıyla iki komşu arasında üretilir.
- Yeniden dengeleme: anahtar uzunluğu 32'yi aşarsa ilgili kapsam (ör. bir Kanban sütunu) arka plan işiyle `FOR UPDATE` altında yeniden numaralanır; istemciye `positions.rebalanced` olayı.
- Eşzamanlı aynı konuma ekleme: anahtara 4 karakterlik rastgele sonek (çakışma olasılığı ihmal edilebilir; UNIQUE (scope, position) ile korunur, çakışmada yeniden üretim).

## 6. Para ve kur
`amount numeric(18,4)`, `currency char(3)` (ISO 4217); `fx_rates(tenant_id, base, quote, rate numeric(20,10), valid_on date)`. Rapor dönüşümü işlem tarihindeki kurla; kur yoksa en yakın önceki gün, yoksa rapor satırı "kur eksik" uyarısıyla dönüştürülmeden gösterilir (sessiz yanlış toplam yok).

## 7. Soft delete ve arşiv
- `deleted_at` = kullanıcı silme (geri yüklenebilir, 30 gün); `archived_at` = Yönetici arşivi (geri alınabilir, süresiz). Kalıcı silme yalnızca Admin + saklama politikası işi.
- Varsayılan sorgular `deleted_at IS NULL`; repository'de açıkça `includeDeleted` olmadan silinmiş kayıt dönmez.

## 8. İyimser eşzamanlılık
Her güncellenebilir kayıtta `version int`; PATCH `If-Match: "<version>"` ister; uyuşmazlıkta 409 `VERSION_CONFLICT` + güncel kayıt (arayüzde çakışma uyarısı, Faz 6).

## Sonuçlar
- (+) Polimorfik bütünlük DB tarafından garanti.
- (−) `record_registry` her ilişkilendirilebilir yazmada ek satır; tek tablo olduğu için tenant başına bölümleme (hash partition, 16) Faz 8 yük testine göre değerlendirilir.
