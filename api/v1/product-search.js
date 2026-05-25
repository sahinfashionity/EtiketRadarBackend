import { setCors, readJson, requireAuth, callOpenAI, outputTextFromOpenAI, parseJsonFromText, normalizeDecimal, normalizeUrl, jsonError } from "./_utils.js";

const USER_AGENT = "Mozilla/5.0 (compatible; EtiketRadar/1.0; +https://etiket-radar-backend.vercel.app)";

const SEARCH_DOMAINS = [
  "ilacfiyati.com",
  "ilacrehberi.com",
  "ilacabak.com",
  "vademecumonline.com.tr",
  "ilacprospektusu.com",
  "prospektus.co"
];

const BAD_URL_HOST_RE = /(google\.|duckduckgo\.|bing\.|yandex\.|facebook\.|instagram\.|youtube\.|tiktok\.|x\.com|twitter\.)/i;

const GENERIC_WORDS = new Set([
  "fiyat", "fiyatı", "fiyati", "tl", "try", "turkiye", "türkiye", "ilaç", "ilac", "eczane",
  "tablet", "film", "kaplı", "kapli", "kapsül", "kapsul", "damla", "şurup", "surup", "süspansiyon",
  "suspansiyon", "ampul", "flakon", "krem", "jel", "mg", "ml", "mcg", "iu", "steril", "cozelti",
  "çözelti", "sprey", "saşe", "sase", "adet", "oral", "oftalmik"
]);

function cleanText(value) {
  return String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&ouml;/g, "ö")
    .replace(/&Ouml;/g, "Ö")
    .replace(/&uuml;/g, "ü")
    .replace(/&Uuml;/g, "Ü")
    .replace(/&ccedil;/g, "ç")
    .replace(/&Ccedil;/g, "Ç")
    .replace(/&scedil;/g, "ş")
    .replace(/&Scedil;/g, "Ş")
    .replace(/&gbreve;/g, "ğ")
    .replace(/&Gbreve;/g, "Ğ")
    .replace(/&imath;/g, "ı")
    .replace(/&Idot;/g, "İ")
    .replace(/\s+/g, " ")
    .trim();
}

