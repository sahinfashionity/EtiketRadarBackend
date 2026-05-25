export default function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.status(200).json({
    ok: true,
    service: "EtiketRadar Backend - Tavily + Gemini",
    endpoints: ["POST /v1/medicine-search", "POST /v1/label-search", "GET /v1/debug"],
    note: "iPhone uygulamasında ana backend URL adresini kullanın. Endpoint yolunu uygulama ekler."
  });
}
