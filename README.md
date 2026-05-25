# EtiketRadar Backend

Bu backend, iOS uygulamasındaki iki alanı karşılar:

- `POST /v1/extract-label`
- `POST /v1/product-search`

## iPhone uygulamasına yazılacak değerler

Vercel deploy sonrası örnek domain şu şekilde olur:

```text
https://etiket-radar-backend.vercel.app/
```

Uygulamada:

```text
Demo modu: Kapalı
AI ile alanları doğrula: Açık
Fiyat arama URL: https://etiket-radar-backend.vercel.app/
AI okuma URL: https://etiket-radar-backend.vercel.app/
API anahtarı: APP_API_KEY değeriniz
```

Önemli: URL sonuna `/v1/product-search` veya `/v1/extract-label` eklemeyin. iOS uygulaması bu endpoint yollarını otomatik ekliyor.

## Vercel'e kurulum

1. Bu klasörü GitHub'a yeni repo olarak yükleyin.
2. Vercel hesabı açın ve GitHub repo'yu Import edin.
3. Environment Variables bölümüne şunları ekleyin:

```text
APP_API_KEY=etiket-radar-123456
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-5.5
```

4. Deploy edin.
5. Deploy domainini iPhone uygulamasında hem Fiyat arama URL hem AI okuma URL alanına yazın.

## Güvenlik

OpenAI API anahtarını iPhone uygulamasına yazmayın. `OPENAI_API_KEY` sadece backend ortam değişkeninde kalmalıdır. Uygulamadaki `API anahtarı`, backendin kendi basit koruma anahtarıdır: `APP_API_KEY`.

## Test

Deploy sonrası şu komutla test edebilirsiniz:

```bash
curl -X POST "https://DOMAININIZ.vercel.app/v1/product-search" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer etiket-radar-123456" \
  -d '{"query":"Huawei FreeBuds 6i siyah","brand":"Huawei","model":"FreeBuds 6i","productName":"Bluetooth kulaklık","currencyCode":"TRY"}'
```

