// api/mcp-link.js: /mcp sahifasi. Saytdagi bilan AYNAN BIR XIL login (authenticate) va bitta IP hisobi.
//   GET  -> { blocked }
//   POST { email, password } -> { url } | 401 | 403 | 429
// Bu yerda sessiya cookie berilmaydi: connector URL'ini ko'rish uchun har safar qayta kirasan.
import { authenticate, blockInfo, readJson, recordLogin, send } from "./_lib.js";

export default async function handler(req, res) {
  if (req.method === "GET") return send(res, 200, await blockInfo(req));
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return send(res, 405, { error: "Faqat GET/POST" });
  }
  if (!process.env.MCP_TOKEN) return send(res, 500, { error: "MCP_TOKEN sozlanmagan" });

  let body;
  try {
    body = await readJson(req);
  } catch {
    return send(res, 400, { error: "noto'g'ri so'rov" });
  }
  const r = await authenticate(req, body?.email, body?.password);
  if (!r.ok) return send(res, r.status, r.body);
  recordLogin();

  const proto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return send(res, 200, { url: `${proto}://${host}/api/mcp?k=${process.env.MCP_TOKEN}` });
}
