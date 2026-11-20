# Flexa Düşük Sadakatli Wireframe'ler

> Durum: taslak, onay bekliyor · Tarih: 2026-11-20
> Kaynaklar: `CRM_TASK_PLATFORM_PROMPT.md` (5.5, Faz 6, 10.4.4, 10.4.5, 10.5, 11.5, 12) ve `docs/architecture.md`.
> Bu dosyada **hex renk kodu yoktur**; yalnızca token adları kullanılır (tek kaynak: Bölüm 12.5). Modül adları Bölüm 12.3'teki arayüz adlarıdır, teknik kimlikler gösterilmez.

## 0. Ortak kurallar (tüm ekranlar için geçerli)

### 0.1 Karar verilmiş düzeltmeler (bu dokümanda bağlayıcı)

| # | Kural | Gerekçe |
|---|---|---|
| a | **Koyu temada ana buton** `--accent-btn` zemin + `--on-accent` metin kullanır. `--accent` zemin + `--on-accent` çifti kontrastı 2.71:1'dir, AA'yı geçemez; koyu temada `--accent` yalnızca metin, bağlantı, seçili sekme ve odak halkası içindir. Açık temada ana buton `--primary` + `--on-primary`'dir. | Kontrast |
| b | **Girdi, onay kutusu, radyo, anahtar ve diğer bileşen sınırları `--border-strong`** (metin dışı ≥ 3:1) kullanır. `--border` yalnızca dekoratif kart/ayraç çizgisidir. | WCAG 2.2 1.4.11 |
| c | **Marka kırmızısı (`--accent`) hata değildir.** Hata her zaman `--danger` + ikon + metindir. | 10.5.1 madde 10 |
| d | **Segment rozeti her zaman ikon + etiket** taşır (B2B: bina ikonu + "B2B", B2C: kişi ikonu + "B2C"); renk tek başına anlam taşımaz. | 12.4 notu |
| e | **`--spark` yalnızca dekoratiftir**: nokta/kıvılcım olarak kullanılır, üzerine ya da altına metin konmaz; anlam her zaman yanındaki ikon/metinle verilir. | 12.4 |

### 0.2 Tipografi, şekil, yoğunluk

- Başlıklar **Space Grotesk** (500/700), gövde **Inter** (400/500), sayılar `font-variant-numeric: tabular-nums`.
- Ölçek: 12 (yardımcı metin, rozet) / 14 (gövde, tablo) / 16 (gövde-büyük, form) / 20 (kart başlığı) / 24 (sayfa başlığı) / 32 (KPI) / 44 (hero KPI, wallboard).
- Radius: girdi `--radius-input` 8, buton `--radius-btn` 12, kart `--radius-card` 16, hero kart `--radius-hero` 20.
- Gölge: açık temada `--shadow-card`; koyu temada gölge yok, yerine ince `--border` kenarlık.
- Yoğunluk: **Rahat** (satır 48 px) ve **Kompakt** (satır 32 px); kullanıcı tercihi. **Çağrı Temsilcisi varsayılanı Kompakt**, diğer roller Rahat.
- Cam efekti yalnızca yüzen katmanlarda (command palette, popover, softphone çubuğu, screen pop).

### 0.3 Küresel klavye kısayolları

| Tuş | İşlev | Not |
|---|---|---|
| `Cmd/Ctrl+K` | Command palette | Metin girişinde de çalışır |
| `/` | Arama çubuğuna odaklan | Metin alanındayken devre dışı (yazılır) |
| `C` | Yeni görev | Yalnızca odak metin alanında değilse |
| `J` / `K` | Listede sonraki / önceki satır | Liste, tablo, bildirim merkezi |
| `Enter` / `E` | Satırı aç / satır içi düzenle | |
| `X` | Satırı çoklu seçime ekle | |
| `G` sonra `B` | "Bugün" ekranına git | İki tuşlu dizi, 1 sn zaman aşımı |
| `?` | Kısayol yardımı | |
| `Esc` | Katman/panel/palette kapat, seçimi temizle | |
| `Z` | Son işlemi geri al (toast `Geri al` ile aynı) | |

