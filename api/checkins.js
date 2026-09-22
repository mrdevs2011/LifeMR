// api/checkins.js: sayt yozuvlarini o'qish/yozish/o'chirish. Faqat sessiya cookie bilan.
// Server Firestore'ga Claude akkaunti bilan boradi (rules faqat shu UID'ga ruxsat beradi).
import { REST, DOCS_PATH, fsFetch, key, requireSession, readJson, send, sessionCookie } from "./_lib.js";

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
  // Sessiya + IP bloki: bloklangan IP'dan keladigan so'rov (boshqa qurilma ham) 403 oladi.
  if (!(await requireSession(req, res))) return;
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
      const url = new URL(req.url, "http://x");
      const wantDeleted = url.searchParams.get("deleted") === "1";
      const collectionId = wantDeleted ? "deleted" : "checkins";
      const orderField = wantDeleted ? "deleted_at" : "timestamp";
      const r = await fsFetch(`${REST}:runQuery?${key()}`, {
        method: "POST",
        body: JSON.stringify({
          structuredQuery: {
            from: [{ collectionId }],
            orderBy: [{ field: { fieldPath: orderField }, direction: "DESCENDING" }],
            limit: LIMIT,
          },
        }),
      });
      if (!r.ok) return send(res, 502, { error: `Firestore o'qish xatosi (${r.status})` });
      const rows = await r.json();
      const items = (Array.isArray(rows) ? rows : [])
        .filter((x) => x.document)
        .map((x) => ({
          id: String(x.document.name || "").split("/").pop(),
          vaqt: x.document.fields?.vaqt?.stringValue || "",
          holat: x.document.fields?.holat?.stringValue || "",
          ts: x.document.fields?.timestamp?.timestampValue || null,
          deletedAt: x.document.fields?.deleted_at?.timestampValue || null,
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

    if (req.method === "DELETE") {
      const body = await readJson(req).catch(() => ({}));
      const id = typeof body?.id === "string" ? body.id.trim() : "";
      if (!id || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return send(res, 400, { error: "id noto'g'ri" });

      const got = await fsFetch(`${REST}/checkins/${id}?${key()}`);
      if (got.status === 404) return send(res, 404, { error: "topilmadi (allaqachon o'chirilgan bo'lishi mumkin)" });
      if (!got.ok) return send(res, 502, { error: `Firestore o'qish xatosi (${got.status})` });
      const doc = await got.json();
      const fields = doc.fields || {};

      const commit = await fsFetch(`${REST}:commit?${key()}`, {
        method: "POST",
        body: JSON.stringify({
          writes: [
            {
              update: {
                name: `${DOCS_PATH}/deleted/${id}`,
                fields: {
                  vaqt: fields.vaqt || { stringValue: "" },
                  holat: fields.holat || { stringValue: "" },
                  timestamp: fields.timestamp || { timestampValue: new Date().toISOString() },
                  deleted_at: { timestampValue: new Date().toISOString() },
                },
              },
            },
            { delete: `${DOCS_PATH}/checkins/${id}` },
          ],
        }),
      });
      if (!commit.ok) return send(res, 502, { error: `Firestore o'chirish xatosi (${commit.status})` });
      return send(res, 200, { ok: true, id });
    }

    res.setHeader("Allow", "GET, POST, DELETE");
    return send(res, 405, { error: "Faqat GET/POST/DELETE" });
  } catch (e) {
    return send(res, 502, { error: String(e.message || e).slice(0, 200) });
  }
}
