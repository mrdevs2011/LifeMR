// api/download-status/[timestamp].js
//
// Dynamic route: /api/download-status/1726673100?pass=mr07110.github.io
// [timestamp] — path parametr (keshni sindirish uchun ishlatiladi)
// pass — query parametr (avtorizatsiya)

import crypto from "crypto";

const FIREBASE_PROJECT_ID = "mrabout";
const FIREBASE_API_KEY = "AIzaSyAvvkcbKlbrplbh29m2MmVfiypvlGAEglg";
const AUTH_URL = `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`;
const BASE_DOCS_URL = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;

async function getIdToken() {
  const res = await fetch(AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ returnSecureToken: true }),
  });
  if (!res.ok) throw new Error(`auth xato: ${res.status}`);
  const data = await res.json();
  return data.idToken;
}

function sha256Hex(str) {
  return crypto.createHash("sha256").update(str, "utf8").digest("hex");
}

export default async function handler(req, res) {
  // Path parametr: req.query.timestamp
  // const timestamp = req.query.timestamp;

  try {
    const idToken = await getIdToken();

    // Parol tekshiruvi (joriy mantiq to‘liq saqlangan)
    const configRes = await fetch(
      `${BASE_DOCS_URL}/config/access?key=${FIREBASE_API_KEY}`,
      { headers: { Authorization: `Bearer ${idToken}` } }
    );
    if (configRes.ok) {
      const configData = await configRes.json();
      const correctHash = configData?.fields?.hash?.stringValue;
      if (correctHash) {
        const pass = req.query.pass;
        if (!pass || sha256Hex(pass) !== correctHash) {
          res.status(401).json({ xato: "parol noto'g'ri yoki yo'q. ?pass=... qo'sh" });
          return;
        }
      }
    }

    const docsRes = await fetch(
      `${BASE_DOCS_URL}/checkins?key=${FIREBASE_API_KEY}&orderBy=timestamp%20desc&pageSize=300`,
      { headers: { Authorization: `Bearer ${idToken}` } }
    );
    if (!docsRes.ok) {
      res.status(502).json({ xato: `Firestore xato: ${docsRes.status}` });
      return;
    }
    const data = await docsRes.json();
    const docs = data.documents || [];

    const checkins = docs.map((d) => {
      const f = d.fields || {};
      return {
        vaqt: f.vaqt?.stringValue || "",
        holat: f.holat?.stringValue || "",
      };
    });

    // Keshni to‘liq o‘chirish
    res.setHeader(
      "Cache-Control",
      "no-store, no-cache, must-revalidate, proxy-revalidate"
    );
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.status(200).json({ checkins });
  } catch (e) {
    res.status(500).json({ xato: String(e) });
  }
}
