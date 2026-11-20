# İlerleme

## P0 — Faz 0 + G0: Mimari ve gereksinim analizi · 2026-11-20 · ✅ tamamlandı (onay bekliyor)

### Yapılanlar
- Kaynak promptun tamamı (Bölüm 1–12) analiz edildi; 27 tespit (6 kritik) ve düzeltmeleri: `docs/requirements-review.md`.
- 22 ADR (`docs/adr/`), mimari doküman, bütünleşik faz planı.
- ER diyagramı: 11 alan diyagramı, 148 tablo (`docs/er-diagram.md`) — 13/13 Mermaid bloğu ayrıştırıcıdan geçti.
- API taslağı, olay kataloğu (80+ olay tipi), risk kaydı (25 risk), varsayımlar (43) + tek toplu soru (Q1–Q5).
- Makine okunur yetki matrisi `docs/enterprise/permission-matrix.yaml` (Matris A 36 satır, AI 16 satır, 10 demo kullanıcı, 34 karar senaryosu) — kaynak tablolarla **hücre hücre** doğrulandı.
- Modül manifest şeması + 13 modüllük katalog — şema, §10.3.1 bağımlılık tablosu ve döngü kontrolü geçti.
- `packages/ui/tokens.json` (tam tema paritesi) + kontrast raporu: 79/79 kontrol geçti.
- Alt ajanlarla (Sonnet) üretilen ve gözden geçirilen: izlenebilirlik tablosu (246 gereksinim, 122 kabul kriteri, 474 test ID), 115 kullanıcı hikâyesi, 22 ekran wireframe'i.

### Kabul kriterleri
| Kriter | Durum | Kanıt |
|---|---|---|
| F0: ER diyagramı tüm referans gereksinimleri kapsıyor | ✅ | `er-diagram.md` 11 alan; izlenebilirlikte DM-* satırları |
| F0: Her kritik karar bir ADR'ye bağlı | ✅ | `adr/README.md`; `requirements-review.md` her maddede ADR |
| F0: Klasör yapısı ve modül sınırları net | ✅ | `architecture.md` §3 |
| F0: Riskler için azaltma planı mevcut | ✅ | `risks.md` |
| G0: Her gereksinim bir faza ve en az bir teste bağlı | ✅ | `enterprise/requirements-traceability.md` (eksik ID yok, grep ile doğrulandı) |
| G0: Yetki matrisi YAML'ı 10.4 tablolarıyla birebir tutarlı | ✅ | `node scripts/check-permission-matrix.mjs` → PASS; negatif test hücre bozulmasını yakaladı |
| G0: Yönetici sınırları ve tenant çözümü kuralları istisnasız yazılı | ✅ | ADR-0004 §7, ADR-0003 §4, ADR-0015 §4 |
| G0: Palet kontrast raporu tüm metin çiftlerinde ≥ 4.5:1 | ✅ | `contrast-report.md` (düzeltmelerle; Q4 onayı bekleniyor) |

### Bilinen sınırlar
- Kaynak §4 DoD'deki "docker compose up / CI yeşil" maddeleri P0 için uygulanamaz (kod yok); doğrulama betikleri şimdilik `yaml`/`ajv` paketlerini kök `package.json` olmadan çalıştırıyor — P1'de devDependency olarak eklenip CI adımı yapılacak.
- Depoda uzak sunucu (remote) yok → CI kurulamadı (Q3).
- Runvara adı için marka/alan adı araştırması yapılmadı (R-21).

### Sonraki adım
Q1–Q5 yanıtlandıktan sonra **P1** (Faz 1 + G1 çekirdeği): monorepo, Docker Compose, CI, kimlik doğrulama, RLS + DB rolleri, modül kayıt defteri/kapısı, tenant sızıntı testleri.
