// api/mcp-link.js
//
// /mcp sahifasi uchun: parolni Firebase Auth orqali SERVER tomonda tekshiradi va to'g'ri bo'lsa
// connector URL'ini qaytaradi.
//   POST /api/mcp-link   body: { "password": "..." }   ->   { url }
//
// Parol = OWNER_EMAIL akkauntining Firebase paroli (sening saytga kirish parolingning o'zi).
// URL'dagi k = Vercel env MCP_TOKEN. Token brauzerga faqat parol to'g'ri bo'lgandan keyin yuboriladi.
//
// Env: FS_KEY, MCP_TOKEN, OWNER_EMAIL

import { createHash, timingSafeEqual } from "node:crypto";

const MAX_FAILS = 5;
const LOCKOUT_MS = 60_000;
const attempts = new Map(); // ip -> { fails, until }  (serverless: instance'da reset bo'ladi, Firebase'ning o'z limiti ham bor)

// Email ikki tomonda ham SHA-256 hash qilinib, vaqt-xavfsiz solishtiriladi (oddiy === emas).
const sha = (v) => createHash("sha256").update(String(v).trim().toLowerCase()).digest();
const sameEmail = (a, b) => timingSafeEqual(sha(a), sha(b));

function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(obj));
}

function clientIp(req) {
  const xf = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xf || req.socket?.remoteAddress || "unknown";
}

async function readJson(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === "string") return JSON.parse(req.body);
    if (Buffer.isBuffer(req.body)) return JSON.parse(req.body.toString("utf8"));
    return req.body;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return send(res, 405, { error: "Faqat POST" });
  }
  if (!process.env.FS_KEY) return send(res, 500, { error: "FS_KEY sozlanmagan" });
  if (!process.env.MCP_TOKEN) return send(res, 500, { error: "MCP_TOKEN sozlanmagan" });
  if (!process.env.OWNER_EMAIL) return send(res, 500, { error: "OWNER_EMAIL sozlanmagan" });

  const ip = clientIp(req);
  const rec = attempts.get(ip) || { fails: 0, until: 0 };
  const wait = rec.until - Date.now();
  if (wait > 0) {
    return send(res, 429, { error: "juda_kop_urinish", retry_after_sec: Math.ceil(wait / 1000) });
  }

  let password, email;
  try {
    const body = await readJson(req);
    password = typeof body?.password === "string" ? body.password : "";
    email = typeof body?.email === "string" ? body.email : "";
  } catch {
    return send(res, 400, { error: "noto'g'ri so'rov" });
  }
  if (!password || !email) return send(res, 400, { error: "email va parol kerak" });

  // Kiritilgan email hash'i env'dagi email hash'i bilan solishtiriladi. Mos kelmasa Firebase'ga bormaymiz;
  // xato xabari parol xatosi bilan bir xil (email sizib chiqmasin).
  if (!sameEmail(email, process.env.OWNER_EMAIL)) {
    rec.fails += 1;
    if (rec.fails >= MAX_FAILS) { rec.fails = 0; rec.until = Date.now() + LOCKOUT_MS; }
    attempts.set(ip, rec);
    return send(res, 401, { error: "notogri_parol" });
  }

  let r;
  try {
    r = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${process.env.FS_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: process.env.OWNER_EMAIL, password, returnSecureToken: false }),
      }
    );
  } catch {
    return send(res, 502, { error: "Firebase bilan bog'lanib bo'lmadi" });
  }

  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    const msg = String(e?.error?.message || "");
    if (msg.startsWith("TOO_MANY_ATTEMPTS")) {
      return send(res, 429, { error: "juda_kop_urinish", retry_after_sec: 60 });
    }
    if (r.status >= 500) return send(res, 502, { error: "Firebase xatosi" });
    rec.fails += 1;
    if (rec.fails >= MAX_FAILS) { rec.fails = 0; rec.until = Date.now() + LOCKOUT_MS; }
    attempts.set(ip, rec);
    return send(res, 401, { error: "notogri_parol" });
  }
  attempts.delete(ip);

  const proto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return send(res, 200, { url: `${proto}://${host}/api/mcp?k=${process.env.MCP_TOKEN}` });
}
