// api/debug.js: environment va dependencies check
// Faqat login qilgan (session cookie bor) holatda ishlaydi — hech qanday qiymat namunasi qaytarilmaydi.

import { requireSession } from "./_lib.js";

export default async function handler(req, res) {
  if (!(await requireSession(req, res))) return;

  res.setHeader("Content-Type", "application/json; charset=utf-8");

  const missing = [];
  const configured = [];

  const vars = [
    "FS_KEY",
    "OWNER_EMAIL",
    "OWNER_PASS_HASH",
    "SESSION_SECRET",
    "CLAUDE_EMAIL",
    "CLAUDE_PASSWORD",
    "MCP_TOKEN",
  ];

  for (const v of vars) {
    if (!process.env[v]) missing.push(v);
    else configured.push(v); // faqat "bor" deb belgilanadi, qiymat yoki uzunlik ko'rsatilmaydi
  }

  res.statusCode = missing.length > 0 ? 400 : 200;
  res.end(
    JSON.stringify({
      status: missing.length > 0 ? "incomplete" : "ok",
      missing,
      configured,
      nodeVersion: process.version,
      timestamp: new Date().toISOString(),
    }, null, 2)
  );
}
