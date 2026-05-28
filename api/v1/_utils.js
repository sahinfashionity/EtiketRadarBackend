export function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

export function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error("JSON okunamadı.")); }
    });
    req.on("error", reject);
  });
}

export function requireAuth(req, res) {
  const expected = process.env.APP_API_KEY || "";
  if (!expected) return true;
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : header;
  if (token === expected) return true;
  res.statusCode = 401;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ error: "API anahtarı hatalı veya eksik." }));
  return false;
}

export function jsonError(res, status, message, extra = {}) {
  res.status(status).json({ error: message, ...extra });
}

export function cleanQuery(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/[<>]/g, "")
    .trim()
    .slice(0, 260);
}

export function getHost(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); }
  catch { return ""; }
}

export function uniqByUrl(items) {
  const seen = new Set();
  const out = [];
  for (const item of items || []) {
    const url = String(item.url || "").trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(item);
  }
  return out;
}

export function priceFromText(text) {
  const t = String(text || "");
  const matches = t.match(/(?:₺\s*)?\b\d{1,3}(?:\.\d{3})*(?:,\d{2})?\s*(?:TL|₺|TRY|TL\.?)\b|(?:₺\s*)\d{2,7}(?:[.,]\d{2})?/gi);
  if (!matches || !matches.length) return "";
  return matches[0].replace(/TRY/i, "TL").trim();
}

export function numericPrice(priceText) {
  const n = String(priceText || "")
    .replace(/[^0-9,\.]/g, "")
    .replace(/\.(?=\d{3}(?:\D|$))/g, "")
    .replace(",", ".");
  const f = parseFloat(n);
  return Number.isFinite(f) ? f : Number.MAX_SAFE_INTEGER;
}

export function sortOffers(offers) {
  return [...offers].sort((a, b) => numericPrice(a.priceText) - numericPrice(b.priceText));
}

export async function tavilySearch(query, options = {}) {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error("TAVILY_API_KEY Vercel Environment Variables içinde tanımlı değil.");

  const payload = {
    query,
    topic: options.topic || "general",
    search_depth: options.searchDepth || "advanced",
    max_results: options.maxResults || 8,
    include_answer: false,
    include_raw_content: options.includeRawContent || false,
    include_images: Boolean(options.includeImages),
    include_image_descriptions: Boolean(options.includeImageDescriptions)
  };
  if (options.includeDomains?.length) payload.include_domains = options.includeDomains;
  if (options.excludeDomains?.length) payload.exclude_domains = options.excludeDomains;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 25000);
  try {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Tavily araması başarısız: ${response.status} ${text.slice(0, 200)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timeout);
  }
}

export function resultToSource(r, sourceType = "web") {
  return {
    title: r.title || getHost(r.url) || "Kaynak",
    url: r.url,
    sourceType
  };
}

export function resultToOffer(r) {
  const host = getHost(r.url);
  const priceText = priceFromText(`${r.title || ""} ${r.content || ""} ${r.raw_content || ""}`);
  return {
    siteName: host || "Web sitesi",
    title: r.title || host || "Sonuç",
    priceText,
    url: r.url,
    imageURL: imageFromSearchResult(r),
    note: priceText ? "Tavily sonucundan algılandı" : "Fiyat için siteyi açın"
  };
}

