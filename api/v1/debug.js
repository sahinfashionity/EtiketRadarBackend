import { setCors } from "./_utils.js";

export default function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.status(200).json({
    ok: true,
    service: "EtiketRadar Backend Debug",
    appApiKeyConfigured: Boolean(process.env.APP_API_KEY),
    openAIKeyConfigured: Boolean(process.env.OPENAI_API_KEY),
    openAIKeyLooksValid: typeof process.env.OPENAI_API_KEY === "string" && process.env.OPENAI_API_KEY.startsWith("sk-"),
    openAIModel: process.env.OPENAI_MODEL || "gpt-5.5",
    demoFallback: false,
    endpoints: [
      "POST /v1/extract-label",
      "POST /v1/product-search",
      "GET /v1/debug"
    ]
  });
}
