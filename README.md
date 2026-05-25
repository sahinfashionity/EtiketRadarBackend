# EtiketRadar Backend - Tavily + Gemini

Bu backend OpenAI kullanmaz.

- Web araması: Tavily API
- Ucuz özetleme/JSON düzenleme: Gemini Flash-Lite
- OCR: iPhone uygulamasında Apple Vision ile cihaz üzerinde yapılır

## Endpointler

```text
GET  /
GET  /v1/debug
POST /v1/medicine-search
POST /v1/label-search
```

## Vercel Environment Variables

Vercel > Project > Settings > Environment Variables bölümüne ekle:

```text
APP_API_KEY=etiket-radar-123456
TAVILY_API_KEY=tvly-...
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-2.5-flash-lite
```

`GEMINI_API_KEY` boş bırakılırsa backend yine Tavily sonuçlarını döndürür; fakat kullanım talimatı / yan etki özetleri daha zayıf olur.

## iPhone uygulamasındaki ayarlar

```text
Backend URL:
https://etiket-radar-backend.vercel.app/

API anahtarı:
etiket-radar-123456
```

## Test

```bash
curl -X POST "https://DOMAIN.vercel.app/v1/medicine-search" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer etiket-radar-123456" \
  -d '{"query":"Majezik 100 mg"}'
```

```bash
curl -X POST "https://DOMAIN.vercel.app/v1/label-search" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer etiket-radar-123456" \
  -d '{"query":"Sony WH-CH720N siyah"}'
```

## Not

İlaç bilgileri doktor/eczacı tavsiyesi değildir. Uygulama içinde bu uyarı gösterilir.
