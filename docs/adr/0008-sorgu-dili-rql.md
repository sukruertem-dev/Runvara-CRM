# ADR-0008: Sorgu dili (RQL) ve güvenli SQL derleme

- Durum: Önerildi · Tarih: 2026-11-20 · Kapsam: Faz 2 (çekirdek), Faz 3/4/7, G8, G12 · Gereksinimler: API-03, AIQ-01

## Bağlam
JQL benzeri bir dil (`status = open AND owner = me AND due < +7d`) istenir; SQL injection'a kapalı, FLS'e uyumlu, AI akıllı sorgusunun tek veri okuma aracı olacak.

## Karar

### Dilbilgisi (EBNF özeti)
```text
query      := orExpr ( "ORDER BY" order ("," order)* )?
orExpr     := andExpr ( "OR" andExpr )*
andExpr    := notExpr ( "AND" notExpr )*
notExpr    := "NOT" notExpr | primary
primary    := "(" orExpr ")" | comparison
comparison := field op value | field "IN" "(" value ("," value)* ")" | field "IS" "NOT"? "EMPTY"
            | field "~" string                       -- metin içerir (ILIKE, kaçışlı)
op         := "=" | "!=" | "<" | "<=" | ">" | ">="
field      := ident ("." ident)*                     -- related.account.name, custom.cf_budget
value      := string | number | bool | date | relDate | function
relDate    := ("+"|"-") int ("m"|"h"|"d"|"w"|"M")    -- +7d, -2w
function   := "me()" | "myTeams()" | "myQueues()" | "today()" | "startOfWeek()" | "startOfMonth()" | "now()"
order      := field ("ASC"|"DESC")?
```
- Türkçe anahtar kelime eşanlamlıları arayüzde (`VE`, `VEYA`, `DEĞİL`) → aynı token'lar.

### Derleme hattı
`lexer → parser (Pratt) → AST → semantik denetim → SQL derleyici (Drizzle sql parçaları)`
1. **Alan kaydı:** her kaynak tipi için alan → (SQL ifadesi, tip, izinli operatörler, sıralanabilir mi) haritası; custom field tanımları dinamik eklenir (`custom->>'key'` + tip dönüşümü). Kayıtta olmayan alan → `UNKNOWN_FIELD`.
2. **FLS:** kullanıcının `fieldMask(read)` dışındaki alanlar kayıttan **çıkarılmış** halde denetime girer → gizli alan da `UNKNOWN_FIELD` (bilgi sızdırmaz).
3. **Değerler daima parametre** (`$n`); alan adları ve operatörler yalnızca beyaz listeden **sabit SQL parçalarıdır**; kullanıcı metni hiçbir zaman SQL'e string olarak eklenmez. `~` için `ILIKE` deseninde `%`, `_`, `\` kaçışlanır.
4. **Göreli tarihler** kullanıcının saat diliminde hesaplanıp UTC parametre olarak geçer.
5. **Sınırlar:** en fazla 50 karşılaştırma, iç içe derinlik 10, IN listesi 500 değer, sorgu metni 4 KB; ilişki derinliği 2 (`related.account.name`). İlişki alanları `EXISTS` alt sorgusuna derlenir ve **ilişkili tablonun yetki predicate'ini** de içerir.
6. Çıktı: `WHERE <rql> AND <authz predicate>`; `ORDER BY` sonunda kararlı sıralama için `id` eklenir (cursor sayfalama).

### Test stratejisi
- Birim: her üretim kuralı + hata mesajları (konum bilgisiyle).
- **Property/fuzz (fast-check):** rastgele AST ve rastgele bayt dizileri → (a) derleyici ya geçerli parametreli SQL ya `RqlError` üretir, asla istisna sızdırmaz; (b) üretilen SQL metni hiçbir kullanıcı değeri içermez (parametre dizisi dışında); (c) Testcontainers PG'de `EXPLAIN` hatasız.
- Injection korpusu: klasik yükler (`' OR 1=1 --`, `; DROP`, Unicode benzerleri, NUL baytı) değer ve alan konumlarında.

## Alternatifler
| Alternatif | Neden seçilmedi |
|---|---|
| Parser üreteci (Chevrotain/peggy) | Mümkün; el yazımı Pratt ayrıştırıcı hata mesajı kalitesi ve bağımlılıksızlık için tercih edildi |
| OData/GraphQL filtre nesneleri | Kullanıcıya yazılabilir metin dili gerekiyor; ayrıca JSON filtre biçimi AST'ye doğrudan eşlenir (API iki biçimi de kabul eder) |

## Sonuçlar
- (+) AI asistanı (G12) serbest SQL yerine yalnızca RQL üretir; aynı güvenlik garantileri.
- (−) Custom field ifade indeksleri yalnızca "indeksli" işaretli alanlarda; diğerleri GIN `jsonb_path_ops` ile `@>` eşitliğine düşer.
