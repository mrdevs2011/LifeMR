// api/logout.js: cookie'ni o'chiradi.
import { clearCookie, send } from "./_lib.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return send(res, 405, { error: "Faqat POST" });
  }
  return send(res, 200, { ok: true }, { "Set-Cookie": clearCookie() });
}
