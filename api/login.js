// api/login.js: sayt (/) uchun yagona kirish eshigi.
//   GET  -> { authed, blocked }
//   POST { email, password } -> 200 + cookie | 401 | 403 (bloklangan) | 429
import { authenticate, blockInfo, hasSession, readJson, recordLogin, send, sessionCookie } from "./_lib.js";

export default async function handler(req, res) {
  if (req.method === "GET") {
    // IP bloklangan bo'lsa, cookie to'g'ri bo'lsa ham kirmaysan: butun IP bloklanadi (qolgan vaqt bilan qaytadi).
    const b = await blockInfo(req);
    if (b.blocked) return send(res, 200, { authed: false, ...b });
    const authed = hasSession(req);
    // Sahifa ochilganda (faqat shu payt, har 10 soniyalik pollingda emas) — sessiya orqali
    // allaqachon kirgan bo'lsang ham, "saytga kirish" sifatida hisoblanadi.
    // Javobdan OLDIN kutiladi: aks holda Vercel funksiyasi javob yuborilgach darhol to'xtatilib,
    // hali tugamagan Firestore yozuvi bekor bo'lib qolishi mumkin (shu sabab avval sirpanib ketardi).
    if (authed) await recordLogin();
    return send(res, 200, { authed, blocked: false });
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
  await recordLogin(); // endi kutiladi — javobdan oldin yozuv kafolatlanadi
  return send(res, 200, { ok: true }, { "Set-Cookie": sessionCookie() });
}
