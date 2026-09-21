// api/jadval.js: dars jadvali (haftalik grid) — o'qish/yozish. Faqat sessiya cookie bilan.
// Bitta doimiy hujjat: jadval/main. Katak kaliti: "<kun>_<soat>" (masalan mon_1..sat_8).
// Har PUT butun gridni almashtiradi (bo'sh katak yozilmaydi, shuning uchun hujjat faqat
// to'ldirilgan kataklarni saqlaydi).
import { REST, fsFetch, hasSession, key, readJson, send, sessionCookie } from "./_lib.js";

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat"];
const ROWS = 8;
const CELL_MAX = 60;

const ALLOWED_KEYS = new Set();
for (const d of DAYS) for (let i = 1; i <= ROWS; i++) ALLOWED_KEYS.add(`${d}_${i}`);

export default async function handler(req, res) {
  if (!hasSession(req)) return send(res, 401, { error: "kirish kerak" });
  res.setHeader("Set-Cookie", sessionCookie());
  for (const k of ["FS_KEY", "CLAUDE_EMAIL", "CLAUDE_PASSWORD"]) {
    if (!process.env[k]) return send(res, 500, { error: `${k} sozlanmagan` });
  }

  try {
    if (req.method === "GET") {
      const r = await fsFetch(`${REST}/jadval/main?${key()}`);
      if (r.status === 404) return send(res, 200, { cells: {} });
      if (!r.ok) return send(res, 502, { error: `Firestore o'qish xatosi (${r.status})` });
      const doc = await r.json();
      const raw = doc.fields?.cells?.mapValue?.fields || {};
      const cells = {};
      for (const [k, v] of Object.entries(raw)) {
        if (ALLOWED_KEYS.has(k) && typeof v.stringValue === "string") cells[k] = v.stringValue;
      }
      return send(res, 200, { cells });
    }

    if (req.method === "POST" || req.method === "PUT") {
      const body = await readJson(req).catch(() => ({}));
      const input = body?.cells && typeof body.cells === "object" ? body.cells : {};
      const fields = {};
      for (const k of ALLOWED_KEYS) {
        const v = input[k];
        if (typeof v === "string" && v.trim()) fields[k] = { stringValue: v.trim().slice(0, CELL_MAX) };
      }
      const r = await fsFetch(`${REST}/jadval/main?${key()}`, {
        method: "PATCH",
        body: JSON.stringify({
          fields: {
            cells: { mapValue: { fields } },
            updated_at: { timestampValue: new Date().toISOString() },
          },
        }),
      });
      if (!r.ok) return send(res, 502, { error: `Firestore yozish xatosi (${r.status})` });
      return send(res, 200, { ok: true });
    }

    res.setHeader("Allow", "GET, POST, PUT");
    return send(res, 405, { error: "Faqat GET/POST/PUT" });
  } catch (e) {
    return send(res, 502, { error: String(e.message || e).slice(0, 200) });
  }
}