function simplifyForKey(value) {
  return String(value || "")
    .toLocaleLowerCase("tr-TR")
    .replace(/ğ/g, "g")
    .replace(/ü/g, "u")
    .replace(/ş/g, "s")
    .replace(/ı/g, "i")
    .replace(/ö/g, "o")
    .replace(/ç/g, "c")
    .replace(/İ/g, "i")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function normalizeSearchText(value) {
  return String(value || "")
    .toLocaleLowerCase("tr-TR")
    .replace(/[%]/g, " ")
    .replace(/[,]/g, ".")
    .replace(/[^a-z0-9ığüşöçİĞÜŞÖÇ.\s-]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function addIfMissing(parts, text) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) return;
  const valueKey = simplifyForKey(value);
  if (!valueKey) return;
  const joinedKey = simplifyForKey(parts.join(" "));
  if (!joinedKey.includes(valueKey)) parts.push(value);
}

function removeDuplicateTokens(value) {
  const seen = new Set();
  const result = [];
  for (const token of String(value || "").split(/\s+/).filter(Boolean)) {
    const key = simplifyForKey(token);
    if (!key) continue;
    // İlaç adının iki kez yazılması aramayı bozuyor: "Majezik Majezik 100 mg" gibi.
    // Sayısal değerleri ve kısa doz birimlerini koruyoruz.
    if (/^\d/.test(key) || ["mg", "ml", "iu", "mcg"].includes(key)) {
      result.push(token);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(token);
  }
  return result.join(" ");
}

function normalizeProductQuery(value) {
  return removeDuplicateTokens(
    String(value || "")
      .replace(/\b(ürün adı|urun adi|marka|brand|model)\b\s*[:：-]?/gi, " ")
      .replace(/[,]+/g, " ")
      .replace(/%\s*/g, "%")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function queryFromProduct(product) {
  const parts = [];

  // iPhone uygulaması query alanını brand+productName şeklinde oluşturuyor.
  // Kullanıcı ürün adı + marka yazınca aynı kelime iki/üç kez gelebiliyor.
  // Bu yüzden önce ürün adını esas alıyor, eksikse marka/model ekliyoruz.
  addIfMissing(parts, product?.productName);
  addIfMissing(parts, product?.brand);
  addIfMissing(parts, product?.model);
  addIfMissing(parts, product?.size);
  addIfMissing(parts, product?.barcode);

  if (!parts.length) addIfMissing(parts, product?.query);

  const fromCleanFields = normalizeProductQuery(parts.join(" "));
  const fromRawQuery = normalizeProductQuery(product?.query || "");

  // Temiz alanlardan çıkan sorgu yeterliyse onu kullan; değilse uygulamanın query alanına düş.
  return fromCleanFields || fromRawQuery;
}

function importantTokens(query) {
  return normalizeSearchText(query)
    .split(/[\s-]+/)
    .map(t => t.trim())
    .filter(t => t.length >= 2)
    .filter(t => !GENERIC_WORDS.has(t));
}

function isLikelyMatchingProduct(query, title, pageText = "") {
  const tokens = importantTokens(query);
  if (!tokens.length) return true;
  const haystack = normalizeSearchText(`${title} ${pageText.slice(0, 12000)}`);
  const hits = tokens.filter(t => haystack.includes(t));

  if (hits.length >= Math.min(2, tokens.length)) return true;
  if (tokens[0] && haystack.includes(tokens[0])) return true;
  return false;
}

function firstMedicineName(query) {
  return normalizeSearchText(query).split(/\s+/).find(t => t && !GENERIC_WORDS.has(t) && !/^\d/.test(t)) || "";
}

function dosePart(query) {
  const q = normalizeSearchText(query);
  const match = q.match(/\b\d+(?:[.,]\d+)?\s*(?:mg|ml|mcg|iu|%)\b/i);
  return match ? match[0].replace(/\s+/g, " ") : "";
}

function searchQueriesForProduct(query) {
  const q = normalizeProductQuery(query);
  const name = firstMedicineName(q);
  const dose = dosePart(q);
  const shortDrugQuery = normalizeProductQuery([name, dose].filter(Boolean).join(" "));
  const queries = [];

  if (q) {
    queries.push(`${q} ilaç fiyatı`);
    queries.push(`${q} fiyat`);
    queries.push(`"${q}" ilaç fiyatı`);
  }
  if (shortDrugQuery && shortDrugQuery !== q) {
    queries.push(`${shortDrugQuery} ilaç fiyatı`);
    queries.push(`"${shortDrugQuery}" fiyat`);
  }
  if (name) {
    queries.push(`${name} ilaç fiyatı`);
    queries.push(`${name} site:ilacfiyati.com`);
  }

  for (const domain of SEARCH_DOMAINS) {
    if (q) queries.push(`${q} site:${domain}`);
    if (shortDrugQuery && shortDrugQuery !== q) queries.push(`${shortDrugQuery} site:${domain}`);
  }

  if (/\b\d{8,14}\b/.test(q)) queries.unshift(q);

  return [...new Set(queries)].slice(0, 16);
}

function trSlug(value) {
  return String(value || "")
    .toLocaleLowerCase("tr-TR")
    .replace(/ğ/g, "g")
    .replace(/ü/g, "u")
    .replace(/ş/g, "s")
    .replace(/ı/g, "i")
    .replace(/ö/g, "o")
    .replace(/ç/g, "c")
    .replace(/%/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function directCandidateUrls(query) {
  const q = normalizeProductQuery(query);
  const name = firstMedicineName(q);
  const dose = dosePart(q);
  const core = trSlug([name, dose].filter(Boolean).join(" ") || q);
  if (!core) return [];

  const endings = [
    "15-film-tablet",
    "20-film-tablet",
    "30-film-tablet",
    "14-film-kapli-tablet",
    "20-film-kapli-tablet",
    "30-film-kapli-tablet",
    "10-film-tablet",
    "24-film-tablet",
    "28-film-tablet",
    "100-ml-surup",
    "120-ml-surup",
    "150-ml-surup",
    "100-ml-suspansiyon",
    "150-ml-suspansiyon",
    "30-ml-damla",
    "10-ml-damla",
    "5-ml-damla",
    "30-ml-sprey",
    "50-gr-krem",
    "30-gr-krem",
    "50-gr-jel",
    "30-gr-jel"
  ];

  const urls = [`https://ilacfiyati.com/ilaclar/${core}`];
  for (const ending of endings) urls.push(`https://ilacfiyati.com/ilaclar/${core}-${ending}`);

  return [...new Set(urls)];
}

function decodeDuckUrl(href) {
  let out = String(href || "").replace(/&amp;/g, "&");
  try {
    const url = new URL(out, "https://duckduckgo.com");
    if (url.hostname.includes("duckduckgo.com") && url.searchParams.get("uddg")) {
      out = decodeURIComponent(url.searchParams.get("uddg"));
    }
  } catch {}
  return normalizeUrl(out);
}

function extractLinksFromDuckDuckGo(html) {
  const links = [];
  const regexes = [
    /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
    /<a[^>]+rel="nofollow"[^>]+class="[^"]*result__url[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
    /<a[^>]+href="(\/l\/\?kh=[^"]+uddg=[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  ];

  for (const regex of regexes) {
    let match;
    while ((match = regex.exec(html)) !== null) {
      const url = decodeDuckUrl(match[1]);
      const title = cleanText(match[2]);
      if (!url || BAD_URL_HOST_RE.test(url)) continue;
      if (!links.some(x => x.url === url)) links.push({ url, title });
    }
  }

  return links;
}

function extractJsonLdPrice(html) {
  const prices = [];
  const scriptRegex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptRegex.exec(html)) !== null) {
    try {
      const json = JSON.parse(match[1].trim());
      const stack = Array.isArray(json) ? [...json] : [json];
      while (stack.length) {
        const item = stack.shift();
        if (!item || typeof item !== "object") continue;
        if (Array.isArray(item)) {
          stack.push(...item);
          continue;
        }
        if (item.offers) stack.push(item.offers);
        if (item.price) {
          const p = normalizeDecimal(item.price);
          if (p) prices.push(p);
        }
        if (item.lowPrice) {
          const p = normalizeDecimal(item.lowPrice);
          if (p) prices.push(p);
        }
      }
    } catch {}
  }
  return prices;
}

function extractMetaPrice(html) {
  const prices = [];
  const regexes = [
    /<meta[^>]+(?:property|name)=["'](?:product:price:amount|price|twitter:data1)["'][^>]+content=["']([^"']+)["']/gi,
    /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:product:price:amount|price|twitter:data1)["']/gi
  ];
  for (const rx of regexes) {
    let m;
    while ((m = rx.exec(html)) !== null) {
      const p = normalizeDecimal(String(m[1]).replace(/[^0-9,.]/g, ""));
      if (p) prices.push(p);
    }
  }
  return prices;
}

function extractTextPrices(html) {
  const text = cleanText(html);
  const candidates = [];
  const regexes = [
    /(?:KDV\s*Dahil\s*)?(?:Perakende\s*)?(?:Satış\s*)?(?:Fiyatı|Fiyati|Fiyat|İlaç\s*Fiyatı|Ilac\s*Fiyati|İLAÇ\s*FİYATI)\s*[:\-]?\s*(?:₺\s*)?(\d{1,7}(?:[.,]\d{1,2})?)\s*(?:TL|₺)?/gi,
    /(?:Satış\s*Fiyatı|Satis\s*Fiyati)\s*[:\-]?\s*(\d{1,7}(?:[.,]\d{1,2})?)\s*₺/gi,
    /(?:₺\s*)?(\d{1,7}(?:[.,]\d{2}))\s*(?:TL|₺)/gi
  ];

  for (const rx of regexes) {
    let m;
    while ((m = rx.exec(text)) !== null) {
      const p = normalizeDecimal(m[1]);
      if (p && p >= 1 && p <= 1000000) candidates.push(p);
    }
  }
  return candidates;
}

function extractPrice(html) {
  const prices = [
    ...extractJsonLdPrice(html),
    ...extractMetaPrice(html),
    ...extractTextPrices(html)
  ].filter(p => p && p >= 1 && p <= 1000000);

  if (!prices.length) return null;
  const sorted = [...new Set(prices.map(p => Math.round(p * 100) / 100))].sort((a, b) => a - b);
  return sorted[0];
}

function extractTitle(html, fallback) {
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1];
  if (og) return cleanText(og).slice(0, 180);
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  return cleanText(title || fallback || "Ürün sonucu").slice(0, 180);
}

function storeNameFromUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    if (host.includes("ilacfiyati")) return "İlaç Fiyatı";
    if (host.includes("ilacrehberi")) return "İlaç Rehberi";
    if (host.includes("ilacabak")) return "İlaca Bak";
    if (host.includes("vademecum")) return "Vademecum Online";
    if (host.includes("ilacprospektusu")) return "İlaç Prospektüsü";
    if (host.includes("prospektus")) return "Prospektüs";
    if (host.includes("akakce")) return "Akakçe";
    if (host.includes("cimri")) return "Cimri";
    if (host.includes("trendyol")) return "Trendyol";
    if (host.includes("hepsiburada")) return "Hepsiburada";
    if (host.includes("amazon")) return "Amazon";
    return host.split(".")[0].replace(/-/g, " ").replace(/\b\w/g, c => c.toLocaleUpperCase("tr-TR"));
  } catch {
    return "Web sonucu";
  }
}

function domainPriority(url) {
  try {
    const host = new URL(url).hostname;
    const preferred = ["ilacfiyati", "ilacrehberi", "ilacabak", "vademecum", "ilacprospektusu", "prospektus", "akakce", "cimri"];
    const idx = preferred.findIndex(d => host.includes(d));
    return idx >= 0 ? idx : 99;
  } catch {
    return 99;
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 7000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

async function searchDuckDuckGo(searchQuery) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(searchQuery)}&kl=tr-tr`;
  const response = await fetchWithTimeout(url, { headers: { "User-Agent": USER_AGENT } }, 8000);
  if (!response.ok) return [];
  const html = await response.text();
  return extractLinksFromDuckDuckGo(html);
}

async function offerFromPage(link, query) {
  const page = await fetchWithTimeout(link.url, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    }
  }, 9000);

  if (!page.ok) return null;
  const contentType = page.headers.get("content-type") || "";
  if (contentType && !contentType.includes("text/html") && !contentType.includes("application/xhtml")) return null;

  const html = await page.text();
  const pageText = cleanText(html);
  const title = extractTitle(html, link.title);
  if (/404|not found|bulunamadı/i.test(title) && !extractPrice(html)) return null;
  if (!isLikelyMatchingProduct(query, title, pageText)) return null;

  const price = extractPrice(html);
  if (!price) return null;

  return {
    storeName: storeNameFromUrl(link.url),
    title,
    price,
    currencyCode: "TRY",
    productURL: link.url,
    imageURL: null,
    confidence: Math.max(0.72, 0.96 - domainPriority(link.url) * 0.02),
    shippingSummary: "Direkt web sonucu",
    updatedAt: new Date().toISOString()
  };
}

async function directCandidateSearch(query) {
  const offers = [];
  for (const url of directCandidateUrls(query).slice(0, 24)) {
    try {
      const offer = await offerFromPage({ url, title: query }, query);
      if (offer && !offers.some(o => o.productURL === offer.productURL)) offers.push(offer);
      if (offers.length >= 4) break;
    } catch {}
  }
  return offers;
}

async function directWebSearch(query) {
  const allLinks = [];
  const queries = searchQueriesForProduct(query);

  for (const searchQuery of queries) {
    try {
      const links = await searchDuckDuckGo(searchQuery);
      for (const link of links) {
        if (!link.url || BAD_URL_HOST_RE.test(link.url)) continue;
        if (!allLinks.some(x => x.url === link.url)) allLinks.push(link);
      }
      if (allLinks.length >= 18) break;
    } catch {}
  }

  allLinks.sort((a, b) => domainPriority(a.url) - domainPriority(b.url));

  const offers = [];
  for (const link of allLinks.slice(0, 14)) {
    try {
      const offer = await offerFromPage(link, query);
      if (offer && !offers.some(o => o.productURL === offer.productURL)) offers.push(offer);
      if (offers.length >= 6) break;
    } catch {}
  }

  return offers;
}

async function openAIWebSearch(product, query) {
  if (!process.env.OPENAI_API_KEY) return [];

  const prompt = `Türkiye webinde ürün/ilaç fiyat araması yap. Kullanıcının yazdığı sorguya göre gerçek sonuç döndür.

Temiz arama sorgusu: ${query}
Ürün bilgisi: ${JSON.stringify(product, null, 2)}

Kurallar:
- İlaçlarda ilacfiyati.com, ilacrehberi.com, ilacabak.com, vademecumonline.com.tr gibi doğrudan ilaç/fiyat sayfalarını tercih et.
- Google, DuckDuckGo, Bing veya reklam/takip/yönlendirme linki döndürme.
- productURL mutlaka doğrudan ürün, ilaç bilgi sayfası veya fiyat sayfası olsun.
- Türkiye fiyatı ara. Para birimi TRY olsun.
- Fiyatı bulamazsan o sonucu ekleme.
- Demo/uydurma sonuç üretme.
- En fazla 8 sonuç döndür.
- Sadece geçerli JSON döndür.

JSON şeması:
{"offers":[{"storeName":"","title":"","price":0,"currencyCode":"TRY","productURL":"https://...","imageURL":null,"confidence":0.0,"shippingSummary":"Direkt web sonucu","updatedAt":"ISO-8601"}]}`;

  const configured = process.env.OPENAI_MODEL || "gpt-5.5";
  const models = [...new Set([configured, "gpt-5.5", "gpt-5.4-mini", "gpt-4.1-mini"])];
  let lastError;

  for (const model of models) {
    try {
      const ai = await callOpenAI({
        model,
        tools: [{ type: "web_search" }],
        input: prompt
      }, 45000);

      const parsed = parseJsonFromText(outputTextFromOpenAI(ai));
      return Array.isArray(parsed.offers) ? parsed.offers : [];
    } catch (error) {
      lastError = error;
      console.error(`OpenAI web_search failed with ${model}:`, error?.message || error);
    }
  }

  if (lastError) console.error("OpenAI fallback failed:", lastError?.message || lastError);
  return [];
}

function cleanOffers(rawOffers, query) {
  const queryTokens = importantTokens(query);

  return rawOffers
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
    .filter(o => !BAD_URL_HOST_RE.test(o.productURL))
    .filter(o => !/demo/i.test(`${o.storeName} ${o.title} ${o.shippingSummary}`))
    .filter(o => {
      if (!queryTokens.length) return true;
      return isLikelyMatchingProduct(query, o.title, `${o.storeName} ${o.productURL}`);
    })
    .filter((o, idx, arr) => arr.findIndex(x => x.productURL === o.productURL) === idx)
    .sort((a, b) => {
      const d = domainPriority(a.productURL) - domainPriority(b.productURL);
      if (d !== 0) return d;
      return a.price - b.price;
    })
    .slice(0, 8);
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Sadece POST desteklenir." });
  if (!requireAuth(req, res)) return;

  try {
    const product = await readJson(req);
    const query = queryFromProduct(product);

    if (!query) {
      return res.status(200).json({ offers: [], query: "", count: 0 });
    }

    let rawOffers = [];

    // 1) İlaç fiyatı sitelerinde tahmin edilebilir doğrudan URL'leri dener.
    // Örnek: Majezik 100 mg -> ilacfiyati.com/ilaclar/majezik-100-mg-15-film-tablet
    try {
      rawOffers = await directCandidateSearch(query);
    } catch (e) {
      console.error("Direct candidate search failed:", e?.message || e);
    }

    // 2) Sonuç yoksa web araması ile gerçek sayfaları bulur.
    if (!rawOffers.length) {
      try {
        rawOffers = await directWebSearch(query);
      } catch (e) {
        console.error("Direct web search failed:", e?.message || e);
      }
    }

    // 3) Hâlâ sonuç yoksa OpenAI web_search ile canlı sonuç arar.
    if (!rawOffers.length) {
      rawOffers = await openAIWebSearch(product, query);
    }

    const cleaned = cleanOffers(rawOffers, query);

    return res.status(200).json({
      offers: cleaned,
      query,
      count: cleaned.length
    });
  } catch (error) {
    console.error(error);
    return jsonError(res, 500, error.message || "Fiyat arama sırasında hata oluştu.");
  }
}
