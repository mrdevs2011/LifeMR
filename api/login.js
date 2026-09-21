// api/login.js: sayt (/) uchun yagona kirish eshigi.
//   GET  -> { authed, blocked }
//   POST { email, password } -> 200 + cookie | 401 | 403 (bloklangan) | 429
import { authenticate, hasSession, isBlocked, readJson, recordLogin, send, sessionCookie } from "./_lib.js";

export default async function handler(req, res) {
  if (req.method === "GET") {
    const authed = hasSession(req);
    // Sahifa ochilganda (faqat shu payt, har 10 soniyalik pollingda emas) — sessiya orqali
    // allaqachon kirgan bo'lsang ham, "saytga kirish" sifatida hisoblanadi.
    if (authed) recordLogin();
    return send(res, 200, { authed, blocked: authed ? false : await isBlocked(req) });
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return send(res, 405, { error: "Faqat GET/POST" });
  }
  if (!process.env.SESSION_SECRET) return send(res, 500, { error: "SESSION_SECRET sozlanmagan" });

  let body;
  try {
    body = await readJson(req);
  } catch {
    return send(res, 400, { error: "noto'g'ri so'rov" });
  }
  const r = await authenticate(req, body?.email, body?.password);
  if (!r.ok) return send(res, r.status, r.body);
  recordLogin(); // kutilmaydi — loginni sekinlashtirmasin, xato bo'lsa ham login davom etadi
  return send(res, 200, { ok: true }, { "Set-Cookie": sessionCookie() });
}