export function imageFromSearchResult(r) {
  const candidates = [r.image, r.thumbnail, r.raw_content, r.content].filter(Boolean).join(" ");
  const match = candidates.match(/https?:\/\/[^\s"'<>]+\.(?:jpg|jpeg|png|webp)(?:\?[^\s"'<>]*)?/i);
  return match ? match[0] : "";
}

export function priorityIndex(host, domains) {
  const clean = String(host || "").replace(/^www\./, "");
  const index = domains.findIndex(domain => clean === domain || clean.endsWith(`.${domain}`));
  return index >= 0 ? index : 999;
}

export function sortOffersByPriority(offers, domains) {
  return [...offers].sort((a, b) => {
    const domainDiff = priorityIndex(getHost(a.url), domains) - priorityIndex(getHost(b.url), domains);
    if (domainDiff !== 0) return domainDiff;
    return numericPrice(a.priceText) - numericPrice(b.priceText);
  });
}

export async function enrichOfferFromPage(offer, timeoutMs = 6500) {
  if (!offer?.url) return offer;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(offer.url, {
      headers: {
        "User-Agent": "Mozilla/5.0 EtiketRadar/1.0 price comparison",
        "Accept": "text/html,application/xhtml+xml"
      },
      signal: controller.signal
    });
    if (!response.ok) return offer;
    const html = await response.text();
    const meta = metadataFromHtml(html);
    return {
      ...offer,
      title: meta.title || offer.title,
      priceText: offer.priceText || meta.priceText || priceFromText(html),
      imageURL: offer.imageURL || meta.imageURL,
      note: offer.priceText || meta.priceText ? offer.note : "Sayfa metadata kontrol edildi"
    };
  } catch {
    return offer;
  } finally {
    clearTimeout(timeout);
  }
}

export function metadataFromHtml(html) {
  const text = String(html || "");
  const jsonLd = [...text.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1])
    .map(stripHtmlEntities)
    .flatMap(parseJsonMaybe)
    .flatMap(flattenJsonLd);
  const product = jsonLd.find(item => {
    const type = Array.isArray(item?.["@type"]) ? item["@type"].join(" ") : item?.["@type"];
    return /product|offer/i.test(String(type || ""));
  }) || {};
  const offer = Array.isArray(product.offers) ? product.offers[0] : (product.offers || product);
  const price = offer?.price || offer?.lowPrice || offer?.highPrice || product.price;
  const currency = offer?.priceCurrency || product.priceCurrency || "TRY";
  const image = firstString(product.image || offer?.image) || metaContent(text, "og:image") || metaContent(text, "twitter:image");
  const title = firstString(product.name) || metaContent(text, "og:title") || titleFromHtml(text);
  return {
    title,
    priceText: price ? `${price} ${currency === "TRY" ? "TL" : currency}` : priceFromText(text.slice(0, 12000)),
    imageURL: image
  };
}

function parseJsonMaybe(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function flattenJsonLd(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(flattenJsonLd);
  const graph = value["@graph"];
  return graph ? [value, ...flattenJsonLd(graph)] : [value];
}

function firstString(value) {
  if (Array.isArray(value)) return firstString(value[0]);
  if (typeof value === "object" && value) return value.url || value.contentUrl || value.name || "";
  return String(value || "");
}

function metaContent(html, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["']`, "i");
  return stripHtmlEntities(html.match(re)?.[1] || "");
}

function titleFromHtml(html) {
  return stripHtmlEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").trim();
}

function stripHtmlEntities(value) {
  return String(value || "")
    .replace(/&quot;/g, "\"")
    .replace(/&#34;/g, "\"")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

export function textFromGemini(json) {
  const parts = json?.candidates?.[0]?.content?.parts || [];
  return parts.map(p => p.text || "").join("\n").trim();
}

export function parseJsonLoose(text) {
  if (!text) throw new Error("Boş LLM cevabı.");
  try { return JSON.parse(text); } catch {}
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) return JSON.parse(fenced[1]);
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) return JSON.parse(text.slice(first, last + 1));
  throw new Error("LLM cevabı JSON değil.");
}

export async function geminiJson(prompt, timeoutMs = 30000) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: "application/json"
    }
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    let text = await response.text();

    // Bazı model/hesaplarda JSON mode hata verirse düz metin prompt ile tekrar dener.
    if (!response.ok && text.includes("responseMimeType")) {
      delete body.generationConfig.responseMimeType;
      body.contents[0].parts[0].text += "\n\nSadece geçerli JSON döndür. Markdown kullanma.";
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      text = await response.text();
    }

    if (!response.ok) throw new Error(`Gemini hatası: ${response.status} ${text.slice(0, 200)}`);
    const raw = textFromGemini(JSON.parse(text));
    return parseJsonLoose(raw);
  } finally {
    clearTimeout(timeout);
  }
}