**Çağrı kısayolları** (yalnızca `Çağrı merkezi ve santral` etkin ve yetkiliyse; tarayıcı ve işletim sistemi çakışmasını önlemek için hepsi `Alt+` kombinasyonudur, `event.code` ile eşlenir, macOS'ta `Option+`; Alt+D, Alt+F, Alt+H, Alt+E gibi tarayıcı menü tuşları bilerek kullanılmaz):

| Tuş | İşlev |
|---|---|
| `Alt+K` | Çağrıyı **k**abul et |
| `Alt+L` | Çağrıyı kapat (**l**) |
| `Alt+B` | **B**ekletmeye al / bekletmeden çıkar |
| `Alt+T` | **T**ransfer / aktar |
| `Alt+M` | Mikrofonu sessize al |
| `Alt+S` | **S**onuç kodu (disposition) seçicisini aç |
| `Alt+N` | Çağrı **n**otuna odaklan |
| `Alt+R` | Durumu **R**"Hazır"a al |
| `Alt+Y` | Mola/durum seçicisini aç |
| `Alt+O` | Screen pop kartını aç / kapat (**o**) |

Kısayollar kullanıcı ayarlarından değiştirilebilir; `?` yardımında yalnızca kullanıcının yetkili olduğu modüllerin kısayolları listelenir. Çakışma denetimi: kısayol atanırken küresel/tarayıcı listesiyle karşılaştırılır ve çakışma uyarılır.

### 0.4 Ortak durum, hareket ve a11y kuralları

- **Yükleniyor:** içerik şeklinde iskelet (skeleton); `--bg-subtle` zemin, hafif kayan parlama. Spinner yalnızca <400 ms'yi aşan buton eylemlerinde.
- **Boş:** kısa sıcak metin + tek aksiyon + füme çizgi illüstrasyon, en fazla bir kırmızı detay (`--accent`).
- **Hata:** `--danger-soft` zemin, `--danger` ikon + metin, "Yeniden dene" aksiyonu; kırmızı marka rengiyle karıştırılmaz.
- **Çevrimdışı / bağlantı koptu:** üstte kalıcı şerit (`--warning-soft` zemin, `--warning` ikon + "Bağlantı koptu, yeniden bağlanılıyor…"); SSE `Last-Event-ID` ile kaldığı yerden devam eder; düzenleme alanları kuyruğa alır, "Senkronize edilemedi" listelenir.
- **Hareket:** Framer Motion mikro animasyonlar 120-200 ms; `prefers-reduced-motion: reduce` altında tüm kayma, nabız ve kıvılcım animasyonları kapanır; yerine statik durum göstergesi (dolu nokta + metin) kalır.
- **Odak:** tüm etkileşimli öğelerde 2 px `--accent` halka + 2 px boşluk (koyu temada da `--accent`). Odak yakalama (focus trap) yalnızca modal ve palette'te; kapanınca odak tetikleyiciye döner.
- **Canlı bölgeler:** `aria-live="polite"` bildirim toast'ları, screen pop, streaming AI metni, bağlantı durumu; `assertive` yalnızca kritik hata (ödeme/çağrı düşmesi) için.
- **Segment ve rol gizleme:** yetkisiz modül menüde, palette'te, aramada ve URL'de yoktur (URL → 404). Alan düzeyinde gizli alanlar **hiç render edilmez** (placeholder, "***" veya kilit ikonu yok).
- **Duyarlı kırılımlar:** mobil <640 (tek sütun, alt gezinme), tablet 640-1023 (yan menü ikon raylı), masaüstü ≥1024.

### 0.5 Demo kişileri (örnek veri için)

Ayşe Yılmaz (Admin), Mert Kaya (Yönetici, B2B), Elif Demir (Yönetici, B2C), Burak Aydın (Yönetici, B2B+B2C), Can Öz (Satış Temsilcisi, B2B), Zeynep Arslan (Satış Temsilcisi, B2C), Deniz Çelik (Satış Temsilcisi, B2B+B2C), Tuba Sönmez (Çağrı Temsilcisi, B2C), Okan Tekin (Çağrı Temsilcisi, B2B+B2C), Selin Acar (Analist). Örnek tenant: "Atlas Teknoloji".

---

## 1. Giriş, 2FA adımı ve tenant seçimi

```text
+------------------------------+---------------------------------------------+
| (koyu füme marka alanı)      |  (kırık beyaz zemin)                        |
|                              |                                             |
|        [ᚱ•]  flexa         |   Hoş geldiniz                              |
|                              |   Hesabınıza giriş yapın                    |
|                              |                                             |
|                              |   E-posta                                   |
|                              |   [ can.oz@atlas.example               ]    |
|                              |   Parola                                    |
|                              |   [ ••••••••••••               [göster] ]   |
|                              |   [x] Bu cihazı hatırla     Parolamı unuttum|
|                              |                                             |
|                              |   [        Giriş yap        ]               |
|                              |   ----------- veya -----------              |
|                              |   [ Kurumsal oturum (SSO) ile devam ]       |
|                              |                                             |
|                              |   TR | EN          Açık / Koyu / Sistem     |
+------------------------------+---------------------------------------------+

--- 2FA adımı (aynı sağ panel) ---
|   İki adımlı doğrulama                                                      |
|   Doğrulama uygulamanızdaki 6 haneli kodu girin                             |
|   [ 4 ][ 8 ][ _ ][ _ ][ _ ][ _ ]    (6 hücre, otomatik ilerler)            |
|   [   Doğrula   ]      Yedek kod kullan      Geri                           |
|   (!) Kod hatalı. Kalan deneme: 3                                           |

--- Tenant seçimi (birden fazla çalışma alanı varsa) ---
|   Çalışma alanı seçin                                                       |
|   ( ) [A] Atlas Teknoloji        Satış Temsilcisi    B2B                    |
|   ( ) [N] Nehir Perakende        Çağrı Temsilcisi    B2C                    |
|   [   Devam et   ]                                                          |
```

**Token kullanımı**
- Sol alan: `--bg-canvas` (koyu tema) zemin; logo "koyu zemin" varyasyonu (kırık beyaz karo, füme rün), kıvılcım noktası `--spark` (dekoratif). Sağ alan: `--bg-canvas` (açık) zemin, form `--bg-surface` kart (`--radius-card`).
- Girdiler: `--bg-surface` zemin, **`--border-strong`** sınır (`--radius-input`), odakta 2 px `--accent` halka. Etiketler `--text-primary` 14, yardımcı metin `--text-secondary` 12.
- "Giriş yap" ana buton: açık temada `--primary`/`--on-primary`; **koyu temada `--accent-btn`/`--on-accent`** (kural a), `--radius-btn`. "SSO ile devam" ikincil: `--bg-surface`, `--border-strong`, `--text-primary`.
- Hata: `--danger-soft` zemin + `--danger` uyarı ikonu + metin (kural c); kırmızı `--accent` kullanılmaz.
- Başlık "Hoş geldiniz" Space Grotesk 24. OTP hücreleri `--border-strong`, `tabular-nums`.

**Görünürlük kuralları**
- Herkese açık ekran; oturum yoksa tüm rotalar buraya yönlenir. SSO düğmesi yalnızca tenant SSO yapılandırmışsa görünür (tenant e-posta alan adından çözülür; bilinmiyorsa düğme gizli, parola akışı devam eder).
- 2FA adımı yalnızca hesapta TOTP etkinse ya da tenant politikası zorunluysa görünür. Zorunluysa ve kayıtlı değilse kurulum alt akışı (QR + kod) açılır.
- Tenant seçimi yalnızca birden çok aktif üyelik varsa görünür; her satırda yalnızca kullanıcının rol rozeti ve etkin satış segmentleri (ikon + etiket) yer alır. Askıya alınmış tenant listelenmez.
- Hata mesajları kullanıcı sayımı sızdırmaz: "E-posta veya parola hatalı" tek mesajdır.

**Klavye ve odak sırası**
- Sıra: E-posta → Parola → Göster → Beni hatırla → Parolamı unuttum → Giriş yap → SSO → Dil/Tema. `Enter` formu gönderir.
- 2FA: ilk hücreye otomatik odak; rakam yazınca ilerler, `Backspace` geri, 6 hane tamamlanınca otomatik gönderim; yapıştırma 6 hücreye dağılır.
- Tenant listesi `radiogroup`; ok tuşlarıyla seçilir, `Enter` devam eder.

**Durumlar**
- Yükleniyor: buton içinde spinner + "Giriş yapılıyor…", alanlar devre dışı. Boş: yok. Hata: yanlış parola, kilitlenmiş hesap ("Çok fazla deneme, 15 dk sonra tekrar deneyin"), 2FA kodu hatalı/süresi dolmuş. Çevrimdışı: form üstünde `--warning-soft` şerit, buton devre dışı.

**Hareket / a11y**
- Adımlar arası 160 ms yatay kayma; reduced-motion'da anında geçiş. Hatalar `role="alert"`, alan ile `aria-describedby` bağlı. OTP alanı `autocomplete="one-time-code"`, tek `group` + `aria-label="6 haneli doğrulama kodu"`.
- Parola göster düğmesi `aria-pressed`. Marka alanı dekoratif (`aria-hidden`), `<h1>` sağ paneldedir.

**Yoğunluk / responsive**
- Giriş ekranı yoğunluk tercihi almaz (Rahat). <1024'te sol marka alanı üst şeride (logo) küçülür, form tam genişlik; mobilde dokunma hedefi ≥ 44 px.

---

## 2. Onboarding sihirbazı

```text
+---------------------------------------------------------------------------+
| [ᚱ•] flexa        Kurulum   (1)Şablon --(2)Satış modu --(3)Modüller --(4)Telefoni |
+---------------------------------------------------------------------------+
|  Adım 1/4  Sektör şablonu                         Atlas Teknoloji         |
|                                                                           |
|  +-----------+ +-----------+ +-----------+ +-----------+                  |
|  | [ikon]    | | [ikon]    | | [ikon]    | | [ikon]    |                  |
|  | Yazılım & | | Perakende | | Hizmet &  | | Boş       |                  |
|  | BT        | | & e-tic.  | | Danışman. | | başla     |                  |
|  | B2B pipel.| | Sipariş   | | Proje+Gör.| |           |                  |
|  | [Seçili ✓]| |           | |           | |           |                  |
|  +-----------+ +-----------+ +-----------+ +-----------+                  |
|                                              [Geri]  [ İleri ]            |
+---------------------------------------------------------------------------+
|  Adım 2/4  Satış modu                                                     |
|  ( ) [bina] B2B       Firma, fırsat, teklif                               |
|  ( ) [kişi] B2C       Bireysel müşteri, sipariş                           |
|  (•) [bina+kişi] Her ikisi   Segment değiştirici görünür                  |
|  Not: Modu daha sonra Tenant alanı ve yönetim konsolundan değiştirebilirsiniz. |
+---------------------------------------------------------------------------+
|  Adım 3/4  Modül seçimi                                                   |
|  +--------------------+ +--------------------+ +--------------------+     |
|  |[ikon] Görev ve iş  | |[ikon] CRM ve müş.  | |[ikon] B2B satış    |     |
|  |  takibi  (zorunlu) | |  teri 360 (zorunlu)| |  [ Açık  (●)]      |     |
|  +--------------------+ +--------------------+ +--------------------+     |
|  |[ikon] B2C satış    | |[ikon] Çağrı merkezi| |[ikon] AI özet ve   |     |
|  |  [ Açık  (●)]      | |  ve santral [Kapalı]| |  rapor asistanı[ ○]|     |
|  +--------------------+ +--------------------+ +--------------------+     |
|  (i) Çağrı merkezi ve santral: Satış takibi ve hedefler modülünü gerektirir. |
+---------------------------------------------------------------------------+
|  Adım 4/4 (opsiyonel)  Telefoni bağlantı sihirbazı                        |
|  1 Sağlayıcı [Asterisk v]  2 Bağlantı bilgileri  3 DID eşleme  4 Test çağrısı |
|  [ Şimdilik atla ]                          [ Bağlantıyı test et ]        |
+---------------------------------------------------------------------------+
```

**Token kullanımı**
- Zemin `--bg-canvas`; seçim kartları `--bg-surface` + `--border-strong` (seçilebilir bileşen sınırı), seçiliyken 2 px `--accent` sınır + `--accent-soft` zemin + onay ikonu (renk tek başına değil).
- Adım göstergesi: tamamlanan `--success` ikon + metin, geçerli `--text-primary` + `--accent` alt çizgi, gelecek `--text-secondary`.
- B2B/B2C seçeneklerinde `--b2b-soft` / `--b2c-soft` zeminli rozetler, ikon + etiket (kural d). "Her ikisi" iki rozeti birlikte gösterir.
- Anahtarlar: kapalı `--bg-subtle` + `--border-strong`, açık `--primary` (koyu temada `--accent-btn`). Bağımlılık uyarısı `--info-soft` + `--info` ikon + metin; kilitli (zorunlu) kartlar `--text-secondary` + kilit ikonu.
- "İleri" ana buton (kural a). Başlıklar Space Grotesk 24/20; kart başlığı 16 500.

**Görünürlük kuralları**
- Yalnızca yeni tenant'ın **Admin**'ine (veya ilk kullanıcıya) gösterilir; sonrasında yalnızca Tenant alanı ve yönetim konsolunda "Kurulumu yeniden çalıştır" ile.
- Modül kartları yalnızca **tenant planında bulunan** modülleri listeler; plan dışı modül kartı "Planınıza dahil değil" etiketiyle pasif görünür, açılamaz (planlar Platform Operatörü konsolunda tanımlıdır).
- Satış modu seçimine göre kartlar sadeleşir: `B2B` seçilirse "B2C satış" kartı **gösterilmez**; `Her ikisi` seçilirse ikisi de görünür. Zorunlu modüller (Görev ve iş takibi, CRM ve müşteri 360, Kayıt ve audit) kilitli ve açıktır.
- Adım 4 yalnızca "Çağrı merkezi ve santral" açıksa görünür.

**Klavye ve odak sırası**
- Adım başlığına (`h2`) odak gelir; kartlar `radiogroup`/`checkbox` grubu, ok tuşu gezinir, `Space` seçer. Sıra: kartlar → Geri → İleri. `Alt+←/→` yerine yalnızca düğmeler (tarayıcı geri çakışması). `Esc` yok (sihirbaz modal değil).

**Durumlar**
- Yükleniyor: şablon önizleme yüklenirken kart iskeleti. Hata: bağımlılık ihlali `--danger` ikon + metin ("Çağrı merkezi ve santral için Satış takibi ve hedefler gerekir"), "Birlikte aç" aksiyonu. Telefoni testi başarısız: adım adım teşhis listesi (SIP kaydı, DID, ses yolu) her biri ikon + metinle. İlerleme her adımda otomatik kaydedilir; tarayıcı kapanırsa kaldığı adımdan devam eder. Çevrimdışı: "İleri" devre dışı + şerit.

**Hareket / a11y**
- Adımlar arası kayma; reduced-motion'da kapalı. `nav aria-label="Kurulum adımları"` + `aria-current="step"`. Anahtarlar `role="switch"`, durum "Açık/Kapalı" metniyle. Bağımlılık uyarısı `aria-live="polite"`.

**Yoğunluk / responsive**
- Rahat yoğunluk sabit. Mobilde kartlar tek sütun, adım göstergesi "Adım 2/4" metnine daralır.

---

## 3. Uygulama kabuğu (`both` ve `b2b_only` farkı)

```text
== Mod: both (Ayşe Yılmaz / Admin, Atlas Teknoloji) ==============================
+------------------------------------------------------------------------------+
|[ᚱ•]|[Atlas Teknoloji v]  [ B2B | B2C | Tümü ]  [🔍 Ara… Ctrl+K] [☎ Hazır v] [🔔•] [Admin] [AY v]|
+----+-------------------------------------------------------------------------+
|[«] | Sayfa başlığı                                          [Yeni +]         |
|Bugün|                                                                          |
|Görev ve iş takibi                                                              |
|CRM ve müşteri 360                                                              |
|B2B satış        [bina]                                                         |
|B2C satış        [kişi]                                                         |
|Satış takibi ve hedefler                                                        |
|Çağrı merkezi ve santral                       (çalışma alanı)                  |
|Yönetici paneli                                                                 |
|AI özet ve rapor asistanı                                                       |
|Otomasyon ve SLA                                                                |
|Data servisi ve entegrasyonlar                                                  |
|Kayıt ve audit                                                                  |
|Tenant alanı ve yönetim konsolu                                                 |
|----                                                                            |
| [Daralt] [?]                                                                   |
+----+-------------------------------------------------------------------------+

== Mod: b2b_only (Can Öz / Satış Temsilcisi) =====================================
+------------------------------------------------------------------------------+
|[ᚱ•]|[Atlas Teknoloji v]   (segment değiştirici YOK)  [🔍 Ara… Ctrl+K] [☎ Hazır v] [🔔] [Satış Temsilcisi] [CÖ v]|
+----+-------------------------------------------------------------------------+
|Bugün                                                                           |
|Görev ve iş takibi                                                              |
|CRM ve müşteri 360                                                              |
|B2B satış                                                                       |
|Satış takibi ve hedefler                                                        |
|Çağrı merkezi ve santral   (yalnızca telefon yetkisi varsa)                     |
|AI özet ve rapor asistanı  (yalnızca modül açık + yetkiliyse)                   |
|  (B2C satış, Yönetici paneli, Kayıt ve audit, Tenant alanı… menüde YOK)        |
+------------------------------------------------------------------------------+

== Kullanıcı menüsü / Tenant değiştirici açık ==
  +--------------------------+      +-------------------------------+
  | Can Öz                   |      | Çalışma alanları              |
  | [Satış Temsilcisi]       |      | (•) Atlas Teknoloji           |
  | Profil ve tercihler      |      | ( ) Nehir Perakende           |
  | Yoğunluk: Rahat|Kompakt  |      | Çalışma alanı ekle…           |
  | Tema: Açık|Koyu|Sistem   |      +-------------------------------+
  | Kısayollar  ?            |
  | Çıkış yap                |
  +--------------------------+
```

**Token kullanımı**
- Üst çubuk `--bg-surface` + alt `--border` ayraç; yan menü `--bg-canvas` + sağ `--border`. Aktif menü öğesi: `--accent-soft` zemin + `--accent` metin/sol çubuk + `aria-current`; kalan öğeler `--text-primary` 14, ikon 2 px çizgi tarzı.
- Segment değiştirici: segmentli kontrol, sınır `--border-strong`; seçili parça `--primary` zemin (koyu: `--accent-btn`) + `--on-primary`/`--on-accent`. Her parçada ikon + etiket: B2B (`--b2b` ikon, `--b2b-soft` zemin), B2C (`--b2c` ikon, `--b2c-soft`), Tümü.
- Rol rozeti (10.5.3): Admin füme dolgu (`--primary`/`--on-primary`), Yönetici füme kontur, Satış Temsilcisi `--b2b-soft`, Çağrı Temsilcisi `--b2c-soft`, Analist `--bg-subtle`; hepsi ikon + etiket.
- Bildirim zili: yeni bildirimde `--spark` nokta (dekoratif) **ve** sayı rozeti `--accent-soft` zemin + `--accent` metin; yalnızca nokta ile anlatılmaz (kural e). Durum seçici hap: Hazır `--success`, Görüşmede `--accent`, Wrap-up `--warning`, Mola `--info`, Çevrimdışı `--text-secondary`, hepsi ikon + metin.
- Menü, popover ve tenant değiştirici yüzen katman: cam efekti (`--bg-raised` yarı saydam), `--shadow-card`/koyu temada `--border`. Logo "tenant logosu" en fazla küçük ikincil alanda; Flexa işareti sabit. Metin 14, bölüm başlığı Space Grotesk.

**Görünürlük kuralları**
- Yan menü yalnızca **tenant'ta etkin ve kullanıcının yetkili olduğu** modülleri gösterir; pasif/yetkisiz öğe gri bile değildir, yoktur.
- **Segment değiştirici:** yalnızca `both` modunda görünür **ve** kullanıcının iki segmente yetkisi varsa. Tek segmentli kullanıcıda (Can Öz, Zeynep Arslan) `both` tenant'ta bile gizlidir; kullanıcı yalnızca kendi segmentini görür. `b2b_only`/`b2c_only` tenant'ta herkese gizlidir.
- `b2b_only`: "B2C satış" menüsü, B2C rozetleri, B2C filtre çipleri, palette sonuçları ve raporlardaki B2C metrikleri yoktur. `both`: iki segment, yetkiye göre.
- Softphone durum seçicisi yalnızca "Çağrı merkezi ve santral" açık ve kullanıcının telefon yetkisi varsa görünür (Zeynep Arslan: telefon yok, görmez). Bildirim zili ("Mention ve anlık bildirim") her kullanıcıda vardır.
- Tenant değiştirici yalnızca birden çok üyelikte görünür. "Tenant alanı ve yönetim konsolu" yalnızca Admin.

**Klavye ve odak sırası**
- Kısayollar: `Cmd/Ctrl+K`, `/`, `C`, `?`, `G B`; `[` yan menüyü daralt/aç. "İçeriğe atla" bağlantısı odak sırasında ilk öğedir.
- Sıra: İçeriğe atla → Yan menü → Üst çubuk (tenant → segment → arama → durum → zil → kullanıcı) → İçerik. Segment kontrolü `radiogroup`, ok tuşlarıyla gezinir. Menüler `Esc` ile kapanır.

**Durumlar**
- Yükleniyor: menü ve üst çubuk iskeleti (modül kaydı gelene kadar menü öğeleri yer tutucu çubuk; yetkisiz öğe asla geçici görünmez). Hata: modül kaydı alınamazsa üstte `--danger` bant "Menü yüklenemedi, yeniden dene". Çevrimdışı: kalıcı şerit, zil durumu "son bilinen". Segment değiştirilirken içerik iskeleti.

**Hareket / a11y**
- Menü daralma 160 ms genişlik animasyonu; zil kıvılcımı tek seferlik nabız (reduced-motion'da statik nokta). Yan menü `nav aria-label="Ana gezinme"`, daraltılmış raylı modda ikonlar `aria-label` + tooltip. Zil `aria-label="Bildirimler, 3 okunmamış"`. `aria-live` bölgesi okunmamış sayı değişimini duyurur.

**Yoğunluk / responsive**
- Menü öğesi satırı Rahat 40 / Kompakt 32 px. Tablette yan menü ikon rayı; mobilde menü hamburger çekmecesi + alt gezinme (Bugün, Görevler, Bildirimler, Ara, Menü); segment değiştirici üst çubukta ikon+etiketli kısa form. Çağrı merkezi kullanıcılarında Kompakt ve koyu tema önerilir.

---

## 4. Command palette (Cmd/Ctrl+K)

```text
+--------------------------------------------------------------+
| [🔍] Ara veya komut yaz…                       [Tümü v] Esc  |
+--------------------------------------------------------------+
| Asistana sor                                                  |
|  ✦ "Bu çeyrekte Can Öz'ün açık fırsatları neler?"  ↵ Asistana sor |
+--------------------------------------------------------------+
| Hızlı eylemler                                                |
|  + Yeni görev                         C                       |
|  + Yeni fırsat              [bina B2B]                        |
|  + Yeni sipariş             [kişi B2C]                        |
|  ☎ Müşteriyi ara…                                             |
| Son görüntülenenler                                           |
|  Orion Lojistik teklifi v3        [bina B2B]  Teklif          |
|  Ayşe Kara · Müşteri 360          [kişi B2C]  Müşteri         |
| Sonuçlar (yazdıkça)                                           |
|  Orion Lojistik                   [bina B2B]  Firma           |
+--------------------------------------------------------------+
| ↑↓ gezin   ↵ aç   Ctrl+↵ yeni sekmede   Tab kapsam   ? yardım |
+--------------------------------------------------------------+

--- "Asistana sor" yanıt görünümü ---
| ✦ Yanıt (AI tarafından üretildi)                              |
|  Can Öz: 7 açık fırsat, ağırlıklı değer 1.240.000 TL [1][2]    |
|  | Fırsat           | Aşama    | Tutar   |                   |
|  [Kaynaklar: 1 Orion… 2 Delta…]       [İptal]  [Rapor oluştur] |
```

**Token kullanımı**
- Yüzen cam katman: `--bg-raised` (yarı saydam + bulanıklık), açık temada `--shadow-card`, koyu temada ince `--border`; radius `--radius-card`/üst `--radius-hero` değil 16. Arama girdisi 16 pt, alt çizgi `--border-strong`.
- Seçili satır: `--accent-soft` zemin + sol `--accent` çubuk; kısayol ipuçları `--text-secondary` 12, `tabular-nums` değil klavye tuşu görünümü (`--bg-subtle` + `--border-strong`).
- Her sonuçta segment rozeti ikon + etiket (kural d). "Asistana sor" bölümünde kıvılcım ikonu `--spark` dekoratif + "AI" metin etiketi; yanıt kartının üstünde ince `--accent` çizgi (10.5.3).
- Hata `--danger-soft` + ikon + metin.

**Görünürlük kuralları**
- Sonuçlar yalnızca kullanıcının **segment, kapsam ve alan yetkisi** içindekileri döndürür; **sayımlar ve öneriler de** yetki filtrelidir (Zeynep Arslan "Orion" yazdığında B2B firması çıkmaz, sayım yok). Yetkisiz modülün eylemleri ("Yeni fırsat", "Müşteriyi ara") listede yoktur.
- "Asistana sor" yalnızca "AI özet ve rapor asistanı" etkin ve kullanıcının AI yetkisi varsa görünür; yoksa bölüm hiç render edilmez. Yanıtlar yalnızca kullanıcının zaten erişebildiği kayıtlara dayanır; yetkisiz kaynak çipi gösterilmez.
- Segment kapsamı sekmesi (`Tab`): Tümü / B2B / B2C yalnızca `both` modunda ve çift yetkili kullanıcıda.

**Klavye ve odak sırası**
- `Cmd/Ctrl+K` açar, odak arama girdisinde. `↑/↓` gezinir, `Enter` açar, `Ctrl/Cmd+Enter` yeni sekme, `Tab` kapsam değiştirir, `Esc` kapatır ve odağı tetikleyiciye döndürür. Yazım `>` ile yalnızca eylemler, `@` ile kişiler, `#` ile kayıt kodu, `?` ile Asistana sor önekleri. Focus trap aktif.

**Durumlar**
- Yükleniyor: sonuç iskeleti (3 satır) 150 ms sonra. Boş sonuç: "Sonuç yok. Yeni kayıt oluşturmak ister misiniz?" + tek aksiyon. Hata: "Arama şu an yapılamıyor" + yeniden dene. Çevrimdışı: yalnızca son görüntülenenler ve yerel eylemler. AI: modül kapalıysa satır yok; kota dolu → "Kota doldu" satırı pasif (ikon + metin); model yok → "Asistan şu an kullanılamıyor, aramayı kullanın".

**Hareket / a11y**
- Açılışta 120 ms ölçekle belirme; reduced-motion'da anında. `role="dialog" aria-modal`, girdi `role="combobox" aria-expanded aria-controls`, liste `role="listbox"`, seçili öğe `aria-activedescendant`. Sonuç sayısı `aria-live="polite"` ("5 sonuç"). Asistan yanıtı akarken `aria-live="polite"` + `aria-busy`.

**Yoğunluk / responsive**
- Kompakt'ta satır 32 px. Mobilde tam ekran sayfa olarak açılır (üstte arama), alt klavye ipuçları gizlenir.

---

## 5. Satış temsilcisi "Bugün" bento ana sayfası

```text
+------------------------------------------------------------------------------+
| Günaydın, Can                       Cuma, 20 Kasım        [Kompakt|Rahat]    |
+-------------------------------------------+----------------------------------+
| ✦ AI Günün Özeti  [AI tarafından üretildi]| Hedef halkası                    |
|---------------------------------(accent)--|        ,-"""-.                   |
| [3 görev gecikmiş][2 teklif bekliyor]     |       / 68%   \   Kasım hedefi   |
| [7 açık fırsat][1,24 M TL ağırlıklı]      |       \       /   850K / 1,25M TL|
| Bugün Orion Lojistik teklifinin süresi    |        `-...-'    Kalan 8 iş günü|
| doluyor; Delta Gıda ile görüşme 14:00. [1][2]|-------------------------------|
| Kaynaklar (4)    [Rapor oluştur]  👍 👎   | Açık siparişler (B2C yetkisi yoksa yok)|
+-------------------------------------------+ SO-20418 Hazırlanıyor            |
| Bugünün görevleri (5)         [C Yeni]    | SO-20421 Ödeme bekliyor          |
| [ ] Orion teklifini revize et   Bugün 11:00| Tümünü gör                      |
| [ ] Delta Gıda'yı ara  [☎]      Bugün 14:00+---------------------------------+
| [x] Sözleşme taslağı gönder     Tamamlandı | Hızlı eylem                      |
| Tümünü gör                                | [Yeni fırsat][Yeni görev][Ara]    |
+-------------------------------------------+----------------------------------+
| Sıcak fırsatlar (B2B)                                                         |
| Orion Lojistik   [bina B2B]  Teklif   420.000 TL   %70  Kapanış 28 Kas  ▲     |
| Delta Gıda       [bina B2B]  Müzakere 310.000 TL   %50  Kapanış 04 Ara  ▬     |
+------------------------------------------------------------------------------+
```

**Token kullanımı**
- Zemin `--bg-canvas`; bento kartları `--bg-surface` + `--border` (dekoratif) + `--shadow-card`; radius `--radius-card` 16, AI kartı ve hero hedef kartı `--radius-hero` 20. Hiyerarşiyi kart boyutu anlatır.
- AI kartı: üstte ince `--accent` çizgi, kıvılcım `--spark` (dekoratif) + "AI tarafından üretildi" metin etiketi (`--text-secondary` 12) + AI ikonu; metrik çipleri `--bg-subtle` + `--border-strong` + `tabular-nums`. Çip içinde sayılar 14 500.
- Hedef halkası: dolu yay `--accent` (görsel), merkez yüzde Space Grotesk 32 `--text-primary`, rakamsal metin her zaman yanında (renge dayanmaz). Halka izi `--bg-subtle`. KPI 44 yalnızca hero hedef rakamında.
- Fırsat satırı: segment rozeti `--b2b-soft` + bina ikonu + "B2B". Gecikmiş görev: `--danger` ikon + "Gecikti" metin (kural c). Trend okları ▲ `--success` / ▼ `--danger` ikon + metin eşliğinde.
- Başlık Space Grotesk 24/20, gövde Inter 14, tüm sayılar `tabular-nums`.

**Görünürlük kuralları**
- Rol bilincine göre kartlar: **Satış Temsilcisi** tüm kartları (yetkisine göre) görür. Çağrı Temsilcisi bu ekran yerine Çağrı merkezi cockpit'ini (14) varsayılan açar. Yönetici/Admin Yönetici paneli (16) varsayılanıdır; Bugün ekranına da erişir, kapsamı "kendi kayıtları"dır.
- "Sıcak fırsatlar" yalnızca B2B yetkisi + B2B satış etkinse; "Açık siparişler" yalnızca B2C yetkisi + B2C satış etkinse. Can Öz (yalnız B2B): sipariş kartı render edilmez, yerine "Yaklaşan toplantılar" gelir. Zeynep Arslan (yalnız B2C): sıcak fırsat kartı yok, yerine "Geri aramalar". Deniz Çelik (B2B+B2C): ikisi de, segment değiştirici (B2B/B2C/Tümü) kartları süzer.
- AI Günün Özeti yalnızca "AI özet ve rapor asistanı" etkin ve kullanıcının özet yetkisi varsa; aksi halde kart yoktur ve yerine deterministik "Bugünün sayıları" kartı gelir. Hedef halkası yalnızca "Satış takibi ve hedefler" açık ve kişiye hedef atanmışsa; yoksa "Hedef atanmadı" boş durumu (Satış Temsilcisi için salt bilgi, Yönetici için "Hedef ata" bağlantısı).
- Alan düzeyinde gizli alanlar (ör. fiyat gizli rolde tutar) kartlarda hiç render edilmez, sütun kaybolur.

**Klavye ve odak sırası**
- `C` yeni görev, `J/K` görev listesinde gezinme, `Space` görevi tamamla, `Enter` aç, `/` arama, `G B` bu ekrana dön. Odak sırası: AI kartı (Kaynaklar, Rapor oluştur, geri bildirim) → Hedef kartı → Görevler → Siparişler → Hızlı eylemler → Sıcak fırsatlar. Kartlar `region` landmark; `h2` başlıkları.

**Durumlar**
- Yükleniyor: her kart kendi iskeleti (AI kartı satır iskeleti + "Özet hazırlanıyor"), kartlar bağımsız yüklenir. Boş: görev yoksa "Bugün için görev yok. Planlı bir şey ekleyin" + `C Yeni görev`. Hata: kart içi hata bandı (`--danger-soft` + ikon + metin + yeniden dene), diğer kartlar etkilenmez. Çevrimdışı: son önbellek + "Son güncelleme 09:41" etiketi.
- AI kartı durumları ekran 21'de.

**Hareket / a11y**
- Halka 600 ms dolum; reduced-motion'da animasyonsuz son değer. Görev tamamlama 160 ms çizgi geçişi + `aria-live="polite"` "Görev tamamlandı. Geri al". Halka `role="img"` + `aria-label="Kasım hedefi yüzde 68, 850 bin / 1,25 milyon TL"`.

**Yoğunluk / responsive**
- Rahat varsayılan; Kompakt satır 32 px ve AI kartı daraltılabilir (başlık + çipler). **Mobil (<640):** tek sütun sırası: AI Günün Özeti → Hedef halkası → Görevler → Sıcak fırsatlar/Açık siparişler → Hızlı eylem; alt gezinme çubuğu; görev kartları kaydırarak tamamla/ertele (alternatif düğmeler de var); kart hedefleri ≥ 44 px. Tablet: iki sütun bento.

---

## 6. Görev listesi, Kanban, Takvim ve Gantt

```text
Ortak araç çubuğu:
[Liste|Kanban|Takvim|Gantt|Tablo]  [🔍 Filtre: assignee:me status:open ▾]  [Kayıtlı görünümler v] [C Yeni görev]

--- Çerçeve A: Liste ---
| [ ] Başlık                         Durum        Atanan     Bitiş    Öncelik |
| [ ] Orion teklifini revize et      Devam ediyor Can Öz     Bugün    Yüksek  |
| [x] Delta Gıda'yı ara  [☎]         Açık         Can Öz     Bugün    Orta    |
| [ ] Sözleşme taslağı               Gecikti (!)  Deniz Çelik 18 Kas  Yüksek  |
| 2 seçili:  [Ata] [Durum] [Tarih] [Sil]                   (sanal kaydırma)   |

--- Çerçeve B: Kanban ---
| Açık (3)         | Devam ediyor (2/WIP 3) | İncelemede (1)   | Bitti (8)     |
| [Orion teklifi ] | [Sözleşme taslağı]     | [Fiyat listesi]  | [..]          |
| [Delta arama   ] | [Müşteri sunumu  ]     |                  |               |
| Swimlane: Atanan ▾                                  ⇢ sürükle & bırak         |

--- Çerçeve C: Takvim (Hafta) ---
|        Pzt 16 | Sal 17 | Çar 18 | Per 19 | Cum 20 | Cmt 21 |
| 09     |       |        | [Delta gör.]   |        |        |
| 11     |       |        |        | [Orion revize]|        |
| (görevi sürükleyerek tarih değiştir)   Ay | Hafta | Gün                  |

--- Çerçeve D: Gantt ---
| Görev            | Kas 16 17 18 19 20 21 22 23 24 25 |
| Teklif hazırlığı |       [=======]                    |
| Müzakere         |             [==========]──┐        |
| Sözleşme         |                           └[====]  | ◆ kritik yol
```

**Token kullanımı**
- Zemin `--bg-canvas`; tablo/kanban sütunları `--bg-surface` + `--border`; sütun başlığı `--bg-subtle`. Kartlar `--radius-card` 16 (Kanban kartı 12 yeterli değil; kart 16). Seçili satır `--accent-soft` + `--accent` sol çubuk. Onay kutuları `--border-strong`.
- Durum rozetleri: Açık `--info-soft`/`--info` + ikon, Devam `--b2b-soft`... yerine nötr `--bg-subtle`, Gecikti `--danger-soft` + `--danger` + ünlem ikonu + "Gecikti" (kural c); Bitti `--success-soft`/`--success` + onay ikonu.
- WIP sınırı aşıldığında sütun başlığı `--warning-soft` + `--warning` ikon + "WIP 4/3" metni. Sürükleme gölgesi `--shadow-card`; bırakma hedefi 2 px kesikli `--border-strong` + `--accent-soft`.
- Gantt: çubuk `--primary` (koyu: `--b2b`), kritik yol çubuğu `--accent` + desen/etiket (renk tek başına değil), bağımlılık oku `--text-secondary`. Bugün çizgisi `--accent`.
- Tarihler ve sayılar `tabular-nums`. Segment rozeti bağlı kayıtta ikon + etiket.

**Görünürlük kuralları**
- "Görev ve iş takibi" tüm rollerde var (Analist salt okunur: sürükleme, düzenleme, "Yeni görev" yok; 403 sonucu görünür fakat yetkisiz eylemler devre dışı bırakılmaz, **hiç sunulmaz**). Görevler kapsama göre süzülür: Satış Temsilcisi yalnızca kendi, Yönetici ekibi, Admin/Analist tümü.
- Görevin bağlı olduğu kayıt yetkisiz segmentteyse (ör. Can için B2C siparişe bağlı görev) görev satırı listelenmez; sayım da buna göre. Yetkisiz alan (ör. tutar) sütunu render edilmez.
- "Otomasyon ve SLA" etkinse SLA sütunu/ikonu görünür; kapalıysa yoktur. Telefon ikonu (☎) yalnızca telefon yetkisi + "Çağrı merkezi ve santral" etkinse; rıza yoksa engellenir ve nedeni gösterilir.
- Segment filtresi `both` + çift yetkide.

**Klavye ve odak sırası**
- `C` yeni görev, `J/K` sonraki/önceki, `X` seç, `E` satır içi düzenle, `Shift+J/K` aralık seçimi, `Z` geri al, `1-5` görünüm değiştir (Liste, Kanban, Takvim, Gantt, Tablo). Kanban: `Space` kartı tut, ok tuşlarıyla taşı, `Space` bırak (dnd-kit klavye sensörü); taşıma `aria-live="polite"` ile duyurulur ("Orion teklifi, Devam ediyor sütununa taşındı, 2/3"). Takvim: ok tuşlarıyla gün, `Enter` olay aç. Gantt: odaktaki çubukta `Alt+←/→` süre ayarı değil; `Shift+←/→` süreyi, `←/→` tarihi kaydırır (Alt çağrı kısayollarına ayrılmıştır).
- Odak sırası: görünüm sekmeleri → filtre çubuğu → içerik → toplu aksiyon çubuğu.

**Durumlar**
- Yükleniyor: satır/kart/hücre iskeleti. Boş: "Henüz görev yok. İlk görevi oluşturun" + `C Yeni görev` + çizgi illüstrasyon. Hata: optimistic güncelleme başarısızsa geri sarma + toast "Taşınamadı, geri alındı" (ikon + metin, `Yeniden dene`). Çakışma: başkası değiştirdiyse satırda `--info` "Mert Kaya güncelledi" etiketi ve değişiklik bandı. Çevrimdışı: şerit + düzenleme kuyruğu ("2 değişiklik bekliyor").

**Hareket / a11y**
- Kart sürükleme 100 ms içinde optimistic; yerleşme animasyonu 160 ms. Reduced-motion'da sürükleme sonrası sıçrama yok. Liste `role="grid"`/`treegrid`, satır `aria-selected`, Kanban sütunları `role="list"` + `aria-label="Devam ediyor, 2 görev, WIP 3"`, Takvim `role="grid"`. Gantt için tablo alternatifi ("Tablo olarak göster") sunulur; çubuklar yalnızca renkle değil etiketle ayırt edilir.

**Yoğunluk / responsive**
- Rahat 48 / Kompakt 32 px satır. Mobilde Liste ve Takvim (gün) desteklenir; Kanban yatay kaydırma (`scroll-snap`); Gantt yalnızca masaüstü/tablette, mobilde "Bu görünüm geniş ekran gerektirir, Liste'ye geç" bildirimi.

---

## 7. Kayıt detay sayfası

```text
+------------------------------------------------------------------------------+
| ‹ Fırsatlar   Orion Lojistik Yenileme   [bina B2B]  [Teklif aşaması v]  [⋯]   |
+-----------------------+--------------------------------+---------------------+
| ALANLAR               | ZAMAN ÇİZELGESİ                | İLİŞKİLİ KAYITLAR   |
| Tutar                 | [Not yaz… @ ile an   ] [Ekle]  | Firma               |
|  420.000 TL  ✎        | --- Bugün ---                  |  Orion Lojistik     |
| Olasılık  %70 ✎       | Mert Kaya anıldı: "@Can Öz     | Kişiler (2)         |
| Kapanış  28 Kas ✎     |  fiyat onayı bekliyor"   [↗]   |  Selin Er · Alıcı   |
| Sahip  Can Öz ✎       | 11:02 Aşama: Müzakere→Teklif   | Teklifler (3)       |
| Kaynak  Referans      | 10:15 Çağrı · 6 dk  [özet]     |  v3 Taslak          |
| Özel alanlar          | 09:40 Görev oluşturuldu        | Görevler (2)        |
| Etiketler ✎           | --- Dün ---                    | Dosyalar (1)        |
| (gizli alanlar yok)   | [Tümü|Notlar|Çağrılar|Sistem]  | [+ İlişkili ekle]   |
+-----------------------+--------------------------------+---------------------+
```

**Token kullanımı**
- Üç sütun, kartlar `--bg-surface` + `--border`, zemin `--bg-canvas`. Sol alan etiketleri `--text-secondary` 12, değerler `--text-primary` 14, tutar Space Grotesk 20 `tabular-nums`.
- Satır içi düzenleme: alana tıklayınca girdi, sınır **`--border-strong`**, 2 px `--accent` odak halkası, `--radius-input` 8; kaydedilen alanda kısa `--success` onay ikonu + "Kaydedildi" metni. Hata: `--danger` ikon + metin.
- Başlıkta segment rozeti `--b2b-soft` + bina ikonu + "B2B". Aşama seçici ana olmayan buton (`--bg-surface`, `--border-strong`).
- Timeline düğümleri `--border-strong` hat; mention satırı `--accent-soft` zemin + `--accent` @-çipi; bildirim noktası `--spark` dekoratif. Çağrı kaydı satırlarında durum ikonu + metin.

**Görünürlük kuralları**
- Rota yalnızca kullanıcının segment + kapsam + alan yetkisi varsa açılır; aksi halde **404** (sayfanın varlığı sızdırılmaz). Can Öz'ün B2C siparişi URL'si → 404; Mert Kaya B2C ekibinin siparişini düzenleyemez (404).
- **Alan düzeyi:** gizli alan (ör. iskonto tutarı, maliyet) hiç render edilmez; satır, etiket ve boşluk yoktur. Salt okunur alan (Analist) düzenleme kalemi göstermez.
- Timeline girdileri tek tek yetki süzülür: yetkisiz bir kaydın olayı (ör. başka segmentten ilişkili çağrı) gösterilmez. Çağrı satırları ve kayıt dinleme yalnızca telefon yetkisi olana; "Kayıt ve audit" geçmişi sekmesi yalnızca ilgili yetkideyse.
- İlişkili kayıtlar paneli yalnızca erişilebilen kayıtları sayıyla birlikte gösterir (sayı da süzülür).
- **Mention:** notta `@` yazıldığında yalnızca bu kayda erişimi olan kişiler listelenir (ekran 8); anılan kişi daha sonra erişimini kaybederse bildirim içeriği açılmaz.

**Klavye ve odak sırası**
- `E` odaktaki alanı düzenle, `Enter` kaydet, `Esc` iptal, `J/K` timeline girdileri arasında, `C` bu kayda bağlı yeni görev, `N` not alanına odak, `[`/`]` önceki/sonraki kayıt (listeden gelindiyse). Odak sırası: başlık/aşama → sol alanlar (sırayla) → timeline not girişi → timeline → sağ ilişkili → `⋯` menüsü. Üç sütun `region` landmark.

**Durumlar**
- Yükleniyor: üç sütun iskelet. Boş: timeline boşsa "Henüz etkinlik yok. İlk notu ekleyin." Hata: kayıt kaydedilemedi → alan yeşil onay yerine `--danger` ikon + "Kaydedilemedi, yeniden dene" ve eski değer geri gelir. Çakışma: başka kullanıcı aynı alanı değiştirdiyse "Mert Kaya bu alanı güncelledi. [Benimkini koru] [Onu al]". Çevrimdışı: alanlar düzenlenir ama "Bekliyor" ikonu ve şerit.
- Gerçek zamanlı güncelleme: yeni timeline girdisi `aria-live="polite"`, üstte "1 yeni etkinlik" çipi.

**Hareket / a11y**
- Alan değişiminde 120 ms vurgu geçişi; reduced-motion'da yok. Satır içi düzenleme `aria-label="Tutar düzenle"`, kaydetme sonucu `role="status"`. Timeline `role="feed"`, her öğe `article`. Mention çipi bağlantı, `aria-label="Can Öz'e bahsedildi"`.

**Yoğunluk / responsive**
- Kompakt'ta alan satırı 28 px. Tablet: sağ panel alta iner. **Mobil:** sekmeli düzen (Alanlar | Zaman çizelgesi | İlişkili), başlık sabit, aşama seçici alt sayfa.

---

## 8. Not / açıklama editörü ve @mention seçici

```text
+----------------------------------------------------------------------+
| B  I  U  •  1.  </>  🔗  @  [Görev öner ✦]                           |
|----------------------------------------------------------------------|
| Fiyat için @Me                                                       |
|        +----------------------------------------+                    |
|        | Kişiler                                |                    |
|        |  [MK] Mert Kaya       Yönetici   B2B   |                    |
|        |  [ME] Mert Ersoy      Satış Tem. B2B   |                    |
|        | Ekipler                                |                    |
|        |  [@] B2B Kurumsal  (6 kişi)            |                    |
|        | Bu kayda erişimi olmayanlar listelenmez|                    |
|        +----------------------------------------+                    |
|----------------------------------------------------------------------|
| Fiyat için [@Mert Kaya] onayı bekliyoruz. [@B2B Kurumsal]  ↵ gönder  |
+----------------------------------------------------------------------+
| Bu notu görebilecek: Can Öz, Mert Kaya, B2B Kurumsal (6)    [Gönder] |
+----------------------------------------------------------------------+
```

**Token kullanımı**
- Editör `--bg-surface`, sınır **`--border-strong`** (girdi sınırı), `--radius-input`/kart 16; odakta 2 px `--accent` halka. Araç çubuğu `--bg-subtle`.
- Seçici açılır liste: yüzen cam, `--bg-raised`, seçili öğe `--accent-soft` + sol `--accent` çubuk; rol/segment rozeti ikon + etiket (`--b2b-soft` / `--b2c-soft`).
- Mention çipi: `--accent-soft` zemin + `--accent` metin (≥ 4.5:1 doğrulanmış) + `@` ikon; ekip çipi aynı stil + ekip ikonu. "Gönder" ana buton (kural a).
- "Görev öner" kıvılcım `--spark` dekoratif + metin; hata `--danger` ikon + metin (ör. 422 "Bu kişi kayda erişemiyor").

**Görünürlük kuralları**
- Seçici **yalnızca bu kayda erişimi olan** kullanıcı ve ekipleri listeler: Can Öz bir B2B fırsatında yazarken Zeynep Arslan **listelenmez** (B2C'ye sınırlı). API ile zorlanırsa 422; arayüz bu durumda çip oluşturmaz.
- "Bu notu görebilecek" şeridi erişim kümesini gösterir; kişi sayısı ve ad listesi yalnızca görüntüleme yetkisine sahip kişiler için yazılır. Gizli notlarda (yalnız yöneticiler) kilit ikonu + etiket.
- "Görev öner" yalnızca "AI özet ve rapor asistanı" etkin + yetkiliyse görünür. Ekip mention'ı yalnızca ekip üyesi olan veya ekip yöneticisi için aktif.
- Mention bildirimi alıcıya **< 2 sn** gider; alıcı sonra erişimi kaybederse içerik gösterilmez (okuma anı kontrolü).

**Klavye ve odak sırası**
- `@` seçiciyi açar; `↑/↓` gezin, `Enter`/`Tab` seç, `Esc` kapat (metin kalır), `Backspace` çipi bir adımda siler (önce seçer, sonra siler). `Ctrl/Cmd+Enter` gönder, `Ctrl/Cmd+B/I/U` biçim. Odak sırası: araç çubuğu → yazı alanı → erişim şeridi → Gönder. `N` kayıt sayfasında bu alana odak getirir.

**Durumlar**
- Yükleniyor: seçici 200 ms üzeri sürerse iskelet satırı. Boş: "Eşleşen kişi yok. Yalnızca bu kayda erişimi olanlar gösterilir." Hata: gönderme başarısız → metin korunur, `--danger` bant + "Yeniden dene". Taslak yerel olarak otomatik saklanır. Çevrimdışı: "Gönderilmeyi bekliyor" + kuyruk.

**Hareket / a11y**
- Seçici 120 ms kayma; reduced-motion'da yok. Seçici `role="listbox"`, editör `role="textbox" aria-multiline`, çip `contenteditable=false` + `aria-label`. Seçenek sayısı `aria-live="polite"` ("2 kişi bulundu"). Mention'lar ekran okuyucuya "bahsedildi: Mert Kaya" olarak okunur.

**Yoğunluk / responsive**
- Kompakt'ta araç çubuğu ikon-only. Mobilde araç çubuğu klavyenin üstünde sabit, seçici alt sayfa olarak açılır.

---

## 9. Bildirim merkezi

```text
+------------------------------------------------------+
| Bildirimler           [Tümü|Anıldım|Atamalar|Sistem] |
|                       [Okunmamış] [Tümünü okundu yap]|
+------------------------------------------------------+
| Mention'lar                                          |
| (•) Mert Kaya seni andı · Orion Lojistik fırsatı     |
|     "…fiyat onayı bekliyor"        2 dk önce   [↗]   |
| (•) Burak Aydın seni andı · Görev #482      14 dk    |
| Diğer                                                |
| (•) Delta Gıda teklifi onaylandı           09:40     |
|     Görev atandı: Sözleşme taslağı         dün       |
|  ( okunmuş: noktasız, --text-secondary )             |
+------------------------------------------------------+
| Bağlantı: canlı (●) · ayarlar                         |
```

**Token kullanımı**
- Panel yüzen cam (zilden açılan popover; tam sayfa görünümü `--bg-surface` kart). Mention bölümü üstte, başlık Space Grotesk 14 500 `--text-secondary`.
- Okunmamış: sol `--spark` nokta (dekoratif) **+** kalın başlık + "Okunmamış" görünmeyen etiket (`aria`) ve görünür 12 metin "Yeni" `--accent` (≥ 4.5:1) — yalnızca nokta ile anlatılmaz (kural e). Okunmuş satır `--text-secondary`.
- "Anıldım" aktif filtre çipi `--accent-soft` + `--accent` metin + onay ikonu; pasif çip `--border-strong` sınır. Satır ayırıcı `--border`. Odak halkası `--accent`.
- Hata/yetki kaybı: `--info-soft` + bilgi ikonu + "Bu içeriğe erişiminiz kalmadı" (kırmızı değil).

**Görünürlük kuralları**
- Her kullanıcı yalnızca **kendi** bildirimlerini görür. İçerik özeti **okuma anında** yetki kontrolünden geçer; erişim kaybolmuşsa satır "Bu içeriğe erişiminiz yok" olarak görünür, **başlık, kişi, firma ve alıntı gösterilmez** (kaydın varlığı da sızdırılmaz), derin bağlantı 404'e düşmez, bilgi satırına döner.
- Bildirim türleri modüle göre: "Atamalar" yalnızca Görev ve iş takibi; "Yaklaşan SLA" yalnızca "Otomasyon ve SLA" etkinse; "Geri arama" yalnızca telefon yetkisi varsa; "Onay" yalnızca onay verme yetkisinde. Çağrı temsilcisi görüşmedeyken **bildirim toast'ı gösterilmez**, zile birikir (kompakt mod politikası).
- "Anıldım" filtresi herkeste vardır.
- Derin bağlantı: mention'a tıklayınca kayıt sayfasında ilgili nota kaydırılır, not 2 sn `--accent-soft` ile vurgulanır; bildirim otomatik okundu olur.

**Klavye ve odak sırası**
- Zil `Shift+N` (veya `G N`) ile açılır; `J/K` gezin, `Enter` derin bağlantıyı aç, `U` okundu/okunmadı çevir, `Shift+U` tümünü okundu yap, `Esc` kapat. Odak sırası: filtre çipleri → "Tümünü okundu" → Mention'lar → diğerleri → ayarlar. Panel `Esc` ile kapanınca odak zile döner.

**Durumlar**
- Yükleniyor: satır iskeleti. Boş: "Her şey yolunda. Yeni bildirim yok." + çizgi illüstrasyon, tek `--accent` detay. Hata: "Bildirimler alınamadı" + yeniden dene. Çevrimdışı/SSE koptu: alt satır "Bağlantı: koptu (yeniden bağlanıyor)" ikon + metin; yeniden bağlanınca `Last-Event-ID` ile kaçanlar tamamlanır. Gerçek zamanlı yeni öğe üstte belirir, `aria-live="polite"`.

**Hareket / a11y**
- Yeni mention'da zilde tek seferlik kıvılcım nabzı (reduced-motion'da statik nokta + sayı). Liste `role="feed"`/`list`; okunmamış durum `aria-label="Okunmamış, Mert Kaya seni andı"`. Filtre çipleri `role="tablist"`.

**Yoğunluk / responsive**
- Kompakt satır 40 px (özet gizli, tek satır). **Mobil:** zil alt gezinmede; ekran tam sayfa; satırı sola kaydır "Okundu", sağa "Ertele" (düğme alternatifleri mevcut); push bildirimi derin bağlantı açar.

---

## 10. B2B pipeline Kanban ve teklif editörü

```text
=== Pipeline (B2B satış) ===================================================
| Filtre: sahip:Tümü ▾  Dönem: Kasım ▾         Toplam 3,9 M TL · Ağırlıklı 1,6 M TL |
| Aday (6)         | Nitelikli (4)    | Teklif (3)        | Müzakere (2)     | Kazanıldı |
| 640.000 TL       | 1.100.000 TL     | 980.000 TL        | 760.000 TL       | 410.000 |
| Ağır. 64.000     | Ağır. 330.000    | Ağır. 686.000     | Ağır. 532.000    | Ağır. 410K |
| [Orion Lojistik] | [Delta Gıda    ] | [Nova Enerji   ]  | [Atlas Ltd.    ] |
|  420.000 · %70   |  310.000 · %30   |  ..               |                  |
|  Can Öz  28 Kas  |                  |                   |                  |

=== Teklif editörü ===========================================================
| Teklif #T-2026-118 v3  Taslak  [bina B2B]   [Versiyonlar v][Onaya gönder]  |
+-------------------------------------------+--------------------------------+
| Müşteri: Orion Lojistik  Geçerlilik: 05 Ara| CANLI PDF ÖNİZLEME             |
| Kalemler                                  | +---------------------------+  |
| Ürün            Adet  Birim    İsk.  Toplam| | flexa · Teklif T-118    |  |
| Lisans (yıllık)  10   24.000   %5   228.000| | ...                       |  |
| Kurulum          1    60.000   —     60.000| |                           |  |
| [+ Kalem ekle]                            | +---------------------------+  |
| Ara toplam 288.000 · İskonto 12.000        | [Yakınlaştır] [PDF indir]      |
| KDV %20 · Genel toplam 331.200 TL         |                                |
+-------------------------------------------+--------------------------------+
| ⚠ İskonto %12 > yetki sınırı %10. Onay: Mert Kaya  [Onay iste]  Durum: Beklemede |
+------------------------------------------------------------------------------+
| Sürüm geçmişi: v3 Taslak (bugün) · v2 Gönderildi (18 Kas) · v1 (12 Kas) [Karşılaştır]|
```

**Token kullanımı**
- Kanban sütun başlığı `--bg-subtle`, kartlar `--bg-surface` + `--border`, `--radius-card` 16; sütun toplamı ve **ağırlıklı değer** Space Grotesk 20 `tabular-nums`, etiketli ("Toplam", "Ağırlıklı"). Hedef bırakma bölgesi kesikli `--border-strong` + `--accent-soft`.
- Segment rozeti `--b2b-soft` + bina ikonu + "B2B" kartta ve başlıkta (kural d). Kapanış yaklaşan: `--warning` ikon + metin. Kayıp: `--danger` ikon + "Kaybedildi".
- Teklif editöründe tablo girdileri `--border-strong`; toplam satırı `--bg-subtle`. **İskonto onay şeridi:** `--warning-soft` zemin + `--warning` ikon + metin (onay beklemede), onaylandı `--success-soft` + onay ikonu, reddedildi `--danger-soft` + `--danger` ikon + metin; hiçbiri `--accent` değildir.
- PDF önizleme çerçevesi `--bg-surface` + `--border` + `--shadow-card`; PDF içinde tenant logosu ve Flexa baskı varyasyonu. "Onaya gönder" ana buton (kural a), "PDF indir" ikincil.

**Görünürlük kuralları**
- Yalnızca "B2B satış" etkin ve kullanıcı B2B yetkisindeyse; `b2c_only` tenant'ta menü yok, API "modül kapalı". Kapsam: Satış Temsilcisi yalnızca kendi fırsatları; Yönetici ekibi (Mert Kaya B2B Kurumsal), Admin/Analist tümü (Analist salt okunur: taşıma ve düzenleme yok).
- **Alan düzeyi:** maliyet/marj gibi gizli alanlar rolde yoksa sütun hiç render edilmez; ağırlıklı değer yalnızca "olasılık" alanı görünürse hesaplanır, aksi halde sadece toplam gösterilir.
- İskonto onay şeridi yalnızca sınır aşıldıysa görünür; onay verme düğmesi yalnızca onaylayıcıda (Mert Kaya), talep eden kendi iskontosunu onaylayamaz. Sürüm karşılaştırma ve PDF indirme "export politikası"na tabidir (ekran 20 filigran bildirimi).
- Kazanıldı aşamasına taşıma, "B2C" siparişe dönüşümü gibi eylemler yetkiye bağlıdır; yetkisizse sürükleme engellenir ve ipucu verilir.

**Klavye ve odak sırası**
- Kanban: `J/K` kart, `Space` tut/bırak + ok tuşları taşı, `Enter` aç, `E` hızlı düzenle, `C` görev ekle. Teklif: `Tab` hücreler arası, `Ctrl/Cmd+Enter` yeni kalem, `Ctrl/Cmd+S` kaydet, `Alt` kombinasyonu yok. Odak sırası: başlık → müşteri → kalemler → toplamlar → onay şeridi → sürüm geçmişi → önizleme (önizleme `tabindex=0`, `aria-label`).

**Durumlar**
- Yükleniyor: sütun/kart ve PDF iskeleti ("Önizleme hazırlanıyor"). Boş: "Bu aşamada fırsat yok" (sütun içi, sürükleme yönergesi). Hata: PDF üretilemedi → önizlemede `--danger` ikon + yeniden dene; kayıt çakışması → "Teklif v3 başka bir kullanıcı tarafından değiştirildi, karşılaştır". Çevrimdışı: düzenleme çevrimdışı kilitlenir (teklifler çakışmayı önlemek için salt okunur), şerit.

**Hareket / a11y**
- Kart bırakma 160 ms yerleşme; toplamlar 200 ms sayısal geçiş (reduced-motion'da yok). Kanban `role="list"`, sütun toplamı `aria-live="polite"` ("Teklif: 3 fırsat, toplam 980 bin TL"). PDF önizleme güncellemesi debounce 600 ms, `aria-busy`. Sürüm karşılaştırması iki sütun metinsel diff ile.

**Yoğunluk / responsive**
- Kompakt kartlar tek satır. Tablette PDF önizleme sekmeye taşınır. Mobil: pipeline sütun kaydırma, teklif kalemleri kart liste, PDF önizleme "Önizle" tam sayfa.

---

## 11. B2C sipariş merkezi ve Müşteri 360

```text
=== Sipariş merkezi ==========================================================
| [Tümü 214][Ödeme bekliyor 12][Hazırlanıyor 31][Kargoda 58][İade 6][Gecikmiş (!) 4] [+ Filtre] |
| [ ] Sipariş    Müşteri         Tutar     Durum         Ödeme       Güncellendi |
| [ ] SO-20418   Ayşe Kara [kişi B2C] 1.249 TL Hazırlanıyor ✓ Ödendi   09:12   |
| [ ] SO-20421   Barış Uçar [kişi B2C]  389 TL Ödeme bekl. ⏱ Bekliyor  09:30   |
| 2 seçili: [Durum] [Ata] [Dışa aktar*]       * politikaya bağlı  (sanal liste)|

=== Müşteri 360 ============================================================
| Ayşe Kara  [kişi B2C]  [RFM: Sadık ★]  [Rıza: Arama ✓ SMS ✗]    [☎ Ara] [⋯] |
+--------------------+-------------------------------+---------------------+
| ÖZET               | ZAMAN ÇİZELGESİ               | SİPARİŞLER (5)      |
| LTV  7.420 TL      | Çağrı · 6 dk · Tuba Sönmez    | SO-20418 Hazırl.    |
| Son sip. 12 gün    | Sipariş SO-20418 oluşturuldu  | SO-19877 Teslim     |
| RFM  R4 F5 M4      | Not: iade talebi [@Elif Demir]| ÇAĞRI GEÇMİŞİ       |
| Rıza durumu        | [Tümü|Çağrı|Sipariş|Not]      | 20 Kas 10:15 ▶ 6:12 |
| Segment rozetleri  |                               | Disposition: Bilgi  |
| [kişi B2C]         |                               |                     |
+--------------------+-------------------------------+---------------------+
```

**Token kullanımı**
- Tablo `--bg-surface` + dekoratif `--border` satır çizgileri; filtre çipleri girdi sınırı `--border-strong`, seçili çip `--accent-soft` + `--accent` metin + onay ikonu; çip içi sayılar `tabular-nums`.
- Segment rozeti: kişi ikonu + "B2C", `--b2c-soft` zemin + `--b2c` metin/ikon; marka kırmızısıyla aynı olduğu için etiket ve ikon zorunlu (kural d). Çok segmentli kişide iki rozet yan yana (`--b2b-soft` bina + "B2B").
- Durum: Ödendi `--success` ikon + metin, Bekliyor `--warning` ikon + metin, Gecikmiş/İade hatası `--danger` ikon + metin (kural c). RFM etiketi `--bg-subtle` + yıldız ikonu + metin; rıza satırı ✓/✗ ikonları + "İzin var/yok" metin (`--success`/`--text-secondary`, hata rengi kullanılmaz).
- Başlık Space Grotesk 24, LTV 32 `tabular-nums`. Ana buton "Ara" (kural a). Sipariş merkezi başlığı 20.

**Görünürlük kuralları**
- Sipariş merkezi yalnızca "B2C satış" etkin ve kullanıcı B2C yetkisindeyse; `b2b_only` tenant'ta yok. Can Öz (yalnız B2B) B2C sipariş URL'sini açarsa **404**. Zeynep Arslan kendi kapsamı; Elif Demir ekibi (B2C Perakende).
- Müşteri 360 yalnızca "CRM ve müşteri 360" etkin + erişilebilir segmentler için; **çok segmentli** müşteride kullanıcı hangi segmentlere yetkiliyse yalnızca o segmentlerin siparişi/geçmişi, rozeti ve çağrıları görünür. Okan Tekin (B2B+B2C) iki segmentin geçmişini rozetli görür; Tuba Sönmez yalnızca B2C kısmını.
- "Çağrı geçmişi" ve ▶ kayıt dinleme: yalnızca "Çağrı merkezi ve santral" açık + kayıt dinleme yetkisi (Yönetici/Mert Kaya yalnız kendi segment/ekibi); başkası için ▶ **hiç render edilmez**. "☎ Ara" rıza yoksa pasif değil, **engellenir ve nedeni gösterilir** ("Arama izni yok").
- RFM ve LTV alanları alan politikasına tabidir (gizliyse render edilmez). "Dışa aktar" yalnızca export yetkisi (Admin, Analist; Yönetici politikaya bağlı).
- Mention seçici ve bildirimleri ekran 8–9 kurallarıyla.

**Klavye ve odak sırası**
- Tablo: `J/K`, `X` seç, `Enter` aç, `/` filtre, `1-6` hızlı filtre çipleri, `C` görev. 360'ta `Alt+Y` kullanılmaz; `N` not, `T` zaman çizelgesi filtresi sekmeleri arası. Odak sırası: başlık → rozetler → ara/⋯ → özet → timeline → siparişler/çağrılar.

**Durumlar**
- Yükleniyor: tablo satır + 360 üç sütun iskeleti. Boş: "Filtreyle eşleşen sipariş yok" + "Filtreleri temizle"; müşteri hiç siparişsiz → "Henüz sipariş yok. [Sipariş oluştur]". Hata: kart içi hata. Çevrimdışı: son verilerle "Son güncelleme" etiketi, düzenleme kuyruğu.

**Hareket / a11y**
- Çip filtreleme 120 ms geçiş. Tablo `role="grid"`, çipler `role="group"` + `aria-pressed`; sonuç sayısı `aria-live="polite"` ("58 sipariş"). Segment rozeti `aria-label="Segment: B2C"`.

**Yoğunluk / responsive**
- Kompakt 32 px satır; sipariş merkezi çağrı temsilcisinde Kompakt. Mobil: tablo kart listesine dönüşür, 360 sekmeli (Özet|Zaman|Siparişler|Çağrılar).

---

## 12. Softphone / CTI çubuğu (4 durum)

```text
Yüzen cam katman, ekranın altında ortada (sürüklenebilir, kenara yapışır)

--- Boşta (Hazır) ---
| [☎ ● Hazır v]    Kuyruk: Müşteri Hizmetleri       Bugün 23 çağrı · Ort. 4:12 |

--- Çalıyor (ringing) ---
| [☎ ● ÇALIYOR] Gelen · 0532 ••• •• 41 · Ayşe Kara [kişi B2C]  Alt+K Kabul  Alt+L Reddet |

--- Görüşmede ---
| (•) 02:41  Ayşe Kara [kişi B2C]  [Alt+M Sessiz][Alt+B Beklet][Alt+T Aktar][Alt+L Kapat] |
| Not: ...[Alt+N]                                      Segment: [kişi B2C]       |

--- Wrap-up ---
| [⏱ Wrap-up 00:34 / 60 sn]  Sonuç kodu [Alt+S: Seç v]  Not [      ]  [Kaydet ve Hazır ol] |
|  Zorunlu: sonuç kodu seçilmeden "Hazır" olunamaz                              |
```

**Token kullanımı**
- Cam: `--bg-raised` yarı saydam + bulanıklık, `--radius-hero` 20 (yüzen kapsül), koyu temada `--border` kenarlık, açık temada `--shadow-card`. Metin `--text-primary`/`--text-secondary` 14, sayaç Space Grotesk 20 `tabular-nums`.
- Durum göstergeleri (ikon + metin): Hazır `--success` (onay ikonu), Görüşmede `--accent` + nabız animasyonlu `--spark` nokta (nokta dekoratif, "Görüşmede" metni yanında), Wrap-up `--warning` (saat ikonu), Mola `--info` (fincan), Çevrimdışı `--text-secondary` (daire-çizgi). "Çalıyor" `--accent` ikon + metin.
- **Kapat** düğmesi: `--danger` ikon + "Kapat" etiket; **açık temada** `--danger` metinli `--danger-soft`, **koyu temada `--accent-btn` zemin + `--on-accent`** yalnızca "Kabul/Kaydet ve Hazır ol" ana eylemleri için (kural a); "Kapat" `--danger-soft` + `--danger` ikon+metin (kural c: kırmızı marka rengiyle karıştırılmaz). Diğer kontroller ikincil (`--bg-surface`, `--border-strong`).
- Segment rozeti çağrı sırasında (ikon + etiket) `--b2c-soft`/`--b2b-soft`. Rakamlar `tabular-nums`. Aktif aramada çubuk kenarında kırmızı nabız (`--spark`, dekoratif).

**Görünürlük kuralları**
- Yalnızca "Çağrı merkezi ve santral" tenant'ta açık **ve** kullanıcının telefon yetkisi (arama alma/yapma) varsa render edilir. Zeynep Arslan (telefon: yok) hiç görmez; Can Öz/Deniz Çelik "arama yapma" modunda (gelen çağrı kabul yok), Tuba Sönmez/Okan Tekin alma+yapma. Yönetici (kayıt dinleme) için softphone yok, "Canlı izle" yönetici panelinde.
- "Aktar" hedef listesi yalnızca kuyruk/kullanıcı erişimi olanlar. Tıkla-ara rıza kontrolü başarısızsa engellenir + neden. "Çalıyor" kartında arayan ad/firma segment yetkisi dışıysa **gösterilmez** (ekran 13).
- Segment rozeti yalnızca çağrı sırasında ve yetkili segment için.
- Çağrı sırasında **bildirim toast'ı yok**; yalnızca çubuk içi minimal mention göstergesi, ayrıntı sonra.

**Klavye ve odak sırası**
- Kısayollar (0.3): `Alt+K` kabul, `Alt+L` kapat, `Alt+B` beklet, `Alt+T` aktar, `Alt+M` sessiz, `Alt+S` sonuç, `Alt+N` not, `Alt+R` hazır, `Alt+Y` durum seçici. Çubuk `region` landmark, global `F6` ile çubuğa odak atlama; Tab sırası: durum → kontroller → sayaç → not → sonuç kodu → kaydet. Çalıyor durumunda odak otomatik "Kabul" düğmesine **zorla** taşınmaz (kullanıcı yazıyorsa bozulmasın); bunun yerine `Alt+K` her yerden çalışır ve ses/duyuru verilir.

**Durumlar**
- Yükleniyor/bağlanıyor: "Santrale bağlanıyor…" iskelet. Hata: SIP kaydı başarısız → `--danger` ikon + "Telefon bağlantısı yok" + Yeniden bağlan; mikrofon izni reddedildi → yönerge. Çevrimdışı: durum "Çevrimdışı" (ağ koptu ve çağrı düştüyse kalıcı uyarı + otomatik geri arama önerisi). Wrap-up zaman aşımı: `--warning` metin "Süre doldu, Hazır'a geçiliyor" (politikaya bağlı).

**Hareket / a11y**
- "Çalıyor" ve "Görüşmede": nabız 1.2 sn; **reduced-motion'da** nabız kapanır, statik dolu nokta + metin kalır. Durum değişimleri `aria-live="polite"` ("Gelen çağrı: Ayşe Kara"); düşme/hata `assertive`. Düğmeler `aria-keyshortcuts="Alt+K"`. Sayaç `role="timer"` (saniye saniye okunmaz, 30 sn'de bir). Renge değil metne dayalı durum.

**Yoğunluk / responsive**
- Çağrı temsilcisi varsayılanı Kompakt (çubuk 44 px yüksekliğinde tek satır). Tabletten itibaren görünür; **mobilde softphone kapsül (alt çubuk üstünde)** minimal sürümde (kabul/kapat/sessiz), tam kontroller çekmecede.

---

## 13. Ekran açma kartı (screen pop)

```text
Sağdan kayan kart (cam) — dört durum

--- A) Bilinen müşteri ---
| Gelen çağrı · Müşteri Hizmetleri         00:03 |
| Ayşe Kara  [kişi B2C]  [RFM: Sadık ★]          |
| Son etkileşim: 12 gün önce, SO-19877 teslim    |
| Açık talepler: 1 iade (SO-20418)               |
| [Alt+K Kabul] [Aç 360]  [Yeni kayıt]           |

--- B) Birden fazla eşleşme ---
| Gelen çağrı · 0532 ••• •• 41                   |
| 3 olası kişi eşleşti — seçin:                  |
| (•) Ayşe Kara [kişi B2C]   Son: 12 gün         |
| ( ) Ayşe Karaca [kişi B2C] Son: 2 ay           |
| ( ) Orion Lojistik / A. Kara [bina B2B]        |
| [Kabul] [Seçileni aç] [Hiçbiri, yeni kayıt]    |

