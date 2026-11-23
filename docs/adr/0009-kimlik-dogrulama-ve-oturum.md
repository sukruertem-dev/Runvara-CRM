# ADR-0009: Kimlik doğrulama, oturum ve API anahtarları

- Durum: Önerildi · Tarih: 2026-11-20 · Kapsam: Faz 1, G1 (SSO), Faz 5 (API anahtarı) · Gereksinimler: 3 (Kimlik), TEN-04, NFR-04

## Karar

### Parola ve hesap
- argon2id (m=64 MiB, t=3, p=1; parametreler `user_credentials` içinde saklanır, girişte yükseltme). Parola politikası tenant ayarı (en az 12 karakter varsayılan, HIBP k-anonimlik kontrolü isteğe bağlı/çevrimdışı liste).
- E-posta doğrulama ve parola sıfırlama: tek kullanımlık, 30 dk geçerli, yalnızca hash'i saklanan token; yanıtlar hesap varlığını sızdırmaz.
- Brute-force: hesap + IP başına kademeli gecikme ve 10 başarısız denemede 15 dk kilit; audit `auth.login_failed`.

### Oturum modeli
- **Erişim token'ı:** JWT, EdDSA (Ed25519), 10 dk; claim'ler `sub, tid, sid, av (authz_version), amr`; bellekte tutulur (localStorage yok).
- **Refresh token:** opak 256-bit, `refresh_tokens` içinde hash, **rotasyon** her kullanımda; aile kimliği (`family_id`) ile **yeniden kullanım tespiti** → tüm aile iptal + güvenlik bildirimi. Çerez: `__Host-fx_rt`, `HttpOnly; Secure; SameSite=Strict; Path=/`.
- **CSRF:** refresh ve çıkış uç noktaları çerezle çalıştığı için `SameSite=Strict` + çift gönderim token'ı (`X-CSRF-Token` = imzalı `__Host-fx_csrf`). Diğer tüm API çağrıları Bearer başlığıyla → CSRF yüzeyi yok.
- **Tenant seçimi:** giriş sonrası kullanıcı birden çok tenant'a üyeyse seçim; seçilen tenant `tid` olarak yeni erişim token'ına girer. Tenant değiştirmek yeni token ister.
- Yetki/rol değişikliği veya kullanıcı askıya alma: `authz_version` artışı (ADR-0004); askıya alma/parola değişikliği ayrıca tüm refresh ailelerini iptal eder.

### 2FA
- TOTP (RFC 6238, SHA-1, 30 sn, ±1 pencere), gizli anahtar tenant DEK ile şifreli; 10 kurtarma kodu (hash'li, tek kullanımlık). Tenant politikası: zorunlu/rol bazlı zorunlu/isteğe bağlı. WebAuthn (passkey) sonraki sürüm.

### SSO
- OIDC: `openid-client`, Authorization Code + PKCE, `state`/`nonce`; tenant başına IdP yapılandırması; JIT kullanıcı oluşturma isteğe bağlı, e-posta alan adı doğrulaması gerekli.
- SAML 2.0 (G1, S önceliği): `@node-saml/node-saml`, imzalı assertion zorunlu, `InResponseTo` ve tekrar oynatma koruması.

### API anahtarları (Faz 5) ve servis istemcileri (G7)
- Biçim: `fx_live_<prefix8>_<secret32>`; yalnızca SHA-256 hash saklanır; `resolve_api_key()` definer fonksiyonu tenant'ı çözer. Kapsamlar (scope) izin anahtarlarının alt kümesi; anahtar bir "servis kullanıcısı" bağlamında yetkilendirilir (insan kullanıcının yetkisinden bağımsız, en az yetki).
- Data Servisi istemcileri ayrıca mTLS (istemci sertifika parmak izi kaydı) seçeneği.

### Platform Operatörü
Ayrı kimlik tablosu, ayrı alan adı ve ayrı çerez; tenant oturumu ile karışmaz. Zorunlu 2FA; destek erişimi ADR-0014.

## Sonuçlar
- (+) Kısa ömürlü JWT + sürüm kontrolü ile hem durumsuz doğrulama hem anında yetki geçersiz kılma.
- (−) Her istekte `memberships.authz_version` için tek satırlık PK okuması (Redis'te 2 sn mikro önbellek ile maliyet düşürülür; "bir sonraki istek" garantisi için iptal anında önbellek anahtarı silinir).

## P6a uygulama notu: rotasyonda kaybolan yanıt (B52)
- **Sorun:** Tam sayfa yüklemesi refresh çerezini döndürür. Yanıt tarayıcıya ulaşmadan sayfadan çıkılırsa (yaklaşık 100 ms'lik pencere), bir sonraki yükleme eski belirteci sunar. Sıkı yeniden kullanım kuralı bu durumda kullanıcının oturumunu kapatır. P6a'nın uçtan uca testleri bunu yakaladı.
- **Karar:** Döndürülmüş bir belirteç **30 sn içinde** bir kez daha sunulur ve halefi **hiç kullanılmamışsa**, halef tüketilir (`consumed_by_grace = true`) ve yeni bir belirteç verilir; oturum sürer.
- **Hırsızlık tespiti korunur, en fazla bir adım gecikir:**
  - Gerçek sahip elindeki halefi sunduğunda o belirteç kullanılmış sayılır ve aile iptal edilir.
  - `consumed_by_grace` ile tüketilmiş bir belirteç tanıma alamaz. Böylece iki taraf sırayla yenileme yaparak çalınmış bir aileyi açık tutamaz.
  - Halef kullanılmışsa ya da 30 sn geçmişse eski kural aynen geçerlidir: aile hemen iptal edilir.
- **Kanıt:** `auth.int.test.ts` "survives a lost refresh response…", "rotates, detects reuse…".

## P7d uygulama notu: tenant güvenlik politikası ve SAML
- **Politika nerede uygulanır:** oturumun bir tenant'a bağlandığı her anda (giriş, tenant seçimi, yenileme, SSO dönüşü), `SecurityPolicyService.check` ile. Her istekte değil: sıkılaştırma en geç erişim belirtecinin ömründe (10 dk) etkili olur (B76).
- **Oturumun yöntemleri** artık belirteçten değil oturum satırından okunur. Oturum sırasında kanıtlanan ikinci faktör (2FA kurulumu, step-up) satıra eklenir; yeniden giriş gerekmez.
- **Parola kuralı:** parola kişiye, kural tenant'a aittir. Girişte parolanın uzunluğu ve karma olup olmadığı oturuma yazılır (parola değil, B77).
- **SAML:** `@node-saml/node-saml` 5.2; yalnızca SP başlatmalı giriş, imzalı assertion, `InResponseTo` tek kullanımlık ve tekrar reddi Redis'te (B78). IdP sertifikası elle girilir; döndürme için en çok üç sertifika.
- **Kanıt:** `security-policy.int.test.ts`, `saml.int.test.ts`, E2E `security.spec.ts`.
