// api/jadval-stream.js: jadval/main hujjatini Server-Sent Events orqali "deyarli realtime" push qiladi.
//
// Nega bu kerak: oldin sayt 1.5 soniyada bir marta o'zi so'rab turardi (poll). Claude jadvalni
// o'zgartirsa, ko'rish uchun o'rtacha ~0.75s, eng yomonida ~1.5s kutish kerak edi.
//
// Bu yerda: aloqa ochiq turadi (SSE), server esa Firestore'ni ancha tezroq (POLL_MS) tekshirib,
// FAQAT hujjat rostdan o'zgarganda (updated_at farq qilsa) push qiladi. Xavfsizlik modeliga
// TEGILMAYDI: brauzer baribir to'g'ridan-to'g'ri Firestore'ga kirmaydi, faqat shu server orqali —
// api/jadval.js bilan bir xil sessiya + IP bloki tekshiruvidan o'tadi. Yangi bog'liqlik (masalan
// Firebase Admin SDK) qo'shilmadi, chin 0ms ham va'da qilinmaydi (tarmoq kechikishi baribir bor) —
// lekin sezilarli kechikish endi yo'q.
//
// Vercel serverless funksiya cheksiz ochiq turolmaydi, shuning uchun har ulanish MAX_MS dan keyin
// o'zi yopiladi; brauzer tarafida (index.html) darhol qayta ulanadi — foydalanuvchi buni sezmaydi.
import { REST, fsFetch, key, requireSession, sessionCookie } from "./_lib.js";

export const config = { maxDuration: 9 };

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat"];
const ROWS = 8;
const ALLOWED_KEYS = new Set();
for (const d of DAYS) for (let i = 1; i <= ROWS; i++) ALLOWED_KEYS.add(`${d}_${i}`);
for (let i = 1; i <= ROWS; i++) { ALLOWED_KEYS.add(`start_${i}`); ALLOWED_KEYS.add(`end_${i}`); }

const POLL_MS = 350; // Firestore'ni shuncha oraliqda tekshiradi (o'qish kvotasi uchun asossiz tez emas)
const MAX_MS = 8500; // shundan keyin ulanishni o'zi yopadi (Vercel limiti ichida, xavfsiz zaxira bilan)
const HEARTBEAT_MS = 15000; // proksi/brauzer ulanishni "o'lik" deb yopib qo'ymasin

async function readCells() {
  const r = await fsFetch(`${REST}/jadval/main?${key()}`);
  if (r.status === 404) return { cells: {}, stamp: "" };
  if (!r.ok) throw new Error(`Firestore o'qish xatosi (${r.status})`);
  const doc = await r.json();
  const raw = doc.fields?.cells?.mapValue?.fields || {};
  const cells = {};
  for (const [k, v] of Object.entries(raw)) {
    if (ALLOWED_KEYS.has(k) && typeof v.stringValue === "string") cells[k] = v.stringValue;
  }
  // updated_at (yoki topilmasa hujjatning o'zi) o'zgarish belgisi sifatida ishlatiladi.
  const stamp = doc.fields?.updated_at?.timestampValue || JSON.stringify(cells);
  return { cells, stamp };
}

const sendJson = (res, status, obj) => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(obj));
};

export default async function handler(req, res) {
  if (!(await requireSession(req, res))) return;
  for (const k of ["FS_KEY", "CLAUDE_EMAIL", "CLAUDE_PASSWORD"]) {
    if (!process.env[k]) return sendJson(res, 500, { error: `${k} sozlanmagan` });
  }
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return sendJson(res, 405, { error: "Faqat GET" });
  }

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // ba'zi proksilar bufferlamasin
  res.setHeader("Set-Cookie", sessionCookie());
  res.flushHeaders?.();
  // Brauzerning o'zi (EventSource) shu ulanish uzilganda avtomatik qayta ulanadi; "retry" bilan
  // standart ~3s o'rniga 300ms dan keyin qaytadan urinishini aytamiz (sezilmasin uchun).
  res.write("retry: 300\n\n");

  let closed = false;
  req.on("close", () => { closed = true; });

  const send = (event, data) => {
    if (closed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const start = Date.now();
  let lastStamp = null;
  let heartbeatAt = Date.now() + HEARTBEAT_MS;

  try {
    // Darhol bitta marta yuboradi (client ulanganda joriy holatni ko'rsin).
    const first = await readCells();
    lastStamp = first.stamp;
    send("cells", { cells: first.cells });

    while (!closed && Date.now() - start < MAX_MS) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      if (closed) break;
      let cur;
      try {
        cur = await readCells();
      } catch {
        continue; // vaqtinchalik xato — keyingi aylanishda qayta urinadi, ulanish uzilmaydi
      }
      if (cur.stamp !== lastStamp) {
        lastStamp = cur.stamp;
        send("cells", { cells: cur.cells });
      }
      if (Date.now() >= heartbeatAt) {
        send("ping", { t: Date.now() });
        heartbeatAt = Date.now() + HEARTBEAT_MS;
      }
    }
  } catch (e) {
    send("error", { error: String(e.message || e).slice(0, 200) });
  } finally {
    if (!closed) res.end();
  }
}
