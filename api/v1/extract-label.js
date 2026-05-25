import { setCors, readJson, requireAuth, callOpenAI, outputTextFromOpenAI, parseJsonFromText } from "./_utils.js";

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Sadece POST desteklenir." });
  if (!requireAuth(req, res)) return;

  try {
    const body = await readJson(req);
    const current = body.current || {};

    // OpenAI anahtarı yoksa uygulamadaki yerel OCR/parser sonucu aynen döndürülür.
    if (!process.env.OPENAI_API_KEY) {
      return res.status(200).json({ ...current, confidence: current.confidence ?? 0.7 });
    }

    const content = [
      {
        type: "input_text",
        text: `Aşağıdaki mağaza raf etiketi OCR sonucunu ürün alanlarına ayır. Sadece JSON döndür.\n\nOCR:\n${body.ocrText || current.rawText || ""}\n\nMevcut tahmin:\n${JSON.stringify(current)}`
      }
    ];

    if (body.imageBase64) {
      content.push({
        type: "input_image",
        image_url: `data:image/jpeg;base64,${body.imageBase64}`,
        detail: "auto"
      });
    }

    const ai = await callOpenAI({
      model: process.env.OPENAI_MODEL || "gpt-5.5",
      input: [
        {
          role: "system",
          content: [{
            type: "input_text",
            text: "Sen Türkiye mağaza raf etiketi okuyan bir asistansın. Marka, model, ürün adı, beden, renk, barkod ve etiket fiyatını çıkar. Yanlış emin olmadığın alanları boş string bırak. Sadece geçerli JSON döndür. Alanlar: brand, model, productName, size, color, barcode, shelfPrice, currencyCode, rawText, confidence."
          }]
        },
        { role: "user", content }
      ],
      text: { format: { type: "json_object" } }
    });

    const parsed = parseJsonFromText(outputTextFromOpenAI(ai));
    res.status(200).json({
      brand: parsed.brand ?? current.brand ?? "",
      model: parsed.model ?? current.model ?? "",
      productName: parsed.productName ?? current.productName ?? "",
      size: parsed.size ?? current.size ?? "",
      color: parsed.color ?? current.color ?? "",
      barcode: parsed.barcode ?? current.barcode ?? "",
      shelfPrice: parsed.shelfPrice ?? current.shelfPrice ?? null,
      currencyCode: parsed.currencyCode ?? current.currencyCode ?? "TRY",
      rawText: parsed.rawText ?? body.ocrText ?? current.rawText ?? "",
      confidence: parsed.confidence ?? current.confidence ?? 0.85
    });
  } catch (error) {
    // Uygulama AI hatasında yerel sonucu kullanabilsin diye 200 ile mevcut bilgiyi döndürmek daha güvenli.
    try {
      const body = await readJson(req);
      return res.status(200).json(body.current || { confidence: 0.5 });
    } catch {
      return res.status(500).json({ error: error.message });
    }
  }
}
