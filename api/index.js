export default function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.status(200).json({
    ok: true,
    service: "EtiketRadar Backend",
    message: "Backend çalışıyor. iPhone uygulamasında ana adresi kullanın.",
    baseUrlExample: "https://etiket-radar-backend.vercel.app/",
    endpoints: [
      "POST /v1/extract-label",
      "POST /v1/product-search"
    ]
  });
}
