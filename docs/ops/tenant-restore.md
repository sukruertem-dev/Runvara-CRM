# İşletim: tenant yedekten geri yükleme, silme ve operatörler

> P7c (TEN-05, TEN-08, TEN-11). Bu belge nöbetçi/işletim ekibi içindir.

## Platform operatörü ekleme ve çıkarma
- Operatörün uygulamada bir hesabı olmalıdır ve iki adımlı doğrulamayı açmış olmalıdır. Operatör uç noktaları ikinci faktörle açılmamış oturumu reddeder (`OPERATOR_MFA_REQUIRED`).
- Uygulama rolü operatör tablosuna yazamaz. İşlem sahip bağlantısıyla yapılır:

```text
DATABASE_OWNER_URL=postgres://flexa_owner:…@postgres:5432/flexa node packages/db/dist/cli.js operator grant ece@flexa.example
DATABASE_OWNER_URL=postgres://flexa_owner:…@postgres:5432/flexa node packages/db/dist/cli.js operator revoke ece@flexa.example
```

- Her operatör eylemi iki yere yazılır: `operator_actions` (silinmez; tenant silinse de kalır) ve ilgili tenant'ın `audit_log`'u (`actor_type = operator`).

## Destek erişimi
- Talep, onay, ret, iptal ve süre dolumu `support_access_grants` tablosundadır.
- Destek oturumundaki her istek tenant audit'ine `support.request` olarak yazılır (yöntem, yol).
- Acil kesme: tenant Admin'i "Erişimi sonlandır" der; operatör de "Erişimi bitir" diyebilir. Bir sonraki istek 401 `SUPPORT_ACCESS_ENDED` alır.
- Platform düzeyinde (örneğin hesabın ele geçirilmesi şüphesinde) operatör işareti kaldırılır ve oturumları kapatılır:

```sql
DELETE FROM platform_operators WHERE user_id = '…';
UPDATE auth_sessions SET revoked_at = now(), revoke_reason = 'operator_removed' WHERE user_id = '…' AND revoked_at IS NULL;
```

## Tenant silme (TEN-05)
- Admin silmeyi ister → `pending_deletion`, bekleme süresi `privacy.deletionGraceDays` (7–90, varsayılan 30).
- Bekleme süresinde yalnızca durum, iptal ve dışa aktarma ekranları açıktır.
- Saatlik `tenant-purge` işi süresi dolanları siler. Sıra:
  1. Nesne depolamadaki dosyalar (ekler, dışa aktarmalar).
  2. `app.purge_tenant()`: tüm tenant satırları yabancı anahtar sırasıyla, iki geçişte; sonunda hiçbir satır kalmadığı doğrulanır. Ekleme-yalnız tablolar (audit, ayar sürümleri) yalnızca bu fonksiyonun içinde silinebilir.
  3. DEK (`tenant_keys`) silinir: crypto-shredding. Şifreli alanlar (webhook ve SSO sırları) yedeklerde de okunamaz olur.
  4. Başka çalışma alanı üyeliği olmayan kişiler anonimleştirilir (e-posta, ad, parola, 2FA).
  5. Tenant satırı `deleted` mezar taşı olarak kalır; adresi `deleted-…` olur.
  6. `operator_actions` tablosuna `tenant.purged` yazılır: tablo başına satır sayısı, içerik yok.
- Başarısız silme bir sonraki saatte yeniden denenir. Tenant bu sürede `pending_deletion` kalır (giriş kapalı). Log: `purge of <id> failed`.
- Yedeklerde kalan düz metin satırlar, yedek saklama süresi (35 gün) bitince kaybolur (B73).

## Tek tenant'ı yedekten geri yükleme (TEN-11)
Ne zaman: yanlışlıkla silinmiş bir tenant (bekleme süresi bittikten sonra), ya da bir tenant'ın verisinin belirli bir ana döndürülmesi.

1. **Yedeği geçici bir sunucuya açın.** İstenen anın yedeğini (PITR veya günlük döküm) üretim dışı bir PostgreSQL'e geri yükleyin. Üretim veritabanına dokunmayın.
2. **Tenant kimliğini bulun:**

   ```sql
   SELECT id, slug, status FROM tenants WHERE slug = 'firma-adresi';
   ```

   Silinmiş bir tenant'ın üretimdeki adresi `deleted-…`'dir. Kimlik aynıdır.
3. **Hedefi hazırlayın.** Hedefte tenant'ın satırı olmamalıdır. Silinmiş tenant'ın mezar taşının üzerine yazılır. Geri alınacak canlı bir tenant için önce silinmesi gerekir: `pending_deletion` + bekleme süresinin sonu, ardından `app.purge_tenant`. Bu adım için onay alın.
4. **Kopyalayın.** İki bağlantı da süper kullanıcıdır: kopya, yabancı anahtar ve ekleme-yalnız tetikleyicilerini yalnızca kendi transaction'ında kapatır. Kopyalama tek transaction'dadır; hata olursa hiçbir şey yazılmaz.

   ```text
   RESTORE_SOURCE_URL=postgres://postgres:…@geri-yukleme:5432/flexa \
   RESTORE_TARGET_URL=postgres://postgres:…@uretim:5432/flexa \
   node packages/db/dist/cli.js restore-tenant <tenant id>
   ```

   Anonimleştirilmiş üye hesapları yedekteki bilgilerine döner; başka kullanıcıların hesaplarına dokunulmaz.
5. **Dosyalar.** Ek dosyaları nesne depolama yedeğinden `tenants/<id>/` önekiyle geri kopyalayın. Veritabanı satırları dosya anahtarlarını taşır.
6. **Doğrulayın.** Operatör konsolunda tenant'ın durumuna, planına ve üye sayısına bakın. Bir Admin ile giriş yapıp son kayıtları kontrol edin.
7. **Kaydedin.** `operator_actions` tablosuna geri yüklemenin nedenini ve kimin yaptığını not edin (operatör konsolunda "durum değiştir" gerekçesi veya bir olay kaydı).

Sınırlar:
- Silinmiş bir tenant'ın şifreli alanları (webhook ve SSO sırları) yedekten gelir, ama DEK'i de yedekte olmalıdır. `tenant_keys` satırı yedeğin parçasıdır. DEK'siz kopya bu alanları okuyamaz; sırlar yeniden girilir.
- Kopyalama `outbox_events` satırlarını da taşır. İşlenmiş olaylar `processed_events` sayesinde ikinci kez uygulanmaz.
