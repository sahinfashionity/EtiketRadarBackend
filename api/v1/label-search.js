import {
  setCors,
  readJson,
  requireAuth,
  jsonError,
  cleanQuery,
  tavilySearch,
  uniqByUrl,
  resultToSource,
  resultToOffer,
  sortOffers,
  geminiJson
} from "./_utils.js";

const SHOP_DOMAINS = [
  "hepsiburada.com",
  "trendyol.com",
  "amazon.com.tr",
  "n11.com",
  "teknosa.com",
  "mediamarkt.com.tr",
  "vatanbilgisayar.com",
  "migros.com.tr",
  "carrefoursa.com",
  "a101.com.tr",
  "bim.com.tr",
  "sokmarket.com.tr"
];

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return jsonError(res, 405, "Sadece POST desteklenir.");
  if (!requireAuth(req, res)) return;

  try {
    const body = await readJson(req);
    const query = cleanQuery(body.query || body.ocrText);
    const ocrText = cleanQuery(body.ocrText || "");
    if (!query) return jsonError(res, 400, "Ürün adı boş olamaz.");

    const searchQuery = `${query} fiyat satın al Türkiye karşılaştırma`;
    const search = await tavilySearch(searchQuery, { includeDomains: SHOP_DOMAINS, maxResults: 12 });
    const results = uniqByUrl(search.results || []);
    const rawOffers = sortOffers(results.map(resultToOffer)).slice(0, 10);

    const geminiPrompt = `
Sen Türkiye'deki mağaza/market/elektronik ürünleri için fiyat karşılaştırma asistanısın.
Tavily sonuçlarından marka, model, ürün açıklaması ve satıcı fiyatlarını çıkar.
Sadece kaynaklarda görünen linkleri kullan; Google/Bing arama linki döndürme.

Kullanıcı sorgusu: ${query}
OCR metni: ${ocrText}

Tavily sonuçları:
${JSON.stringify(results.map(r => ({ title: r.title, url: r.url, content: r.content })), null, 2)}

Aşağıdaki JSON şemasına uygun cevap ver:
{
  "query": "string",
  "product": { "brand": "string", "model": "string", "productName": "string", "description": "string", "barcode": "string", "detectedPrice": "string" },
  "offers": [ { "siteName": "string", "title": "string", "priceText": "string", "url": "string", "note": "string" } ],
  "suggestions": ["kısa alışveriş tavsiyesi"],
  "sources": [ { "title": "string", "url": "string", "sourceType": "shop|web" } ]
}`;

    let ai = null;
    try { ai = await geminiJson(geminiPrompt); } catch (e) { console.error("Gemini label summary failed:", e.message); }

    const fallback = {
      query,
      product: { brand: "", model: "", productName: query, description: "", barcode: "", detectedPrice: "" },
      offers: rawOffers,
      suggestions: [
        "En düşük fiyatı seçmeden önce satıcı puanı ve kargo ücretini kontrol edin.",
        "Aynı model ve renk olduğundan emin olun.",
        "Mağaza fiyatı ile internet fiyatı arasındaki farkı garanti ve teslimat şartlarıyla birlikte değerlendirin."
      ],
      sources: uniqByUrl(results.map(r => resultToSource(r, "shop"))).slice(0, 10)
    };

    const response = normalizeLabelResponse(ai || fallback, fallback);
    res.status(200).json(response);
  } catch (error) {
    console.error(error);
    return jsonError(res, 500, error.message || "Etiket/ürün araması başarısız oldu.");
  }
}

function normalizeLabelResponse(ai, fallback) {
  const offers = Array.isArray(ai.offers) && ai.offers.length ? ai.offers : fallback.offers;
  const sources = Array.isArray(ai.sources) && ai.sources.length ? ai.sources : fallback.sources;
  return {
    query: String(ai.query || fallback.query),
    product: {
      brand: String(ai.product?.brand || ""),
      model: String(ai.product?.model || ""),
      productName: String(ai.product?.productName || fallback.product.productName || ""),
      description: String(ai.product?.description || ""),
      barcode: String(ai.product?.barcode || ""),
      detectedPrice: String(ai.product?.detectedPrice || "")
    },
    offers: sortOffers(offers
      .filter(o => o && o.url && !/google\.|bing\.|duckduckgo\.|yandex\./i.test(o.url))
      .map(o => ({
        siteName: String(o.siteName || safeHost(o.url) || "Web sitesi"),
        title: String(o.title || o.siteName || "Sonuç"),
        priceText: String(o.priceText || ""),
        url: String(o.url),
        note: String(o.note || "")
      }))).slice(0, 10),
    suggestions: arrayOfText(ai.suggestions, fallback.suggestions),
    sources: sources
      .filter(s => s && s.url)
      .map(s => ({ title: String(s.title || safeHost(s.url) || "Kaynak"), url: String(s.url), sourceType: String(s.sourceType || "web") }))
      .slice(0, 10)
  };
}

function arrayOfText(value, fallback) {
  const arr = Array.isArray(value) ? value.map(String).filter(Boolean) : [];
  return arr.length ? arr.slice(0, 8) : fallback;
}

function safeHost(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}
