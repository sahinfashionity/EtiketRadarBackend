import { setCors, readJson, requireAuth, callOpenAI, outputTextFromOpenAI, parseJsonFromText, normalizeDecimal, normalizeUrl, jsonError } from "./_utils.js";

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Sadece POST desteklenir." });
  if (!requireAuth(req, res)) return;

  try {
    const product = await readJson(req);

    if (!process.env.OPENAI_API_KEY) {
      return jsonError(res, 500, "OPENAI_API_KEY Vercel Environment Variables içinde yok. Bu yüzden gerçek fiyat araması yapılamıyor.");
    }

    const query = product.query || [product.brand, product.model, product.productName, product.color, product.size, product.barcode]
      .filter(Boolean)
      .join(" ")
      .trim();

    if (!query) {
      return jsonError(res, 400, "Ürün adı/model/barkod okunamadı. Daha net fotoğrafla tekrar deneyin.");
    }

    const prompt = `Türkiye webinde güncel fiyat/satıcı araması yap ve sadece doğrudan sayfa linkleri döndür.

Ürün bilgisi:
${JSON.stringify(product, null, 2)}

Arama sorgusu: ${query}

Kurallar:
- Google arama linki, reklam linki, yönlendirme linki veya boş link döndürme.
- productURL mutlaka doğrudan ürün, mağaza ürünü, eczane/ilaç bilgi sayfası ya da fiyat sayfası olsun.
- Aynı ürün olduğundan emin değilsen confidence düşük ver veya hiç ekleme.
- Türkiye fiyatı ara. Fiyat TL olmalı.
- Fiyat bulunamazsa offers boş array olsun; demo/uydurma sonuç üretme.
- Sadece geçerli JSON döndür.

JSON şeması:
{"offers":[{"storeName":"","title":"","price":0,"currencyCode":"TRY","productURL":"https://...","imageURL":null,"confidence":0.0,"shippingSummary":"","updatedAt":"ISO-8601"}]}`;

    const ai = await callOpenAI({
      model: process.env.OPENAI_MODEL || "gpt-5.5",
      tools: [{ type: "web_search" }],
      tool_choice: "required",
      input: prompt,
      text: { format: { type: "json_object" } }
    });

    const parsed = parseJsonFromText(outputTextFromOpenAI(ai));
    const rawOffers = Array.isArray(parsed.offers) ? parsed.offers : [];

    const cleaned = rawOffers
      .map(o => {
        const productURL = normalizeUrl(o?.productURL);
        const price = normalizeDecimal(o?.price);
        return {
          storeName: String(o?.storeName || "").trim(),
          title: String(o?.title || "").trim(),
          price,
          currencyCode: o?.currencyCode || "TRY",
          productURL,
          imageURL: normalizeUrl(o?.imageURL) || null,
          confidence: Number(o?.confidence ?? 0.7),
          shippingSummary: String(o?.shippingSummary || "Canlı sonuç").trim(),
          updatedAt: o?.updatedAt || new Date().toISOString()
        };
      })
      .filter(o => o.storeName && o.title && o.price && o.price > 0 && o.productURL)
      .sort((a, b) => a.price - b.price)
      .slice(0, 8);

    if (!cleaned.length) {
      return jsonError(res, 404, "Gerçek ürün linki bulunamadı. Ürün adını/barkodu uygulamada elle düzeltip tekrar arayın.", { offers: [] });
    }

    res.status(200).json({ offers: cleaned });
  } catch (error) {
    return jsonError(res, 500, error.message || "Fiyat arama sırasında hata oluştu.");
  }
}
