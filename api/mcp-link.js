// api/mcp-link.js
//
// /mcp sahifasi uchun: parolni SERVER tomonda tekshiradi va to'g'ri bo'lsa connector URL'ini qaytaradi.
//   POST /api/mcp-link   body: { "password": "..." }   ->   { url, mode }
//
// URL'dagi k = Vercel env MCP_TOKEN (majburiy: maxfiy, parolga bog'liq emas)
//
// Maxfiy qiymat (token) brauzerga faqat parol to'g'ri kiritilgach yuboriladi.

import crypto from "crypto";
import { fetchConfigHash, safeEqual } from "./mcp.js";

const MAX_FAILS = 5;
const LOCKOUT_MS = 60_000;
const attempts = new Map(); // ip -> { fails, until }  (serverless: deploy/instance'da reset bo'ladi)

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

  const ip = clientIp(req);
  const rec = attempts.get(ip) || { fails: 0, until: 0 };
  const wait = rec.until - Date.now();
  if (wait > 0) {
    return send(res, 429, { error: "juda_kop_urinish", retry_after_sec: Math.ceil(wait / 1000) });
  }

  let password;
  try {
    const body = await readJson(req);
    password = typeof body?.password === "string" ? body.password : "";
  } catch {
    return send(res, 400, { error: "noto'g'ri so'rov" });
  }
  if (!password) return send(res, 400, { error: "parol kerak" });

  let configHash;
  try {
    configHash = await fetchConfigHash();
  } catch (e) {
    return send(res, 500, { error: `Config xatosi: ${e.message}` });
  }
  if (!configHash) return send(res, 500, { error: "parol_ornatilmagan" });

  const candidate = crypto.createHash("sha256").update(password).digest("hex");
  if (!safeEqual(candidate, configHash)) {
    rec.fails += 1;
    if (rec.fails >= MAX_FAILS) { rec.fails = 0; rec.until = Date.now() + LOCKOUT_MS; }
    attempts.set(ip, rec);
    return send(res, 401, { error: "notogri_parol" });
  }
  attempts.delete(ip);

  const token = process.env.MCP_TOKEN;
  const proto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const url = `${proto}://${host}/api/mcp?k=${token}`;
  return send(res, 200, { url, mode: "token" });
}
