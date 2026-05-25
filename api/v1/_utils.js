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
  const matches = t.match(/(?:₺\s*)?\b\d{1,3}(?:\.\d{3})*(?:,\d{2})?\s*(?:TL|₺|TRY)\b/gi);
  if (!matches || !matches.length) return "";
  return matches[0].replace(/TRY/i, "TL").trim();
}

export function sortOffers(offers) {
  function value(priceText) {
    const n = String(priceText || "").replace(/[^0-9,\.]/g, "").replace(/\./g, "").replace(",", ".");
    const f = parseFloat(n);
    return Number.isFinite(f) ? f : Number.MAX_SAFE_INTEGER;
  }
  return [...offers].sort((a, b) => value(a.priceText) - value(b.priceText));
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
    include_raw_content: false
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
  const priceText = priceFromText(`${r.title || ""} ${r.content || ""}`);
  return {
    siteName: host || "Web sitesi",
    title: r.title || host || "Sonuç",
    priceText,
    url: r.url,
    note: priceText ? "Tavily sonucundan algılandı" : "Fiyat için siteyi açın"
  };
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
