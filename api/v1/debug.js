import { setCors } from "./_utils.js";

export default function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  res.status(200).json({
    ok: true,
    service: "EtiketRadar Backend Debug",
    appApiKeyConfigured: Boolean(process.env.APP_API_KEY),
    tavilyKeyConfigured: Boolean(process.env.TAVILY_API_KEY),
    tavilyKeyLooksValid: typeof process.env.TAVILY_API_KEY === "string" && process.env.TAVILY_API_KEY.startsWith("tvly-"),
    geminiKeyConfigured: Boolean(process.env.GEMINI_API_KEY),
    geminiModel: process.env.GEMINI_MODEL || "gemini-2.5-flash-lite",
    openAIUsed: false,
    endpoints: ["POST /v1/medicine-search", "POST /v1/label-search", "GET /v1/debug"]
  });
}
