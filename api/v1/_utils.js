export function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

export function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(new Error("JSON okunamadı."));
      }
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

export function outputTextFromOpenAI(responseJson) {
  if (typeof responseJson.output_text === "string") return responseJson.output_text;

  const parts = [];
  for (const item of responseJson.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === "string") parts.push(content.text);
    }
  }
  return parts.join("\n");
}

export function parseJsonFromText(text) {
  if (!text) throw new Error("Boş AI cevabı.");
  try { return JSON.parse(text); } catch {}

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) return JSON.parse(fenced[1]);

  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) return JSON.parse(text.slice(first, last + 1));

  throw new Error("AI cevabı JSON formatında değil.");
}

export async function callOpenAI(payload) {
  const openAIKey = process.env.OPENAI_API_KEY;
  if (!openAIKey) throw new Error("OPENAI_API_KEY tanımlı değil.");

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${openAIKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }

  if (!response.ok) {
    throw new Error(json?.error?.message || `OpenAI hata kodu: ${response.status}`);
  }
  return json;
}

export function normalizeDecimal(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(String(value).replace(",", "."));
  return Number.isFinite(number) ? number : null;
}

export function demoOffers(product) {
  const q = [product.brand, product.model, product.productName, product.color, product.size]
    .filter(Boolean)
    .join(" ") || product.query || "Ürün";
  const shelf = normalizeDecimal(product.shelfPrice) || 999;
  const base = Math.max(49, shelf);
  return [
    {
      storeName: "Demo Mağaza 1",
      title: q,
      price: Math.round(base * 0.88),
      currencyCode: product.currencyCode || "TRY",
      productURL: "https://www.google.com/search?q=" + encodeURIComponent(q),
      imageURL: null,
      confidence: 0.72,
      shippingSummary: "Demo sonuç",
      updatedAt: new Date().toISOString()
    },
    {
      storeName: "Demo Mağaza 2",
      title: q + " alternatif",
      price: Math.round(base * 0.95),
      currencyCode: product.currencyCode || "TRY",
      productURL: "https://www.google.com/search?q=" + encodeURIComponent(q + " fiyat"),
      imageURL: null,
      confidence: 0.68,
      shippingSummary: "Demo sonuç",
      updatedAt: new Date().toISOString()
    }
  ];
}
