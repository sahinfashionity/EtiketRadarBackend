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
  sortOffersByPriority,
  enrichOfferFromPage,
  priceFromText,
  getHost,
  geminiJson
} from "./_utils.js";

const SHOP_DOMAINS = [
  "trendyol.com",
  "hepsiburada.com",
  "amazon.com.tr",
  "migros.com.tr",
  "carrefoursa.com",
  "a101.com.tr",
  "bim.com.tr",
  "toyzzshop.com",
  "teknosa.com",
  "mediamarkt.com.tr"
];

const COMPARISON_DOMAINS = [
  "cimri.com",
  "kiyas.la",
  "epey.com"
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

    const primarySearches = [
      tavilySearch(`${query} fiyat satın al Türkiye`, {
        includeDomains: SHOP_DOMAINS,
        maxResults: 20,
        includeImages: true,
        includeRawContent: "markdown"
      }),
      ...SHOP_DOMAINS.map(domain =>
        tavilySearch(`${query} fiyat site:${domain}`, {
          includeDomains: [domain],
          maxResults: 3,
          includeImages: true,
          includeRawContent: "markdown",
          timeoutMs: 18000
        })
      )
    ];

    const comparisonSearches = [
      tavilySearch(`${query} teknik özellik karşılaştırma`, {
        includeDomains: COMPARISON_DOMAINS,
        maxResults: 8,
        includeImages: true,
        includeRawContent: "markdown",
        timeoutMs: 18000
      }),
      ...COMPARISON_DOMAINS.map(domain =>
        tavilySearch(`${query} özellik fiyat site:${domain}`, {
          includeDomains: [domain],
          maxResults: 2,
          includeImages: true,
          includeRawContent: "markdown",
          timeoutMs: 18000
        })
      )
    ];

    const [shopSettled, comparisonSettled] = await Promise.all([
      Promise.allSettled(primarySearches),
      Promise.allSettled(comparisonSearches)
    ]);

    const shopResults = uniqByUrl(shopSettled.flatMap(item => item.status === "fulfilled" ? (item.value.results || []) : []));
    const comparisonResults = uniqByUrl(comparisonSettled.flatMap(item => item.status === "fulfilled" ? (item.value.results || []) : []));
    const allResults = uniqByUrl([...shopResults, ...comparisonResults]);

    const offerCandidates = sortOffersByPriority(shopResults.map(resultToOffer), SHOP_DOMAINS).slice(0, 18);
    const enrichedOffers = await Promise.all(offerCandidates.map(offer => enrichOfferFromPage(offer)));
    const rawOffers = sortOffersByPriority(enrichedOffers, SHOP_DOMAINS).slice(0, 12);
    const comparisonSpecs = specsFromResults(comparisonResults);

    const geminiPrompt = `
Sen Türkiye'deki mağaza, market ve elektronik ürünleri için fiyat karşılaştırma asistanısın.
Öncelik sırası: Trendyol, Hepsiburada, Amazon TR, Migros, CarrefourSA, A101, BİM, Toyzz Shop, Teknosa, MediaMarkt.
Tavily sonuçlarından marka, model, ürün açıklaması, ürün görseli, satıcı fiyatları ve teknik özellikleri çıkar.
Cimri, Kıyas.la ve Epey sonuçlarını özellikle teknik özellik karşılaştırması için kullan.
Sadece kaynaklarda görünen doğrudan linkleri kullan; Google/Bing arama linki döndürme.
Fiyat görünüyorsa mutlaka priceText içine yaz. Fiyat görünmüyorsa priceText boş kalsın ama note alanında "Fiyat sayfada doğrulanmalı" yaz.

Kullanıcı sorgusu: ${query}
OCR metni: ${ocrText}

Tavily sonuçları:
${JSON.stringify(allResults.map(r => ({ title: r.title, url: r.url, content: r.content, raw: r.raw_content })), null, 2)}

Aşağıdaki JSON şemasına uygun cevap ver:
{
  "query": "string",
  "product": {
    "brand": "string",
    "model": "string",
    "productName": "string",
    "description": "string",
    "barcode": "string",
    "detectedPrice": "string",
    "imageURL": "string",
    "specs": { "özellik": "değer" }
  },
  "offers": [
    { "siteName": "string", "title": "string", "priceText": "string", "url": "string", "imageURL": "string", "note": "string" }
  ],
  "suggestions": ["kısa alışveriş tavsiyesi"],
  "comparisonSpecs": { "özellik": "değer" },
  "sources": [ { "title": "string", "url": "string", "sourceType": "shop|comparison|web" } ]
}`;

    let ai = null;
    try { ai = await geminiJson(geminiPrompt); } catch (e) { console.error("Gemini label summary failed:", e.message); }

    const fallback = {
      query,
      product: {
        brand: "",
        model: "",
        productName: query,
        description: "",
        barcode: "",
        detectedPrice: firstPrice(rawOffers),
        imageURL: firstImage(rawOffers),
        specs: comparisonSpecs
      },
      offers: rawOffers,
      suggestions: [
        "En düşük fiyatı seçmeden önce satıcı puanı, stok ve kargo ücretini kontrol edin.",
        "Aynı model, renk ve kapasite olduğundan emin olun.",
        "Mağaza fiyatı ile internet fiyatını garanti ve teslimat şartlarıyla birlikte değerlendirin."
      ],
      comparisonSpecs,
      sources: uniqByUrl([
        ...shopResults.map(r => resultToSource(r, "shop")),
        ...comparisonResults.map(r => resultToSource(r, "comparison"))
      ]).slice(0, 14)
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
  const comparisonSpecs = objectOfText(ai.comparisonSpecs, fallback.comparisonSpecs || fallback.product?.specs || {});

  return {
    query: String(ai.query || fallback.query),
    product: {
      brand: String(ai.product?.brand || ""),
      model: String(ai.product?.model || ""),
      productName: String(ai.product?.productName || fallback.product.productName || ""),
      description: String(ai.product?.description || ""),
      barcode: String(ai.product?.barcode || ""),
      detectedPrice: String(ai.product?.detectedPrice || fallback.product.detectedPrice || firstPrice(offers) || ""),
      imageURL: String(ai.product?.imageURL || fallback.product.imageURL || firstImage(offers) || ""),
      specs: objectOfText(ai.product?.specs, comparisonSpecs)
    },
    comparisonSpecs,
    offers: sortOffersByPriority(offers
      .filter(o => o && o.url && !/google\.|bing\.|duckduckgo\.|yandex\./i.test(o.url))
      .map(o => ({
        siteName: String(o.siteName || safeHost(o.url) || "Web sitesi"),
        title: String(o.title || o.siteName || "Sonuç"),
        priceText: String(o.priceText || priceFromText(`${o.title || ""} ${o.note || ""}`) || ""),
        url: String(o.url),
        imageURL: String(o.imageURL || ""),
        note: String(o.note || "")
      })), SHOP_DOMAINS).slice(0, 12),
    suggestions: arrayOfText(ai.suggestions, fallback.suggestions),
    sources: sources
      .filter(s => s && s.url)
      .map(s => ({ title: String(s.title || safeHost(s.url) || "Kaynak"), url: String(s.url), sourceType: String(s.sourceType || "web") }))
      .slice(0, 14)
  };
}

function arrayOfText(value, fallback) {
  const arr = Array.isArray(value) ? value.map(String).filter(Boolean) : [];
  return arr.length ? arr.slice(0, 8) : fallback;
}

function safeHost(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

function firstPrice(offers) {
  return (offers || []).find(o => o.priceText)?.priceText || "";
}

function firstImage(offers) {
  return (offers || []).find(o => o.imageURL)?.imageURL || "";
}

function objectOfText(value, fallback = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
  const out = {};
  for (const [key, raw] of Object.entries(source || {})) {
    const cleanKey = String(key || "").trim();
    const cleanValue = String(raw || "").trim();
    if (cleanKey && cleanValue) out[cleanKey] = cleanValue;
  }
  return out;
}

function specsFromResults(results) {
  const text = (results || []).map(r => `${r.title || ""} ${r.content || ""} ${r.raw_content || ""}`).join(" ");
  const specs = {};
  const patterns = [
    ["Ekran", /(?:ekran|display)[:\s-]{1,12}([^.;|]{3,80})/i],
    ["Kapasite", /(?:kapasite|storage|hafıza|ram)[:\s-]{1,12}([^.;|]{2,60})/i],
    ["Model", /(?:model)[:\s-]{1,12}([A-Z0-9][A-Z0-9\s\-\/\.]{2,50})/i],
    ["Renk", /(?:renk|color)[:\s-]{1,12}([^.;|]{3,40})/i],
    ["Garanti", /(?:garanti)[:\s-]{1,12}([^.;|]{3,60})/i]
  ];
  for (const [key, re] of patterns) {
    const value = text.match(re)?.[1]?.trim();
    if (value) specs[key] = value.slice(0, 80);
  }
  if (!Object.keys(specs).length) {
    const domainList = [...new Set((results || []).map(r => getHost(r.url)).filter(Boolean))];
    if (domainList.length) specs["Bilgi kaynakları"] = domainList.join(", ");
  }
  return specs;
}
