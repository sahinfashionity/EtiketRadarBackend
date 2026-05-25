import { setCors, readJson, requireAuth, callOpenAI, outputTextFromOpenAI, parseJsonFromText, demoOffers } from "./_utils.js";

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Sadece POST desteklenir." });
  if (!requireAuth(req, res)) return;

  try {
    const product = await readJson(req);

    // OPENAI_API_KEY yoksa backend çalıştığını göstermek için demo sonuç döndürür.
    if (!process.env.OPENAI_API_KEY) {
      return res.status(200).json({ offers: demoOffers(product) });
    }

    const query = product.query || [product.brand, product.model, product.productName, product.color, product.size]
      .filter(Boolean)
      .join(" ");

    const prompt = `Türkiye'de güncel online fiyat araması yap. Ürün:\n${JSON.stringify(product)}\n\nKurallar:\n- Trendyol, Hepsiburada, Amazon TR, MediaMarkt, Teknosa, N11 gibi kaynaklardan benzer ürünleri ara.\n- Aynı ürün değilse confidence düşük ver.\n- Sadece JSON döndür: {"offers":[{"storeName":"","title":"","price":0,"currencyCode":"TRY","productURL":"https://...","imageURL":null,"confidence":0.0,"shippingSummary":"","updatedAt":"ISO-8601"}]}\n- En fazla 8 sonuç döndür.\n- Fiyatı sayı olarak yaz.\n- productURL gerçek ürün/sayfa linki olsun.\n- Emin olmadığın sonuçları ekleme.`;

    const ai = await callOpenAI({
      model: process.env.OPENAI_MODEL || "gpt-5.5",
      tools: [{ type: "web_search" }],
      tool_choice: "required",
      input: prompt,
      text: { format: { type: "json_object" } }
    });

    const parsed = parseJsonFromText(outputTextFromOpenAI(ai));
    const offers = Array.isArray(parsed.offers) ? parsed.offers : [];

    const cleaned = offers
      .filter(o => o && o.storeName && o.title && o.price && o.productURL)
      .map(o => ({
        storeName: String(o.storeName),
        title: String(o.title),
        price: Number(o.price),
        currencyCode: o.currencyCode || "TRY",
        productURL: String(o.productURL),
        imageURL: o.imageURL || null,
        confidence: Number(o.confidence ?? 0.7),
        shippingSummary: o.shippingSummary || "",
        updatedAt: o.updatedAt || new Date().toISOString()
      }))
      .sort((a, b) => a.price - b.price)
      .slice(0, 8);

    res.status(200).json({ offers: cleaned.length ? cleaned : demoOffers(product) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}
