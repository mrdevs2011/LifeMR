// api/checkins.js: sayt yozuvlarini o'qish/yozish. Faqat sessiya cookie bilan.
// Server Firestore'ga Claude akkaunti bilan boradi (rules faqat shu UID'ga ruxsat beradi).
import { REST, fsFetch, hasSession, key, readJson, send, sessionCookie } from "./_lib.js";

const LIMIT = 300;

function tashkentVaqt() {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Tashkent", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date()).map((x) => [x.type, x.value])
  );
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

export default async function handler(req, res) {
  if (!hasSession(req)) return send(res, 401, { error: "kirish kerak" });
  // Sirpanuvchi sessiya: sayt ochilgan sari (bu so'rov shu payt yuboriladi) muddat yana 7 kunga
  // uzayadi — muddat SERVERNING soatiga qarab hisoblanadi (Date.now()), brauzer soatiga emas,
  // shuning uchun lokal vaqtni o'zgartirib aldab bo'lmaydi. 7 kun davomida umuman kirmasang,
  // eski cookie'ning imzosi to'g'ri bo'lsa ham muddati o'tgan bo'ladi va qayta login so'raladi.
  // Qo'shimcha so'rov emas — shu javobning ustiga bir header qo'shiladi, sahifa ochilishini
  // kutdirmaydi.
  res.setHeader("Set-Cookie", sessionCookie());
  for (const k of ["FS_KEY", "CLAUDE_EMAIL", "CLAUDE_PASSWORD"]) {
    if (!process.env[k]) return send(res, 500, { error: `${k} sozlanmagan` });
  }

  try {
    if (req.method === "GET") {
      const r = await fsFetch(`${REST}:runQuery?${key()}`, {
        method: "POST",
        body: JSON.stringify({
          structuredQuery: {
            from: [{ collectionId: "checkins" }],
            orderBy: [{ field: { fieldPath: "timestamp" }, direction: "DESCENDING" }],
            limit: LIMIT,
          },
        }),
      });
      if (!r.ok) return send(res, 502, { error: `Firestore o'qish xatosi (${r.status})` });
      const rows = await r.json();
      const items = (Array.isArray(rows) ? rows : [])
        .filter((x) => x.document)
        .map((x) => ({
          vaqt: x.document.fields?.vaqt?.stringValue || "",
          holat: x.document.fields?.holat?.stringValue || "",
          ts: x.document.fields?.timestamp?.timestampValue || null,
        }));
      return send(res, 200, { items });
    }

    if (req.method === "POST") {
      const body = await readJson(req).catch(() => ({}));
      const holat = typeof body?.holat === "string" ? body.holat.trim() : "";
      if (!holat || holat.length > 490) return send(res, 400, { error: "holat 1-490 belgi bo'lishi kerak" });
      const vaqt = tashkentVaqt();
      const r = await fsFetch(`${REST}/checkins?${key()}`, {
        method: "POST",
        body: JSON.stringify({
          fields: {
            vaqt: { stringValue: vaqt },
            holat: { stringValue: holat },
            timestamp: { timestampValue: new Date().toISOString() },
          },
        }),
      });
      if (!r.ok) return send(res, 502, { error: `Firestore yozish xatosi (${r.status})` });
      return send(res, 200, { ok: true, vaqt });
    }

    res.setHeader("Allow", "GET, POST");
    return send(res, 405, { error: "Faqat GET/POST" });
  } catch (e) {
    return send(res, 502, { error: String(e.message || e).slice(0, 200) });
  }
}
