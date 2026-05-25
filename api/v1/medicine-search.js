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

const MEDICINE_INFO_DOMAINS = [
  "titck.gov.tr",
  "ilacrehberi.com",
  "ilacabak.com",
  "vademecumonline.com.tr",
  "ilacprospektusu.com",
  "prospektus.co",
  "ilacfiyati.com"
];

const MEDICINE_PRICE_DOMAINS = [
  "ilacfiyati.com",
  "ilacrehberi.com",
  "ilacabak.com",
  "vademecumonline.com.tr"
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
    if (!query) return jsonError(res, 400, "İlaç adı boş olamaz.");

    const infoQuery = `${query} kullanma talimatı yan etkileri prospektüs TİTCK`;
    const priceQuery = `${query} fiyat TL ilaç fiyatı eczane`;

    const [infoSearch, priceSearch] = await Promise.allSettled([
      tavilySearch(infoQuery, { includeDomains: MEDICINE_INFO_DOMAINS, maxResults: 8 }),
      tavilySearch(priceQuery, { includeDomains: MEDICINE_PRICE_DOMAINS, maxResults: 8 })
    ]);

    const infoResults = infoSearch.status === "fulfilled" ? (infoSearch.value.results || []) : [];
    const priceResults = priceSearch.status === "fulfilled" ? (priceSearch.value.results || []) : [];
    const allResults = uniqByUrl([...infoResults, ...priceResults]);
    const rawOffers = sortOffers(uniqByUrl(priceResults).map(resultToOffer)).slice(0, 8);

    const geminiPrompt = `
Sen Türkiye için ilaç bilgi asistanısın. Web aramasını Tavily yaptı; sen sadece aşağıdaki sonuçları kaynak alarak özetle.
Tıbbi tavsiye verme. Bilgi yoksa uydurma. Resmi/prospektüs kaynaklarını öne al.

Kullanıcı sorgusu: ${query}
OCR metni: ${ocrText}

Tavily sonuçları:
${JSON.stringify(allResults.map(r => ({ title: r.title, url: r.url, content: r.content })), null, 2)}

Aşağıdaki JSON şemasına uygun cevap ver:
{
  "query": "string",
  "medicine": { "name": "string", "activeIngredient": "string", "form": "string", "packageInfo": "string" },
  "offers": [ { "siteName": "string", "title": "string", "priceText": "string", "url": "string", "note": "string" } ],
  "usageInstructions": ["kısa madde"],
  "sideEffects": ["kısa madde"],
  "warnings": ["kısa madde"],
  "sources": [ { "title": "string", "url": "string", "sourceType": "official|prospectus|price|web" } ],
  "disclaimer": "string"
}
Fiyat yoksa priceText boş olabilir ama url doğrudan site linki olmalı; Google/Bing arama linki döndürme.`;

    let ai = null;
    try { ai = await geminiJson(geminiPrompt); } catch (e) { console.error("Gemini medicine summary failed:", e.message); }

    const sources = uniqByUrl(allResults.map(r => resultToSource(r, sourceTypeForUrl(r.url)))).slice(0, 10);
    const fallback = {
      query,
      medicine: { name: query, activeIngredient: "", form: "", packageInfo: "" },
      offers: rawOffers,
      usageInstructions: ["Kullanım için prospektüsü ve doktor/eczacı önerisini kontrol edin."],
      sideEffects: ["Yan etkiler ilaca göre değişir. Prospektüs ve resmi kaynaklar kontrol edilmelidir."],
      warnings: ["Bu bilgiler doktor/eczacı tavsiyesi değildir.", "Doz ve kullanım süresi için sağlık profesyoneline danışın."],
      sources,
      disclaimer: "Bu bilgiler internet kaynaklarının özetidir; doktor veya eczacı tavsiyesi yerine geçmez."
    };

    const response = normalizeMedicineResponse(ai || fallback, fallback);
    res.status(200).json(response);
  } catch (error) {
    console.error(error);
    return jsonError(res, 500, error.message || "İlaç araması başarısız oldu.");
  }
}

function sourceTypeForUrl(url) {
  const u = String(url || "");
  if (u.includes("titck.gov.tr")) return "official";
  if (u.includes("prospektus") || u.includes("ilacrehberi") || u.includes("ilacabak") || u.includes("vademecum")) return "prospectus";
  if (u.includes("fiyat")) return "price";
  return "web";
}

function normalizeMedicineResponse(ai, fallback) {
  const offers = Array.isArray(ai.offers) && ai.offers.length ? ai.offers : fallback.offers;
  const sources = Array.isArray(ai.sources) && ai.sources.length ? ai.sources : fallback.sources;
  return {
    query: String(ai.query || fallback.query),
    medicine: {
      name: String(ai.medicine?.name || fallback.medicine.name || ""),
      activeIngredient: String(ai.medicine?.activeIngredient || ""),
      form: String(ai.medicine?.form || ""),
      packageInfo: String(ai.medicine?.packageInfo || "")
    },
    offers: offers
      .filter(o => o && o.url && !/google\.|bing\.|duckduckgo\.|yandex\./i.test(o.url))
      .map(o => ({
        siteName: String(o.siteName || safeHost(o.url) || "Web sitesi"),
        title: String(o.title || o.siteName || "Sonuç"),
        priceText: String(o.priceText || ""),
        url: String(o.url),
        note: String(o.note || "")
      }))
      .slice(0, 8),
    usageInstructions: arrayOfText(ai.usageInstructions, fallback.usageInstructions),
    sideEffects: arrayOfText(ai.sideEffects, fallback.sideEffects),
    warnings: arrayOfText(ai.warnings, fallback.warnings),
    sources: sources
      .filter(s => s && s.url)
      .map(s => ({ title: String(s.title || safeHost(s.url) || "Kaynak"), url: String(s.url), sourceType: String(s.sourceType || "web") }))
      .slice(0, 10),
    disclaimer: String(ai.disclaimer || fallback.disclaimer)
  };
}

function arrayOfText(value, fallback) {
  const arr = Array.isArray(value) ? value.map(String).filter(Boolean) : [];
  return arr.length ? arr.slice(0, 8) : fallback;
}

function safeHost(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}
