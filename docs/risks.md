# Risk Kaydı

> Faz 0 + G0 · 2026-11-20 · Olasılık (O) ve Etki (E): 1 düşük – 3 yüksek; Skor = O × E. Her faz sonunda gözden geçirilir.

| ID | Risk | O | E | Skor | Azaltma | Sahip faz | Erken uyarı göstergesi |
|---|---|---|---|---|---|---|---|
| R-01 | **Tenant sızıntısı** (unutulmuş filtre, bağlamsız sorgu, önbellek/kuyruk anahtarı) | 2 | 3 | 6 | FORCE RLS + RESTRICTIVE politika, bağlamsız sorgu = 0 satır, `withTenant` dışı DB erişimi lint ile yasak, tenant'sız tablo CI denetimi, her fazda çok yüzeyli sızıntı paketi | F1, G1, G10 | Sızıntı testi kırmızı; `check-tenant-columns` uyarısı |
| R-02 | **Segment/kapsam sızıntısı** (sayım, arama önerisi, rapor toplamı, ekran açma, bildirim) | 2 | 3 | 6 | Tek `predicate()` giriş noktası, segment RLS, matris tabanlı üretilmiş testler, sabit yanıt süresi (ekran açma/lookup) | F4/G2, G10 | Matris testinde fark |
| R-03 | Yetki predicate'lerinin sorgu performansını bozması (p95 > 200 ms) | 2 | 2 | 4 | `tenant_id` öncelikli bileşik indeksler, predicate şablonlarının `EXPLAIN` regresyon testi, kapsam alt sorguları için `record_queue_links` / ekip üye dizisi parametresi | F2, F4, F8 | k6 p95 trendi |
| R-04 | Kurumsal ayrı şema/DB talebi erken gelir | 1 | 2 | 2 | `tenant_placements` + `getPool(tenant)` arayüzü G1'de hazır | G1 | Satış talebi |
| R-05 | **Telefoni olay kaybı / tekrarı / sırasızlığı** | 3 | 3 | 9 | `provider_event_id` benzersizliği, zaman damgası tabanlı durum birleştirme, mutabakat işi (CDR), DLQ, simülatörle kaos testleri | G7, G10 | Mutabakat fark sayısı, `stale` çağrı oranı |
| R-06 | Sahte tenant kimliği taşıyan telefoni olayı | 2 | 3 | 6 | Tenant yalnızca DID/hat eşlemesinden; gövde alanı yok sayılır ve güvenlik olayı loglanır; webhook imza + IP listesi | G7 | `telephony_tenant_mismatch` metriği |
| R-07 | Sağlayıcıya bağımlılık / sağlayıcı yeteneklerinin varsayıldığından farklı olması (Netgsm, Verimor, 3CX…) | 3 | 2 | 6 | `TelephonyProvider` + yetenek bildirimi; ilk iki adaptör açık standartlara (ARI, genel webhook); yerel sağlayıcılar entegrasyon aşamasında doğrulanır | G7 | Adaptör sözleşme testleri |
| R-08 | **Bildirim gecikmesi** p95 > 2 sn (fan-out, yetki süzgeci maliyeti) | 2 | 2 | 4 | Yetki süzgecini yalnızca alıcı kümesinde çalıştırma, Redis pub/sub, minimal yük; OTel gecikme histogramı ve SLO alarmı | G6 | Histogram p95 |
| R-09 | SSE bağlantı sayısı / proxy zaman aşımları | 2 | 2 | 4 | Kalp atışı, sekme başına tek akış, bağlantı kotası, HTTP/2 | F5, G6 | Yeniden bağlanma oranı |
| R-10 | **KVKK / arama izni (İYS benzeri) uyumsuzluğu** | 2 | 3 | 6 | Rıza tablosu kaynak + zaman damgası, giden aramada zorunlu kontrol, entegrasyon noktası (`consents.external_ref`), hukuk danışmanı kontrol listesi (G10) | G5, G7, G10 | Engellenen arama oranı, denetim bulgusu |
| R-11 | **Çağrı kaydı dinleme / canlı izleme hukuku** (bilgilendirme, anons, saklama süresi) | 2 | 3 | 6 | Varsayılan kapalı, politika + bildirim/anons zorunlu, erişim audit'i, saklama süresi işi; hukuk danışmanı gözden geçirmesi | G7, G10 | Politika açma talepleri |
| R-12 | Outbox relay veya Redis kaybında olay işleme kesintisi | 2 | 2 | 4 | Yayınlanmamış satırlar DB'de kalır; AOF; `processed_events` mutabakat aracı; kaos testi | F5 | `outbox_unpublished` yaşı |
| R-13 | Otomasyon döngüleri / fırtınaları | 2 | 2 | 4 | Derinlik limiti, aynı kural tekrar engeli, tenant başına aksiyon hız sınırı, kural kuru çalıştırma | F5 | `halted_loop` sayısı |
| R-14 | RRULE + DST hataları (yanlış tarihte örnek) | 2 | 2 | 4 | Yerel duvar saatinde üretim, tablo tabanlı DST testleri (Berlin, New York) | F2 | Test kapsamı |
| R-15 | RQL injection veya FLS sızıntısı (filtreyle değer çıkarımı) | 1 | 3 | 3 | Parametreli derleme, beyaz liste, gizli alan = bilinmeyen alan, property/fuzz testleri | F2, F4 | Fuzz bulgusu |
| R-16 | Webhook / BYO AI uç noktası üzerinden SSRF | 2 | 3 | 6 | Tek giden HTTP istemcisi, DNS sonrası IP kontrolü, yönlendirme kapalı | F5, G11 | Reddedilen hedef logu |
| R-17 | Zengin metin XSS (yorum, not, açıklama) | 2 | 3 | 6 | ProseMirror şema doğrulaması, sunucu tarafı temizleme, CSP (nonce, `script-src 'self'`), dosyalar `attachment` olarak | F4, F6 | CSP ihlal raporları |
| R-18 | Gürültülü komşu (tek tenant kuyruğu/DB'yi doyurur) | 2 | 2 | 4 | Shard + tenant semaforu, token bucket, `statement_timeout`, rapor read-replica | G1 | Kuyruk gecikmesi tenant dağılımı |
| R-19 | AI: prompt injection, sayı uydurma, tenant/yetki sızıntısı | 2 | 3 | 6 | Deterministik veri + yer tutucu metrikler, doğrulayıcı, `<data>` bloğu, salt okuma araçları, red-team ve eval CI kapısı | G11–G13 | Eval skorları |
| R-20 | AI: model lisansı ticari kullanıma uygun değil / Türkçe kalitesi yetersiz | 2 | 2 | 4 | G11'de lisans + Türkçe eval ile seçim, gateway ile model değişimi üst katmanı etkilemez | G11 | Eval eşiği |
| R-21 | **Marka adı (Runvara) tescil/alan adı çakışması** | 2 | 2 | 4 | TÜRKPATENT/EUIPO/WIPO (sınıf 9, 35, 38, 42), alan adı ve npm/GitHub ad kontrolü **kod yayımlanmadan önce**; paket öneki tek yerde (`@runvara`) değiştirilebilir | F1 öncesi | Araştırma sonucu |
| R-22 | Kapsam genişliği (13 modül, 22 faz) → teslim gecikmesi | 3 | 2 | 6 | Bütünleşik faz planı (`phase-plan.md`), her fazın kabul kriterleri, modül kapısıyla kademeli açılış | Tümü | Faz süre sapması |
| R-23 | Teklif/sipariş tutarlarında yuvarlama farkı (PDF ≠ API ≠ rapor) | 2 | 2 | 4 | Tek fiyatlama fonksiyonu, decimal aritmetik, belgelenmiş yuvarlama | G4 | Mutabakat testi |
| R-24 | CI'ın çalışmaması: depo için uzak sunucu (GitHub) yok | 3 | 1 | 3 | Q3 ile kullanıcıya soruldu; yerelde `pnpm ci:local` ile aynı adımlar | F1 | — |
| R-25 | Yerel geliştirme makinesi (Windows + OneDrive klasörü) dosya izleme/symlink sorunları (pnpm, Docker bind mount) | 1 | 1 | 1 | Depo yerel diske taşındı (OneDrive senkronu yok); pnpm `node-linker=hoisted` gerekirse; Docker'da adlandırılmış volume. C: diskinde yalnızca ~18 GB boş alan: Docker imajları ve node_modules için yer açılmalı | F1 | Kurulum hataları, disk doluluğu |