--- C) Bilinmeyen numara ---
| Gelen çağrı · Bilinmeyen numara                |
| 0212 ••• •• 87                                 |
| Bu numara için kayıt bulunamadı.               |
| [Kabul]  [Yeni müşteri oluştur]  [Not al]      |

--- D) Yetkisiz segmentli arayan (örn. Tuba Sönmez'e B2B kişisi) ---
| Gelen çağrı · Yetkisiz veya bilinmeyen arama   |
| (ad, firma, geçmiş, segment: HİÇBİRİ GÖSTERİLMEZ) |
| Çağrıyı yetkili ekibe aktarabilirsiniz.        |
| [Kabul] [Aktar: Karma Kuyruk] [Reddet]         |
```

**Token kullanımı**
- Cam kart `--bg-raised` yarı saydam, `--radius-hero` 20, koyu: `--border`; üst kenar nabızlı `--spark` çizgisi (dekoratif). Ad Space Grotesk 20, segment rozeti ikon + etiket (kural d), RFM `--bg-subtle`.
- Ana buton "Kabul" `--accent-btn`/`--on-accent` (koyu) veya `--primary`/`--on-primary` (açık) (kural a). İkincil `--bg-surface` + `--border-strong`. Seçim radyoları `--border-strong`.
- Durum D: nötr `--info-soft` zemin + `--info` bilgi ikonu + metin; **hata/kırmızı değil** (bu bir hata değil). Maskelenmiş numara `tabular-nums`.

**Görünürlük kuralları** (spec CC-05)
- Kart içeriği, **arayanın eşleşen kayıtlarından yalnızca çağrıyı alan kullanıcının yetkili olduğu segmentlerdekileri** gösterir. **Durum D'de (Tuba Sönmez yalnız B2C iken B2B kişisi arıyor): ad, firma, segment rozeti, geçmiş, açık talep, hatta "B2B kişisi" ifadesi bile gösterilmez.** Yalnızca "Yetkisiz veya bilinmeyen arama" yazılır; numara bile kısmen maskelenir. İstek/yanıt düzeyinde de bu bilgiler istemciye **hiç gönderilmez** (sunucu tarafı süzme).
- Okan Tekin (B2B+B2C) aynı arayanda tam 360 kartını görür; iki segmentin geçmişi rozetli (Matris B senaryosu).
- Durum B'de yetkisiz segmentteki adaylar **listeden çıkarılır**; yalnızca yetkili adaylar sayılır ("3 olası kişi" sayısı da yetkili adaylara göre).
- Kart yalnızca softphone yetkisi olan kullanıcıda; modül kapalıysa yok. Aktar hedefleri yalnızca kullanıcının erişebildiği kuyruklar.
- Alan düzeyi gizli alanlar (ör. kimlik numarası) kartta hiç render edilmez.

**Klavye ve odak sırası**
- `Alt+K` kabul, `Alt+O` kartı aç/kapat, `Alt+N` not; kart içinde ok tuşları adaylar, `Enter` seçileni aç. Kart **odağı çalmaz** (yazma bozulmaz); `Alt+O` ile odak karta gelir, `Esc` odağı önceki yere döndürür. Sıra: adaylar → Kabul → Aç → Yeni kayıt.

**Durumlar**
- Yükleniyor: eşleşme aranırken <300 ms "Arayan aranıyor…" iskeleti; arama sonucu gelmeden kart yine de çalan çağrıyı gösterir (maskeli numara). Hata: eşleştirme servisi yanıt vermedi → durum C gibi "Müşteri bilgisi alınamadı" (`--warning` ikon + metin) ve "Yeniden dene". Çevrimdışı: yalnızca numara ve kabul/red.

**Hareket / a11y**
- Sağdan 160 ms kayma; reduced-motion'da anında belirir, nabız yok. Kart `role="alertdialog"` **değil**; `role="region"` + `aria-label="Gelen çağrı"` ve içerik `aria-live="polite"` ile duyurulur ("Gelen çağrı. Ayşe Kara, B2C, son etkileşim 12 gün önce"). Durum D yalnızca "Yetkisiz veya bilinmeyen arama" okur.

**Yoğunluk / responsive**
- Kompakt: kart yüksekliği küçülür, son etkileşim tek satır. Mobilde alttan kayan sayfa; masaüstü yok sayılabilir.

---

## 14. Çağrı merkezi temsilci cockpit'i

```text
+------------------------------------------------------------------------------+
| Çağrı merkezi ve santral   Tuba Sönmez     Kuyruk: Müşteri Hizmetleri  [Kompakt] |
+--------------------------+-----------------------------+---------------------+
| SIRADAKİ ARAMALAR (4)    | HEDEF                       | GERİ ARAMA LİSTESİ  |
| ☎ Ayşe Kara [kişi B2C]   |       ,-"""-.   Bugün       | 14:00 Barış Uçar    |
|   Geri arama · Bugün 14:00|      / 15/22  \  15 / 22 çağrı| 15:30 Selin Er      |
| ☎ Mehmet Uçar            |       `-...-'   (%68)       | Gecikti (!) 11:00   |
|   SLA: 12 dk kaldı (⏱)   | Ort. süre 4:12 · CSAT 4,6   | Mehmet Uçar         |
+--------------------------+-----------------------------+---------------------+
| Bugünün özeti: Alınan 23 · Giden 8 · Wrap-up ort. 0:38                       |
+------------------------------------------------------------------------------+
| KISAYOLLAR  Alt+K Kabul  Alt+L Kapat  Alt+B Beklet  Alt+T Aktar  Alt+S Sonuç  Alt+N Not  Alt+R Hazır |
+------------------------------------------------------------------------------+
|                    [ Softphone çubuğu (ekran 12) ]                           |
```

**Token kullanımı**
- Varsayılan **koyu tema** önerilir: `--bg-canvas`, kartlar `--bg-surface` + `--border`, yükseltilmiş yüzeyler `--bg-raised`. Tuba için Kompakt yoğunluk (satır 32 px).
- Hedef halkası: yay `--accent` (görsel), merkezde "15 / 22" Space Grotesk 32 `tabular-nums` + "%68" metni. Geri arama gecikmiş: `--danger` ikon + "Gecikti" (kural c); SLA kalan süre `--warning` ikon + metin.
- Segment rozeti ikon + etiket (`--b2c-soft` + `--b2c`). Kısayol bandı `--bg-subtle`, tuşlar `--border-strong` sınırlı kapsüller. Ana buton "Ara" `--accent-btn`/`--on-accent` (kural a).

**Görünürlük kuralları**
- Yalnızca "Çağrı merkezi ve santral" açık + telefon yetkisi olan **Çağrı Temsilcisi** (ve arama yapma yetkili Satış Temsilcisi: Can Öz, Deniz Çelik, daraltılmış cockpit) varsayılan ekran olarak görür. Siradaki aramalar kuyruk üyeliğine göre; Tuba Sönmez yalnız B2C kayıtlarını görür, Okan Tekin karma kuyrukta iki segmenti rozetli görür.
- "Hedef" kartı "Satış takibi ve hedefler" kapalıysa yoktur; çağrı sayısı hedefi yerine yalnızca günlük sayaç gösterilir. Geri arama listesi yalnızca rızası olan kişiler için "Ara" düğmeli, rızasız kişide engellenme nedeni yazar.
- QA geri bildirimi kartı yalnızca "Çağrı merkezi ve santral" QA kısmı açıksa. Yetkisiz segmentteki geri aramalar hiç listelenmez.

**Klavye ve odak sırası**
- Çağrı kısayolları 0.3'teki gibi; ek: `J/K` listede gezin, `Enter` seçili çağrıyı/kaydı aç, `A` yerine **`Alt+R`** hazır. `G B` bu ekrana dönüş. Odak sırası: Sıradaki aramalar → Hedef → Geri arama listesi → Kısayol bandı (okunur) → Softphone.
- Bu ekranda `C` yeni görev çalışır; çağrı sırasında yazma alanı odaktaysa tek harf kısayolları devre dışıdır, `Alt+` kombinasyonları çalışır.

**Durumlar**
- Yükleniyor: kart iskeletleri. Boş: sıra boşsa "Şu an bekleyen arama yok. Geri arama listesine göz atın." + tek aksiyon. Hata: kuyruk verisi alınamadı `--danger` ikon + yeniden dene. Çevrimdışı: kalıcı şerit; durum "Çevrimdışı".
- Çağrı sırasında bildirimler susturulur; wrap-up bitince özet gösterilir.

**Hareket / a11y**
- Halka dolum animasyonu reduced-motion'da kapalı; aktif çağrı nabzı statik nokta. Canlı sayaçlar `aria-live="off"`, kuyruk uzunluğu değişimi `polite`. Kısayol bandı görünür metindir ve `?` yardımıyla aynı kaynaktan üretilir.

**Yoğunluk / responsive**
- Varsayılan Kompakt; Rahat'a geçilebilir. Tablet: iki sütun. Mobil için cockpit sınırlı (sıradaki aramalar + geri arama), kısayol bandı gizli.

---

## 15. Wallboard (büyük ekran, koyu tema)

```text
+------------------------------------------------------------------------------+
| ᚱ• flexa      WALLBOARD · Müşteri Hizmetleri      14:32:07      ● Canlı    |
+--------------------+-------------------+-------------------+-----------------+
| KUYRUKTA BEKLEYEN  | HİZMET SEVİYESİ   | ORT. BEKLEME      | BUGÜN ÇAĞRI     |
|        7           |   82%  / hedef 80 | 00:48             |   412           |
|  En uzun 02:14 (⏱) |   ✓ Hedefte       |                   | Cevaplanan 389  |
+--------------------+-------------------+-------------------+-----------------+
| TEMSİLCİ DURUMLARI                                                           |
| [✓ Hazır] Okan Tekin   [● Görüşmede 03:12] Tuba Sönmez   [⏱ Wrap-up] D. Çelik |
| [☕ Mola 05:00] ...    [○ Çevrimdışı] ...                                    |
+------------------------------------------------------------------------------+
| CANLI AKIŞ: 14:31 Tuba Sönmez çağrıyı sonlandırdı · 14:30 Kuyruk uyarısı (!)  |
+------------------------------------------------------------------------------+
```

**Token kullanımı**
- **Koyu tema zorunlu**: `--bg-canvas`, kartlar `--bg-surface`, öne çıkan `--bg-raised`; çerçeve `--border`. Başlıklar Space Grotesk, KPI **44** `tabular-nums` (`--text-primary`), etiket 20 `--text-secondary` (uzak mesafe için minimum 20).
- Hizmet seviyesi hedefte: `--success` ikon + "Hedefte" metin; altında `--danger` ikon + "Hedef altı"; hiçbir durum yalnızca renkle (kural c). Temsilci durum ızgarası: Hazır `--success`, Görüşmede `--accent` (+ nabız `--spark` dekoratif), Wrap-up `--warning`, Mola `--info`, Çevrimdışı `--text-secondary`; her hücrede ikon + metin + süre.
- Canlı nokta `--spark` + "Canlı" metin. Uyarı satırı `--warning` ikon + metin. Grafik serileri paletten (koyu temada füme seri yerine `--b2b` açık ton) ve çizgi stili ile ayırt edilir. Segment rozeti ikon + etiket.

**Görünürlük kuralları**
- Yalnızca "Çağrı merkezi ve santral" açık ve kullanıcı **Yönetici/Admin/Analist** veya wallboard yetkisi olan role sahipse; **Admin** wallboard "kiosk" bağlantısı üretir (salt okunur, süreli, imzalı anahtar, audit'li). Çağrı Temsilcisi göremez (menüde yok).
- Wallboard kapsamı kullanıcının **ekip/kuyruk + segment** yetkisiyle sınırlıdır: Mert Kaya (B2B) yalnızca B2B kuyruklarını, Elif Demir B2C'yi, Burak Aydın ikisini (segment rozetli). Kiosk bağlantısı tek bir kuyruk/segment kümesine bağlıdır.
- **Kişisel veri minimizasyonu:** wallboard müşteri adı/numarası göstermez; yalnızca temsilci adı ve sayılar (müşteri kimliği içeren olay akışta maskeli).
- "Canlı izle/dinle" eylemi wallboard'da yoktur (Yönetici paneli).

**Klavye ve odak sırası**
- `F` tam ekran, `T` tema (koyu kilitlenebilir), `Space` duraklat/devam (veri akışı), `1-4` düzen ön ayarı, `Esc` tam ekrandan çık. Kiosk modunda etkileşim yoktur; yönetici önizlemesinde Tab sırası: araç çubuğu → KPI kartları → ızgara → akış.

**Durumlar**
- Yükleniyor: kart iskelet. Boş: kuyruk boşsa "Bekleyen çağrı yok" büyük metin + `--success` ikon. Hata/bağlantı koptu: üstte **büyük** `--warning` şerit "Canlı veri kesildi · son güncelleme 14:31:55" (ikon + metin) ve değerler soluklaşır; yeniden bağlanınca otomatik. Kiosk anahtarı süresi dolarsa "Oturum sona erdi" ekranı.

**Hareket / a11y**
- Sayı değişimi 200 ms; ızgara durum geçişi yumuşak; reduced-motion'da animasyonsuz (+ nabız kapalı). Izgara `role="list"`, kuyruk uzunluğu `aria-live="polite"` yalnızca eşik aşıldığında (aşırı duyuru yok). Kontrast ≥ 4.5:1 (token'lar doğrulanmış), minimum yazı 20.

**Yoğunluk / responsive**
- Yoğunluk uygulanmaz (ölçek büyütülür). Tasarım 1920×1080 ve 4K; 16:9 ölçeklenir, kırılım yok; mobilde "Wallboard geniş ekran içindir" bilgisi.

---

## 16. Yönetici cockpit'i ve Onay kutusu

```text
=== Yönetici paneli (Mert Kaya, B2B Kurumsal) ===============================
| Ekip: B2B Kurumsal    Dönem: Kasım ▾     [B2B|B2C|Tümü*]  (* yalnızca both + çift yetki) |
+------------------------+---------------------------+-----------------------+
| EKİP HEDEF HALKALARI   | KİŞİ PERFORMANS ŞERİDİ    | CANLI ÇAĞRI DURUMLARI |
| (68%) Ekip  850K/1,25M | Can Öz     ▓▓▓▓▓▓░░ %72 ▲ | ● Okan T. Görüşmede 3:12|
| (72%) Can Öz           | Deniz Çelik▓▓▓▓░░░░ %51 ▼ | ✓ Deniz Ç. Hazır       |
| (51%) Deniz Çelik      | (sıralama: hedefe oranla) | ⏱ Wrap-up …           |
+------------------------+---------------------------+-----------------------+
| ONAY KUTUSU (3)                              | UYARILAR (2)                   |
| İskonto %12 · Orion T-118 · Can Öz [Onayla][Reddet] | (!) 3 fırsat 14 gündür hareketsiz |
| İzin talebi · Deniz Çelik  [Onayla][Reddet]  | (!) SLA riski: 2 görev         |
+----------------------------------------------+--------------------------------+
| SEGMENT KARŞILAŞTIRMA (yalnızca both)   B2B ▓▓▓▓▓ 1,24 M | B2C ▓▓▓ 0,86 M     |

=== Onay kutusu (tam sayfa) ===
| [Bekleyen 3][Onayladıklarım][Reddettiklerim]   Tür: [Tümü v]                 |
| □  İskonto onayı  Orion T-118  %12 (sınır %10)  Can Öz  [bina B2B]  1 sa önce |
|    Gerekçe: "Çok yıllı sözleşme"   [Detay] [Onayla] [Reddet — gerekçe zorunlu] |
```

**Token kullanımı**
- Bento kartlar `--bg-surface` + `--border`, `--radius-card` 16; ekip hero halkası `--radius-hero` 20. Halkalar yay `--accent`, merkezde yüzde `tabular-nums` Space Grotesk 32; her halkada sayısal etiket. Performans şeridi çubuğu `--primary` (koyu: `--b2b`), trend ▲ `--success`/▼ `--danger` ikon + metin.
- Canlı çağrı durumları 10.5.3 renkleri + ikon + metin. Segment karşılaştırma: seri çizgi stili ve işaretçi şekliyle ayırt (`--b2b` füme, `--b2c` kırmızı) + doğrudan etiket; renk yalnızca destek.
- Onay kutusu: "Onayla" ana buton (kural a), "Reddet" ikincil (`--border-strong`, `--danger` ikon + metin); gerekçe girdisi `--border-strong`. Uyarı satırı `--warning-soft` + `--warning` ikon + metin.

**Görünürlük kuralları**
- "Yönetici paneli" yalnızca **Yönetici, Admin** (Analist salt okunur); modül kapalıysa yok. Kapsam: Mert Kaya yalnızca B2B Kurumsal ekibi ve B2B segmenti; Elif Demir B2C Perakende; Burak Aydın karma ekip ve ikisi; Mert, B2C ekibini **göremez** (404/yok). **Segment karşılaştırma** kartı ve segment değiştirici yalnızca `both` modunda ve çift segment yetkili yönetici/Admin'de (Burak Aydın, Ayşe Yılmaz); `b2b_only` tenant'ta hiç render edilmez (yalnızca B2B metrikleri).
- "Canlı çağrı durumları" yalnızca "Çağrı merkezi ve santral" açıksa ve kullanıcının canlı izleme yetkisi varsa (Burak Aydın: kayıt + canlı izleme; Mert Kaya yalnızca kayıt dinleme → durumlar var, "Canlı dinle" düğmesi yok). Canlı dinle eylemi temsilciye politika gereği bildirim gönderir ve audit'lenir.
- "Hedef halkaları" yalnızca "Satış takibi ve hedefler" açıksa. Onay kutusu yalnızca onay yetkili olana; kişi kendi talebini onaylayamaz. Alan düzeyi gizli tutarlar (ör. maliyet) gösterilmez. Export yetkisi yoksa "Dışa aktar" yoktur.
- Mert Kaya, Can'a B2C yetkisi vermeye çalışırsa veya kendi rolünü yükseltmeye çalışırsa reddedilir (ekran 17).

**Klavye ve odak sırası**
- `J/K` onay satırları, `Enter` detay, `A` onayla, `R` reddet (gerekçe alanına odak), `F` filtre, `Tab` kartlar arası. Çağrı kısayolları bu ekranda yoktur. Odak sırası: dönem/segment → ekip halkaları → performans şeridi → canlı çağrılar → onay kutusu → uyarılar → segment karşılaştırma.

**Durumlar**
- Yükleniyor: kart iskeletleri, bağımsız. Boş: "Bekleyen onay yok. İyi iş!" + çizgi illüstrasyon; ekip hedefi yoksa "Hedef ata". Hata: kart bazlı hata, diğerleri çalışır. Çevrimdışı: son veri etiketi; onay/reddet devre dışı + şerit. Onay sonrası geri alma toast'ı (10 sn). Gerçek zamanlı: yeni onay `aria-live="polite"`.

**Hareket / a11y**
- Halka ve çubuk dolumları reduced-motion'da kapalı. Grafikler `role="img"` + `aria-label` özet + tablo alternatifi ("Tablo olarak görüntüle"). Canlı durumlar `aria-live="off"` (aşırı duyuru yok), onay sayısı `polite`.

**Yoğunluk / responsive**
- Rahat varsayılan; Kompakt satır 32 px. Tablet: iki sütun; mobil: onay kutusu birincil (kaydırarak onayla alternatif düğmeli), cockpit kartları dikey sıralı.

---

## 17. Yetki matrisi editörü ve Kullanıcı yetki matrisi

```text
=== Rol/izin matrisi editörü (Admin: Ayşe Yılmaz) ============================
| Rol × Yetki                [Sürüm geçmişi v12 v] [Diff önizleme] [Kaydet]  |
|                     | Admin | Yönetici | Satış Tem. | Çağrı Tem. | Analist |
| CRM ve müşteri 360  |                                                       |
|  Kayıt görüntüle    |   ●   |    ●     |     ◐      |     ◐      |   ●     |
|  Kayıt düzenle      |   ●   |    ◐     |     ◐      |     —      |   —     |
| B2B satış           |                                                       |
|  Teklif iskonto onayı|  ●   |    ◐     |     —      |     —      |   —     |
| Çağrı merkezi ve santral                                                    |
|  Kayıt dinleme      |   ●   |    ◐     |     —      |     —      |   —     |
|  (B2C satış satırları: modül kapalı → HİÇ GÖRÜNMEZ)                          |
| Hücre: — yok  ◐ kapsamlı (kendi/ekip)  ● tam   · tıkla/Space ile döngü       |
+----------------------------------------------+------------------------------+
| DIFF ÖNİZLEME (kaydetmeden önce)             | ETKİLENEN KULLANICILAR (4)   |
|  Satış Tem. · Kayıt düzenle: ◐ → —           | Can Öz, Deniz Çelik, …       |
|  ⚠ 3 aktif görev açık: etkilenir             | Elif D. (Yönetici) etkilenmez|
|  [İptal]                      [Onayla ve yayınla] |                            |
+----------------------------------------------+------------------------------+

=== Kullanıcı yetki matrisi ===================================================
| Kullanıcı     Rol         B2B  B2C  Kapsam    Ekip/Kuyruk        Telefoni        Rapor        Export  |
| Mert Kaya     Yönetici    ●    —    Ekip      B2B Kurumsal       Kayıt dinleme   Ekip, B2B    Politika|
| Can Öz        Satış Tem.  ●    —    Kendi     B2B Kurumsal       Arama yapma     Kişisel      Hayır  |
| Zeynep Arslan Satış Tem.  —    ●    Kendi     B2C Perakende      Yok             Kişisel      Hayır  |
| Tuba Sönmez   Çağrı Tem.  —    ●    Kuyruk    Müşteri Hizmetleri Alma/yapma      Kişisel      Hayır  |
| Süreli yetki: Deniz Çelik · B2C ● · 25 Kas – 05 Ara  ⏱ [Süreyi uzat][Kaldır]      |
| [Bu kullanıcı olarak gör]  (yalnızca Admin · audit'li · salt okunur · 15 dk)       |
```

**Token kullanımı**
- Matris tablosu `--bg-surface`, hücre sınırları **`--border-strong`** (etkileşimli bileşen sınırı) ve dekoratif satır grupları `--border`. Hücre simgeleri `—` (boş daire-çizgi), `◐` (yarım), `●` (dolu) + **metin etiketi** ("Yok / Kapsamlı / Tam") `aria-label` ve tooltip'te; yalnızca şekle bağlı değil.
- Değişen hücre diff için: eklenen `--success-soft` + `--success` ikon (+), kaldırılan `--danger-soft` + `--danger` ikon (−), kapsam daraltma `--warning-soft` + `--warning` ikon (≈); hepsi ikon + metin (kural c).
- Süreli yetki rozeti `--info-soft` + `--info` saat ikonu + tarih metni. Rol rozetleri 10.5.3. Segment kolonları ikon + etiket (`--b2b-soft`/`--b2c-soft`). "Bu kullanıcı olarak gör": `--warning-soft` bant + uyarı ikonu + metin ("Salt okunur görünüm: Can Öz olarak"), sabit üst şerit.
- "Onayla ve yayınla" ana buton (kural a), bölüm başlıkları Space Grotesk 20; sürüm numarası `tabular-nums`.

**Görünürlük kuralları**
- Rol/izin matrisi editörü yalnızca **Admin** (Ayşe Yılmaz) için düzenlenebilir; Yönetici yalnızca **kendi yetki sınırı içinde** kullanıcı atama/kapsam daraltma yapar (Mert Kaya, kendinde olmayan B2C yetkisini veremez, kendi rolünü Admin yapamaz: reddedilir ve nedeni açıklanır). Analist salt okunur görür; diğer roller menüde görmez.
- **Kapalı modülün satırları gizlidir** (ör. B2C satış kapalıysa o izinler matriste yoktur; veri korunur, yeniden açılınca satırlar döner). `b2b_only` tenant'ta B2C sütunları/satırları yoktur. Tenant planında olmayan modül satırı da yoktur.
- Kullanıcı yetki matrisinde kişi satırlarının görünürlüğü yöneticinin kapsamıyla sınırlıdır (Mert Kaya yalnız kendi ekibi). Hesap ele geçirme riskine karşı yüksek yetki değişiklikleri (Admin rolü) ek doğrulama ister. Süre sonunda yetki otomatik kalkar ve audit'lenir.
- **"Bu kullanıcı olarak gör" yalnızca Admin**, her kullanımı audit'lenir (kim, kimin yerine, ne zaman, hangi sayfalar), salt okunur, 15 dk ile sınırlı, hedef kullanıcıya politika gereği bildirim; Admin'in kendi üstündeki kullanıcıya (başka Admin) uygulanamaz.

**Klavye ve odak sırası**
- Matris `role="grid"`; ok tuşlarıyla hücre gezinti, `Space`/`Enter` hücre döngüsü (— → ◐ → ● → —), `Shift+Space` satırı tüm rollerde ayarla, `Ctrl/Cmd+Z` hücre geri al, `Ctrl/Cmd+S` diff önizlemeyi aç (kaydetmez), `Esc` diff'i kapat. Odak sırası: araç çubuğu → matris (satır-sütun) → diff paneli → etkilenen kullanıcılar → Onayla.
- Kullanıcı matrisinde `/` filtre, `Enter` kullanıcı detay panelini aç.

**Durumlar**
- Yükleniyor: matris iskeleti. Boş: kullanıcı yoksa "Bu ekipte kullanıcı yok. [Kullanıcı davet et]". Hata: kaydetme reddedildi (ör. çelişen politika, kendi yetkisinden fazla) `--danger` ikon + metin + hangi hücre; sürüm çakışması → "v12 başkası tarafından yayınlandı, diff'i yenile". Çevrimdışı: matris salt okunur, şerit. Geri alma: sürüm geçmişinden "Bu sürüme dön" + diff.

**Hareket / a11y**
- Hücre durum geçişi 120 ms; reduced-motion'da anında. Hücreler `role="gridcell"` + `aria-label="Satış Temsilcisi, Kayıt düzenle: Kapsamlı"`, durum değişimi `aria-live="polite"`. Diff listesi metin tabanlı, ekran okuyucu uyumlu. "Bu kullanıcı olarak gör" bandı `role="status"` ve kalıcı.

**Yoğunluk / responsive**
- Kompakt hücre 28 px (yoğun matris için önerilen). Tablet/mobilde matris salt okunur ve yatay kaydırmalı; düzenleme için "Düzenleme masaüstünde yapılır" uyarısı.

---

## 18. Tenant alanı ve yönetim konsolu

```text
+------------------------------------------------------------------------------+
| Tenant alanı ve yönetim konsolu   Atlas Teknoloji      Plan: Kurumsal          |
| [Modül kataloğu|Yapılandırma|Marka|Telefoni|Kullanım ve kota|Data servisi]   |
+------------------------------------------------------------------------------+
| MODÜL KATALOĞU                                                                |
| B2B satış                       [ Açık  (●)]                                  |
| B2C satış                       [ Açık  (●)]                                  |
| Çağrı merkezi ve santral        [ Açık  (●)]  Bağımlı: Satış takibi ve hedefler|
| Satış takibi ve hedefler        [ Açık  (●)]                                  |
|  (!) Satış takibi ve hedefler kapatılırsa Çağrı merkezi ve santral'ın hedef    |
|      kartları da kapanır. 12 kullanıcı etkilenir. [Vazgeç] [Yine de kapat]     |
+------------------------------------------------------------------------------+
| YAPILANDIRMA EDİTÖRÜ                          | DEĞİŞİKLİK (diff)             |
| satış_modu: both                              | - wrap_up_sn: 60              |
| wrap_up_sn: 90                                | + wrap_up_sn: 90              |
| [Doğrula]                                     | [Uygula] [Geri al → v7]       |
+------------------------------------------------------------------------------+
| MARKA                                         | ÖNİZLEME                      |
| Logo [Yükle]   Vurgu rengi [ renk seçici ]    |  [Aa] Ana buton  [Bağlantı]   |
| Kontrast: Metin 5,9:1 ✓   Metin dışı 3,4:1 ✓  |  koyu tema: ✓ otomatik koyulaştırıldı |
| Koyu temada ana buton: --accent-btn/--on-accent ✓                             |
+------------------------------------------------------------------------------+
| KULLANIM VE KOTA   Kullanıcı 42/50 · Depolama 61% · AI 8.2K/10K istek         |
| DATA SERVİSİ İSTEMCİLERİ  IVR-Prod (aktif) · Santral-Test  [+ İstemci ekle]    |
+------------------------------------------------------------------------------+
```

**Token kullanımı**
- Sekmeler: seçili sekme `--accent` metin + alt çizgi + `aria-selected`. Anahtarlar kapalı `--bg-subtle` + `--border-strong`, açık `--primary` (koyu: `--accent-btn`). Bağımlılık uyarısı `--warning-soft` + `--warning` ikon + metin; etkilenen sayı `tabular-nums`.
- Config editörü monospace; diff ekleme `--success-soft` (+ ikon), silme `--danger-soft` (− ikon), kodlar ikon/metinle. Girdiler `--border-strong`.
- **Marka kontrol geri bildirimi:** tenant yalnızca logo ve `--accent` (+ `--accent-hover`, `--accent-soft` türevleri) değiştirebilir. Kontrast sonucu "geçti" `--success` ikon + oran + metin, "başarısız" `--danger` ikon + metin + otomatik koyulaştırma önerisi (örn. "Seçilen renk zeminde 3,8:1; metin için ≥ 4,5:1 gerekir. [Otomatik koyulaştır]"). Önizleme **hem açık hem koyu temayı** ve koyu temadaki `--accent-btn`/`--on-accent` ana butonu gösterir (kural a). Marka yalnızca `--accent` ailesini etkiler: `--b2c` ayrı kalır, `--danger` hiç değişmez (kural c).
- Kullanım çubuğu `--primary` doluluk + eşik rozeti (`--warning` ikon + "%80 üzeri"), yüzde etiketli. Başlık Space Grotesk 24.

**Görünürlük kuralları**
- Konsol yalnızca **Admin** (tenant yöneticisi). Platform Operatörü bu konsolu "destek erişimi" ile ancak tenant onayıyla ve süreli görebilir (ekran 19). Yönetici ve diğer roller menüde görmez.
- **Modül kataloğu:** yalnızca tenant **planında bulunan** modüller aç/kapat edilebilir; plan dışı modül "Planınıza dahil değil" olarak listelenir (anahtarsız). Kapatılan modül menüden, API'den ve izinlerden çıkar, **veri korunur**. `b2b_only`/`b2c_only` geçişinde ilgili segment menüleri, segment değiştirici ve raporlar buna göre sadeleşir (10.4.5).
- Telefoni sekmesi yalnızca "Çağrı merkezi ve santral" açıksa; Data servisi sekmesi yalnızca "Data servisi ve entegrasyonlar" açıksa. Marka sekmesinde tenant yalnızca logo + `--accent`'i değiştirebilir (başka token yok). Yapılandırma editörü şema doğrulamalı, geçersiz kayıt reddedilir; diff + sürüm geri alma audit'lenir.
- Data servisi istemci anahtarı yalnızca oluşturma anında bir kez gösterilir, sonra maskelenir; whitelist alan seçici yalnızca izin verilen alanları sunar.

**Klavye ve odak sırası**
- Sekmeler ok tuşlarıyla; `Space` anahtarı çevirir; konfig editöründe `Ctrl/Cmd+Enter` doğrula, `Ctrl/Cmd+S` diff'i aç. Odak sırası: sekmeler → sekme içeriği → diff paneli → Uygula/Geri al. Uyarı diyaloğu focus trap, `Esc` vazgeç.

**Durumlar**
- Yükleniyor: sekme içerik iskeleti. Boş: Data servisi istemcisi yoksa "Henüz istemci yok. İlk istemciyi ekleyin" + tek aksiyon. Hata: kontrast başarısız, bağımlılık ihlali, geçersiz yapılandırma satır numarasıyla; telefoni test hatası adım teşhisiyle. Çevrimdışı: düzenleme kilitli. Kota doldu: `--warning`/`--danger` ikon + metin + "Planı yükselt" (Operatörle iletişim).

**Hareket / a11y**
- Anahtar geçişi 120 ms (reduced-motion'da yok). Anahtarlar `role="switch"` + açık durum metni. Kontrast sonucu `role="status"`, `aria-live="polite"`. Diff'te satır işaretleri +/− ikon ve metin.

**Yoğunluk / responsive**
- Kompakt 32 px. Tablet: sekmeler üstte kaydırılabilir; mobilde yalnızca görüntüleme + kritik anahtarlar, config editörü masaüstü gerekir.

---

## 19. Platform Operatörü konsolu (ayrı uygulama)

```text
+------------------------------------------------------------------------------+
| [ᚱ•] flexa · Platform Operatörü        (ayrı alan adı, ayrı oturum)  [OP v] |
+------------------------------------------------------------------------------+
| [Tenant'lar|Planlar|Kotalar|Destek erişimi talepleri|Denetim]                 |
| 🔍 Ara…   Durum: [Tümü v]  Plan: [Tümü v]                      [+ Tenant ekle] |
| Tenant              Plan      Satış modu  Kullanıcı  Kota     Durum           |
| Atlas Teknoloji     Kurumsal  both        42/50      %61      ✓ Aktif         |
| Nehir Perakende     Standart  b2c_only    18/25      %88 (!)  ✓ Aktif         |
| Kuzey Lojistik      Deneme    b2b_only    4/5        %20      ⏸ Askıda        |
+------------------------------------------------------------------------------+
| DESTEK ERİŞİMİ TALEPLERİ                                                      |
| #214 Nehir Perakende · "Fatura entegrasyonu hatası" · talep: Operatör Elif K. |
|  Süre: 60 dk · Kapsam: Yapılandırma (salt okunur)   Durum: Tenant onayı bekliyor |
|  (Operatör tenant verisini tenant onayı olmadan GÖREMEZ)  [Talebi iptal et]    |
```

**Token kullanımı**
- Operatör uygulaması aynı tasarım sistemini kullanır; kimlik karışmasın diye üst çubukta **"Platform Operatörü" metin etiketi** ve ikon (yalnız renk değil). Zemin `--bg-canvas`, tablo `--bg-surface`; tablo girdileri `--border-strong`.
- Durum: Aktif `--success` ikon + metin, Askıda `--warning` ikon + metin, Kapalı `--text-secondary` ikon + metin; kota eşiği aşıldığında `--danger` ikon + yüzde metni. Segment/satış modu rozetleri ikon + etiket (kural d). Ana buton (kural a).
- Destek erişimi durumları: Beklemede `--info`, Onaylandı `--success`, Reddedildi/Süresi doldu `--text-secondary`/`--danger`, hepsi ikon + metin. Sayılar `tabular-nums`, Space Grotesk başlık.

**Görünürlük kuralları**
- **Yalnızca Platform Operatörü hesapları** (tenant kullanıcılarından ayrı kimlik havuzu, ayrı oturum, zorunlu 2FA) erişir. Tenant Admin'i bu uygulamayı göremez. Tenant verisi (kayıtlar, çağrılar, müşteri) Operatör ekranında **yoktur**; yalnızca meta veri (plan, kota, sayılar, durum) görünür.
- **Destek erişimi:** Operatör bir tenant'ın içeriğine ancak tenant Admin'inin onayıyla, kapsamı ve süresi sınırlı, salt okunur olarak girer; her giriş audit'lenir ve tenant'ın "Kayıt ve audit" ekranında görünür. Süre bitince erişim otomatik kapanır.
- Plan/kota değişiklikleri Operatör eylemidir, tenant'a bildirim gider. Tenant askıya alma yalnızca iki kişi onayıyla (dört göz) önerilir; askıdaki tenant kullanıcıları giriş yaparken "Hesap askıda" görür.
- Tenant listesi sayfalıdır, kısıtlı alanlarda (ör. destek notu) alan düzeyi gizleme uygulanır.

**Klavye ve odak sırası**
- `/` arama, `J/K` satır, `Enter` tenant detay, `?` yardım; Cmd/Ctrl+K operatör komutları (tenant ara, plan değiştir). Operatör ekranlarında çağrı kısayolları yoktur. Odak sırası: sekmeler → filtreler → tablo → eylemler.

**Durumlar**
- Yükleniyor: tablo iskeleti. Boş: "Henüz tenant yok" + "Tenant ekle". Hata: işlem reddedildi `--danger` ikon + metin. Çevrimdışı: şerit; yazma eylemleri devre dışı. Askıya alma ve plan değişimi onay diyaloğu ister (etki: kullanıcı sayısı).

**Hareket / a11y**
- Standart mikro hareket; reduced-motion uyumlu. Tablo `role="grid"`, durum hücresi metinli; onay diyalogları focus trap. Oturum süresi daha kısa; süre dolmadan 2 dk önce `aria-live` uyarısı.

**Yoğunluk / responsive**
- Varsayılan Kompakt (operatör yoğun tablo kullanır). Mobil: tenant arama + detay görüntüleme; kritik eylemler (askıya alma) yalnızca masaüstü.

---

## 20. Rapor ekranları: hazır raporlar, rapor oluşturucu, dışa aktarma

```text
=== Hazır raporlar ===========================================================
| Raporlar      [Hazır raporlar|Oluşturucu|Zamanlanmış|Dışa aktarmalarım]     |
| [Segment: B2B|B2C|Tümü*]  Dönem: Kasım ▾                                      |
| +--------------------+ +--------------------+ +--------------------+         |
| | Satış hunisi       | | Hedef gerçekleşme  | | Aramadan satışa    |         |
| | [bina B2B]         | | Satış takibi…      | | Çağrı merkezi…     |         |
| +--------------------+ +--------------------+ +--------------------+         |

=== Rapor oluşturucu ========================================================
| Veri kaynağı [Fırsatlar v]  Alanlar [☑ Sahip ☑ Tutar ☐ Maliyet*]  *yetkiliyse|
| Satırlar: Sahip   Sütunlar: Aşama   Ölçü: Σ Tutar   Filtre: kapanış:bu ay     |
| Grafik: [Tablo|Çubuk|Çizgi]       Önizleme ->  tablo/grafik                    |
| [Kaydet] [Zamanla] [Dışa aktar v]                                              |

=== Dışa aktarma akışı ======================================================
| 1 Biçim [CSV|XLSX|PDF]   2 Alanlar (yetkili)   3 Politika ve onay             |
| (i) Bu dışa aktarma kurum politikası gereği filigranlanır:                    |
|     "Mert Kaya · 20.11.2026 14:32 · Atlas Teknoloji"                          |
| (i) Maksimum 10.000 satır. Dışa aktarma audit'lenir.                          |
| [☐] Politikayı okudum   [İptal]  [Dışa aktar]                                 |
| İlerleme ▓▓▓▓░░ %60 …  Hazır: rapor.xlsx [İndir] (24 saat geçerli)            |
```

**Token kullanımı**
- Rapor kartları `--bg-surface` + `--border`, `--radius-card`; tablolar `--bg-surface`, başlık `--bg-subtle`, sayılar `tabular-nums` sağa hizalı. Girdi/seçici sınırları **`--border-strong`**. Grafik serileri: füme, kırmızı, sıcak gri, açık kırmızı, koyu kırmızı sırası (10.5.3) ve koyu temada `--b2b` açık ton; seriler **çizgi stili + işaretçi şekliyle** ayırt edilir, 4'ten fazla seride doğrudan etiket; kırmızı seri B2C ile karışmasın diye segment rozeti ayrıca ikon + etiket taşır.
- Politika/filigran bildirimi `--info-soft` + `--info` ikon + metin (hata değil). Dışa aktarma hatası `--danger-soft` + `--danger` ikon + metin. İlerleme çubuğu `--primary` + yüzde metni; indir butonu ana (kural a).
- Başlıklar Space Grotesk 24/20; KPI 32.

**Görünürlük kuralları**
- Rapor kapsamı role bağlı: Satış Temsilcisi yalnızca **kişisel**, Yönetici **ekip + segment** (Mert Kaya: Ekip, B2B), Burak Aydın Ekip, B2B+B2C; Admin ve Analist (Selin Acar) **tümü**. Rapor listesi yalnızca erişilebilen ve modülü açık raporları gösterir: "Aramadan satışa" yalnızca "Çağrı merkezi ve santral" açıksa; "Segment karşılaştırma" yalnızca `both` modunda ve çift yetkide; `b2b_only` tenant'ta yalnızca B2B metrikleri.
- Alan seçicide yetkisiz/gizli alanlar (ör. maliyet) **listelenmez**; sayım ve toplamlar da yalnızca yetkili kayıtları kapsar.
- **Dışa aktarma:** yalnızca export yetkisi olanlarda (Admin, Analist: evet; Mert Kaya, Elif Demir: politikaya bağlı; Burak Aydın, Satış/Çağrı Temsilcisi: hayır) "Dışa aktar" düğmesi render edilir. Politika filigran, satır sınırı ve onay gerektirebilir; kullanıcıya **neden filigranlandığı** açıkça yazılır. Her dışa aktarma audit'lenir, indirme bağlantısı imzalı ve süreli.
- AI ile rapor oluşturma (ekran 21) bu ekranlardan açılır; kişi bazlı rapor yalnızca yetkili yöneticide.

**Klavye ve odak sırası**
- `/` rapor ara, `J/K` kart/satır, `Enter` aç, `E` dışa aktar, `Ctrl/Cmd+S` kaydet. Oluşturucuda alanlar `Space` ile seç, `Alt` kombinasyonu yok (çağrı kısayollarına ayrılmış). Odak sırası: sekmeler → filtreler → rapor kartları/oluşturucu alanı → önizleme → eylemler. Dışa aktarma sihirbazı focus trap, `Esc` iptal.

**Durumlar**
- Yükleniyor: kart ve tablo/grafik iskeleti; büyük raporlar için arka plan işi ("Hazırlanıyor, bildirim alacaksınız"). Boş: "Seçili dönemde veri yok" + filtre temizle. Hata: rapor üretilemedi + yeniden dene; export reddedildi (politika) nedeniyle `--danger` ikon + metin. Çevrimdışı: kayıtlı raporlar önbellekten salt okunur; dışa aktarma devre dışı.

**Hareket / a11y**
- Grafik çizim animasyonu 300 ms (reduced-motion'da yok). Grafikler `role="img"` + özet etiketi + **tablo alternatifi** düğmesi; tablolar `role="table"` ve başlık ilişkili. İlerleme `role="progressbar"` + `aria-valuenow`; tamamlanma `aria-live="polite"`.

**Yoğunluk / responsive**
- Kompakt tablo 32 px. Mobil: hazır rapor kartları dikey, önizleme tabloları yatay kaydırmalı; oluşturucu ve export sihirbazı masaüstü önerisi ile (salt okunur görüntüleme mobilde).

---

## 21. AI özet ve rapor asistanı

```text
=== Günün Özeti kartı (geniş bento) ==========================================
| ───────────────────────────────────────────────────────────── (--accent çizgi)|
| ✦ AI Günün Özeti   [✦ AI tarafından üretildi]   20 Kas 08:00  [⟳][▾ daralt]  |
| [3 gecikmiş görev][2 bekleyen teklif][7 açık fırsat][1,24 M TL ağırlıklı]    |  <- motordan
| Bugün Orion Lojistik teklifinin süresi doluyor [1]; Delta Gıda ile 14:00'te    |
| görüşme var [2]. Gecikmiş 3 görevden 2'si Orion'a bağlı. Bazı notlar kısaltıldı.|
| Kaynaklar (4) ▸   [Rapor oluştur]   👍 👎                                      |

=== Rapor oluşturucu (yan panel) ============================================
| RAPOR OLUŞTUR                          | CANLI ÖNİZLEME                        |
| Kullanıcı [Can Öz v] (yalnızca yetkili)| ✦ AI tarafından üretildi              |
| Dönem [Bu hafta v]                     | Can Öz haftalık özet ▌(akış sürüyor…)  |
| Kapsam ☑ Görevler ☑ Fırsatlar ☐ Çağrılar|  1) Satış: 3 fırsat ilerledi [1][2]  |
| Bölümler ☑ Özet ☑ Riskler ☐ Öneriler   |  2) Riskler: …▌                       |
| [Oluştur]                              | [■ İptal]                             |

=== Kaynaklar paneli ===
| Kaynaklar                                                                     |
|  [1] Orion Lojistik teklifi T-118 v3    [bina B2B]  ↗                         |
|  [2] Görev: Delta arama                  ↗                                     |
|  (yetkisiz kaynak HİÇ listelenmez)                                             |

=== Aksiyon önerisi şeridi ===
| ✦ Bu nottan 2 görev önerildi: "Fiyat onayı al", "Teklifi yeniden gönder"      |
|  [Düzenle ve onayla] [Yok say]   (onaylanmadan kayıt oluşmaz)                  |

=== "Benim hakkımda üretilen raporlar" şeffaflık ekranı ===
| Tarih        Üreten          Kapsam                    Dönem        Neden      |
| 18 Kas 10:12 Mert Kaya       Görevler, Fırsatlar        Son 7 gün    Haftalık 1:1|
| 12 Kas 16:40 Burak Aydın     Tümü                       Kasım        Performans |
| Not: Bu raporlar yalnızca yetkili yöneticiler tarafından, kurum politikasıyla üretilebilir. |

=== Admin AI yönetim ekranı ===
| Model: Yerel (Qwen-sınıfı) ✓ Çalışıyor · Sürüm 2025.10 · Gecikme 1,4 sn        |
| Lisans notu: Açık kaynak lisansı Apache-2.0; ticari kullanıma uygun.           |
| Kota: ▓▓▓▓▓▓░░ 8.2K / 10K istek (%82)   Kullanım grafiği [30 gün]              |
| Politika: [●] Kişi bazlı rapor  [○] Dış sağlayıcı   Sözlük: [Terimler…]         |
| [⛔ Kill switch: AI'yı kapat]   (anında; deterministik özetler çalışmaya devam)  |

=== Durumlar ===
| Yükleniyor:  ✦ AI Günün Özeti  ▒▒▒▒▒▒▒▒ (iskelet)  "Özet hazırlanıyor…"         |
| Fallback:    (i) AI anlatısı şu an kullanılamıyor. Sayılar hâlâ güncel:          |
|              [3 gecikmiş][2 bekleyen teklif]…  [Yeniden dene]                    |
| Kota dolu:   (!) AI kotası doldu. Yenileme: 01 Ara. Deterministik özet gösteriliyor.|
| Yetki yok:   (kart HİÇ render edilmez; Rapor oluştur düğmesi de yok)             |
```

**Token kullanımı**
- Özet kartı: `--bg-surface` + `--border` + `--shadow-card` (koyu: `--border`), `--radius-hero` 20 (geniş bento), **üst kenarda ince `--accent` çizgi**, kıvılcım simgesi `--spark` (dekoratif; metin altına/üstüne konmaz) + **"AI tarafından üretildi" metin etiketi ve ikon** (etiket `--text-secondary` 12; anlam rengine bağlı değil, kural e). Metrik çipleri (motordan gelen sayılar) `--bg-subtle` + `--border-strong` + `tabular-nums`; anlatı Inter 14/16 `--text-primary`. Kaynak çipleri numaralı `--accent-soft` + `--accent` metin (≥ 4.5:1).
- "Rapor oluştur" ana (kural a: koyu temada `--accent-btn`/`--on-accent`), "Kaynaklar" bağlantı `--accent`. Yan panel `--bg-surface` + ayırıcı `--border`; girdiler **`--border-strong`**. Streaming imleci `--text-secondary` blok (dekoratif).
- Fallback: `--info-soft` + `--info` bilgi ikonu + "AI anlatısı şu an kullanılamıyor" (hata değil, kırmızı değil). Kota dolu: `--warning-soft` + `--warning` ikon + metin. Gerçek hata (üretim başarısız): `--danger-soft` + `--danger` ikon + metin (kural c). Yetki yok durumunda nötr bilgi.
- Kill switch: `--danger` ikon + metin etiketli buton, onay diyaloğu; kota çubuğu `--primary` + yüzde metni. Şeffaflık tablosu `--bg-surface`, başlık `--bg-subtle`.

**Görünürlük kuralları**
- Modül adı arayüzde **"AI özet ve rapor asistanı"**dır; yalnızca tenant'ta açık ve kullanıcının yetkisi varsa görünür. Yetkisiz kullanıcıda kart/menü/palette satırı/ düğme **hiç render edilmez**.
- **Özet ve kaynaklar yalnızca kullanıcının zaten erişebildiği veriye dayanır**; yetkisiz kaynak çipi, sayı ve cümle üretilmez/gösterilmez. Metrikler deterministik motordan gelir (anlatı yalnızca anlatır); rakamlar modele hesaplatılmaz.
- **Kişi bazlı rapor oluşturucu:** kullanıcı seçicide yalnızca yöneticinin kapsamındaki kişiler (Mert Kaya yalnız B2B Kurumsal ekibi: Can Öz, Deniz Çelik). Kendi hakkında kişisel özet herkes için. Politika kapalıysa kullanıcı seçici yoktur.
- **"Benim hakkımda üretilen raporlar":** her kullanıcı yalnızca **kendi hakkında** üretilen raporların kim/ne zaman/hangi kapsam bilgisini görür; rapor içeriği bu ekranda gösterilmez; ekran sade ve açık dille yazılır. Admin AI yönetimi yalnızca **Admin** (Ayşe Yılmaz); kill switch yalnızca Admin, anında etkili ve audit'li.
- Aksiyon önerisi şeridi: öneri yalnızca kullanıcının oluşturma yetkisi olduğu kayıt türleri için; onaylanmadan **hiçbir kayıt oluşmaz**. Çağrı temsilcisi Kompakt modunda özet kartı daraltılabilir ve **çağrı sırasında bildirim göstermez**. "Asistana sor" palette'te (ekran 4) aynı kurallarla.
- B2B-only tenant'ta özet B2C içermez; segment süzme veri düzeyinde.

**Klavye ve odak sırası**
- Kart: `Tab` ile çipler → Kaynaklar → Rapor oluştur → geri bildirim; `K` kaynak panelini aç, `Enter` kaynağı aç, `Esc` kapat. Rapor paneli: alanlar → Oluştur → önizleme; `Esc` veya `Ctrl/Cmd+.` üretimi **iptal eder**. Palette'te "Asistana sor" önek `?`. Aksiyon şeridi `Enter` düzenle, `Esc` yok say.
- Tüm eylemler klavyeyle yapılır; kısayollar `?` yardımında "AI özet ve rapor asistanı" başlığı altında.

**Durumlar**
- **Yükleniyor:** iskelet + "Özet hazırlanıyor…" (`aria-busy`). **Model yok / hata → fallback:** "AI anlatısı şu an kullanılamıyor" mesajı + deterministik özet sayıları (kart yine değerlidir) + yeniden dene. **Kota doldu:** uyarı + sıfırlanma tarihi + deterministik özet. **Yetki yok:** kart render edilmez (boşluk yerine bento düzen yeniden akar). **Üretim hatası:** `--danger` ikon + metin, "Yeniden dene". **İptal edildi:** "Üretim iptal edildi" ve kısmi metin atılır. **Bazı notlar kısaltıldı** uyarısı bilgi ikonu ile. Çevrimdışı: son özet "Son güncelleme" etiketli, üretim devre dışı.

**Hareket / a11y**
- Streaming metni **`aria-live="polite"`** bölgesinde kademeli duyurulur (cümle/paragraf sınırında gruplanır, kelime kelime okunmaz); `aria-busy="true"` süresince, bitince "Rapor hazır" duyurusu. Kıvılcım yalnızca tek seferlik nabız (reduced-motion'da statik). "AI tarafından üretildi" etiketi ikon + metindir (yalnızca renge dayanmaz). Kaynak çipleri `aria-label="Kaynak 1: Orion Lojistik teklifi"`. İptal düğmesi her zaman odak sırasında ve `Esc`.

**Yoğunluk / responsive**
- Rahat'ta tam kart; **Kompakt'ta daraltılabilir** (başlık + metrik çipleri), Çağrı Temsilcisi varsayılanı daraltılmış. Mobil: Günün Özeti "Bugün" ekranının en üstünde tam genişlik kart; Rapor oluşturucu tam sayfa; kaynak paneli alt sayfa; şeffaflık ekranı kart listesi.

---

## 22. Boş, yükleniyor ve hata durumu örnekleri

```text
--- Boş durum (görev listesi) ---
|          (füme çizgi illüstrasyon: boş kutu, tek kırmızı nokta)   |
|          Henüz görev yok                                          |
|          İlk görevi oluşturup işinizi planlamaya başlayın.        |
|          [ C  Yeni görev ]                                        |

--- Yükleniyor (iskelet) ---
| ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒   ▒▒▒▒▒▒▒   ▒▒▒▒▒                            |
| ▒▒▒▒▒▒▒▒▒▒▒▒▒▒         ▒▒▒▒▒▒    ▒▒▒                              |

--- Hata (kart içi) ---
| (!) Veriler yüklenemedi                                           |
|     Bir sorun oluştu. Birkaç saniye sonra tekrar deneyin.         |
|     Hata kodu: RV-5031      [ Yeniden dene ]   [ Destekle paylaş ] |

--- Yetkisiz / bulunamadı (404) ---
|  Aradığınız sayfa bulunamadı                                      |
|  (Kayıt silinmiş olabilir veya erişiminiz olmayabilir.)           |
|  [ Bugün'e dön ]                                                  |

--- Çevrimdışı / bağlantı koptu ---
| ⚠ Bağlantı koptu. Yeniden bağlanılıyor… 2 değişiklik bekliyor.   |

--- Toast (geri alma) ---
| ✓ Görev silindi.   [ Geri al  Z ]                         (8 sn)  |
```

**Token kullanımı**
- Boş durum: `--bg-surface` kart, illüstrasyon çizgisi `--text-secondary`/`--primary` kontur, **en fazla bir** `--accent` detay (kıvılcım noktası); başlık Space Grotesk 20, metin 14 `--text-secondary`; tek ana buton (kural a).
- İskelet: `--bg-subtle` blok, hafif kayan parlama (yalnızca `--bg-surface` ile fark; renk anlam taşımaz).
- Hata: `--danger-soft` zemin + `--danger` ikon + metin + eylem (kural c); metin `--text-primary`. Çevrimdışı/bağlantı: `--warning-soft` + `--warning` ikon + metin. Bilgi (yetki, fallback): `--info-soft` + `--info` ikon + metin. Başarı toast: `--success-soft` + `--success` ikon + metin; toast `--bg-raised` yüzen + cam, `--radius-card` 16. Bileşen sınırları `--border-strong` (kural b).
- Hata kodu `tabular-nums`; 404'te segment/kayıt bilgisi içermez.

**Görünürlük kuralları**
- **404 mesajı yetkisiz ve var olmayan kaydı ayırt ettirmez** (aynı metin, aynı yanıt süresi sınıfı). "Erişiminiz olmayabilir" ifadesi genel kalır; hangi segmentte olduğu veya kaydın varlığı belirtilmez. Boş durum metinleri **yetkiye göre** değişir: aksiyon yetkisi yoksa aksiyon düğmesi hiç render edilmez (ör. Analist için "Yeni görev" yok, yalnızca açıklama).
- Modül kapalıysa o modülün boş/hata durumu hiçbir yerde görünmez (ör. `b2b_only` tenant'ta "B2C sipariş yok" boş durumu yoktur).
- Hata ayrıntıları (yığın izi, SQL, tenant kimliği) kullanıcıya gösterilmez; yalnızca korelasyon kodu ve "Destekle paylaş" bilgisi. Başka kullanıcıların verisini sızdıran hata metni yok.

**Klavye ve odak sırası**
- Boş durum: tek aksiyon odak sırasında doğal ilk eylemdir; `C` gibi kısayollar aynen çalışır. Hata: odak "Yeniden dene" düğmesine taşınır (kritik hatada); sayfa düzeyi hata `main` başında `h1`. Toast: odağı çalmaz; `Z` geri alma kısayolu 8 sn geçerli, `Alt+...` kullanılmaz. Çevrimdışı şerit odak sırasında ilk landmark'tır (`role="status"`).

**Durumlar** (bu ekranın kendisi durum kataloğudur)
- Yükleniyor eşikleri: <150 ms hiçbir şey, 150-400 ms iskelet, >400 ms iskelet + "Biraz uzun sürüyor…" ipucu, >10 sn "Yeniden dene". Boş türleri: ilk kullanım (aksiyon odaklı), filtre sonucu yok (filtreyi temizle), yetki sonucu boş (açıklama), kota/modül kapalı (bilgi). Hata türleri: ağ, sunucu (5xx, korelasyon kodu), doğrulama (alan altında), çakışma (409), yetki (403/404), kota/limit (429). Çevrimdışı: kalıcı şerit + değişiklik kuyruğu + senkronizasyon sonucu bildirimi.

**Hareket / a11y**
- İskelet kayan parlama ve boş durum kıvılcımı `prefers-reduced-motion` altında statik; toast belirme 160 ms (reduced-motion'da anında). Hata `role="alert"` (kritik) ya da `role="status"` (bilgilendirici); iskelet kapsayıcı `aria-busy="true"` + gizli "Yükleniyor" metni; toast `aria-live="polite"` ve eylem düğmesi klavyeyle ulaşılabilir. Renk tek başına durum bildirmez: her durumda ikon + metin.

**Yoğunluk / responsive**
- Kompakt'ta boş durum illüstrasyonu küçülür (80 px), metin tek satır. Mobilde boş/hata kartları tam genişlik, birincil eylem alt sabit düğme; toast alt gezinmenin üstünde konumlanır.

---

## Ek A. Tasarım spesifikasyonunda fark edilen tutarsızlıklar ve boşluklar

1. **Koyu tema ana buton (10.5.2) ile kontrast (12.4):** 10.5.2 tablosu koyu temada ana butona `--accent` zemin + `--on-accent` metin der; bu çift 2.71:1'dir. Karar (bu dokümanda uygulandı): `--accent-btn` + `--on-accent`. 10.5.2 tablosu güncellenmelidir.
2. **`--border-strong` tokenı tanımlı değil:** 12.4/12.5'te yalnızca `--border` var; kontrast hedefi (metin dışı ≥ 3:1) bunun üstünde bir token gerektiriyor. Bölüm 12.4/12.5'e açık ve koyu tema için `--border-strong` eklenmeli.
3. **Eksik açık tema tokenları:** `--bg-raised` ve `--accent-btn` yalnızca koyu temada tanımlı; açık temadaki yüzen katmanlar (palette, softphone) için `--bg-raised` açık karşılığı, `--accent-btn` açık karşılığı (= `--primary` ile aynı kalıyor mu?) belirtilmeli. Koyu temada `--accent-hover`, `--accent-soft` ve `--*-soft` tokenları da tanımsız.
4. **`--on-accent` iki farklı değer:** açık temada beyaz, koyu temada kırık beyaz; ilgili çiftler (`--accent`/`--on-accent`) açık temada tutarlı ama koyu temada `--accent` ile `--on-accent` birlikte kullanılamıyor; bu isim karışıklığı yaratıyor (`--accent-btn` ile eşleşme açıkça yazılmalı).
5. **B2C ile marka kırmızısı çakışması (12.4):** `--b2c` ile `--accent` aynı renk; B2C seçili öğe ve "aktif" vurgu görsel olarak ayrışmıyor. Segment rozetleri ikon + etiketle korunuyor, ancak liste/Kanban kartlarında B2C ve seçili durum karışabilir.
6. **Grafik paleti hex ve sabit renk yasağı:** 10.5.3 grafik serilerini hex ile veriyor, 12.5 yeni renk için token şartı koyuyor ve bileşenlerde sabit renk yasak (lint). Grafik serileri için ayrı `--chart-1…5` tokenları tanımlanmalı.
7. **Platform Operatörü konsolu modül ailesinde (12.3) yok:** 10.5.5'te ekran olarak var, 12.3'te arayüz adı yok; alt marka kilidi ve menü adı belirlenmeli.
8. **Rol rozetleri (10.5.3) ve Satış/Çağrı Temsilcisi renkleri:** Satış Temsilcisi `--b2b-soft`, Çağrı Temsilcisi `--b2c-soft`; oysa Deniz Çelik (B2B+B2C) ve Okan Tekin (B2B+B2C) gibi çok segmentli kullanıcılarda rozet segmenti ima ediyor gibi okunabilir; rol rozeti ile segment rozeti ayrı biçimde (ikon farkı) tasarlanmalı.
9. **Kıvılcım (`--spark`) kullanımı ve canlı durum:** 12.4 "metin değil" der ama 10.5.3 "Görüşmede = `--accent` (nabız animasyonlu kıvılcım)" der; bu dokümanda durum her zaman ikon + metinle verilip `--spark` yalnızca dekoratif tutuldu.
10. **Dark primary ve `--primary`:** koyu temada `--primary` kırık beyazdır; "Ana buton koyu temada `--accent-btn`" kuralı ile `--primary` tanımı arasındaki ilişki (koyu temada `--primary` buton zemini olarak kullanılmayacak) 12.5'te yorum olarak yazılmalı.
11. **Çağrı kısayolları:** spesifikasyon yalnızca "klavye odaklı akış" der, somut tuş tanımı yok; bu dokümandaki `Alt+` kombinasyonları (Alt+D/F/H tarayıcı çakışması nedeniyle kullanılmadı) onaylanmalı. macOS'ta Option tuşu özel karakter ürettiği için `event.code` ile eşleme gerekir.
12. **Takvim/Gantt/Tablo görünümleri Faz 6'da var ama mobil kırılım ve erişilebilir alternatif tanımsız:** Gantt için tablo alternatifi önerildi, onay gerekli.
