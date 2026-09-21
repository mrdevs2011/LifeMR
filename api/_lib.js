// api/_lib.js  (pastki chiziq: Vercel buni alohida endpoint qilmaydi, faqat boshqa fayllar import qiladi)
//
// Umumiy qatlam: bitta login, bitta IP hisobi, bitta sessiya.
//   - Sayt (/) va /mcp sahifasi AYNAN BIR XIL authenticate() dan o'tadi.
//   - IP hisobi butun domen uchun bitta: `ipguard/{sha256(ip)}` (sahifaga bog'liq emas).
//   - 3 ta noto'g'ri urinish 5 DAQIQA ichida bo'lsa, IP vaqtincha bloklanadi. Urinishlar orasi 5 daqiqadan
//     oshsa, eskisi hisobdan chiqadi (sirpanuvchi oyna).
//   - Blok muddati QAT'IY jadvaldan olinadi (BLOCK_STEPS): 30 soniya, 1, 3, 10 daqiqa, 1.5 soat ... 1000 yil.
//     Har 3 ta xato = jadvaldagi keyingi qator. Jadval tugagach (1000 yillik blok o'tgach) IP endi HECH QACHON
//     bloklanmaydi: eshik ochiq, limit yo'q. Muvaffaqiyatli login darajani 0 ga qaytaradi (limitsiz holatdan tashqari).
//   - Email: kiritilgani va env'dagi OWNER_EMAIL SHA-256 qilinib vaqt-xavfsiz solishtiriladi.
//   - Parol: scrypt hash (env OWNER_PASS_HASH) bilan tekshiriladi. Parolning o'zi hech qayerda saqlanmaydi.
//   - Sessiya: imzolangan (HMAC) httpOnly cookie. Brauzerda localStorage/IndexedDB ishlatilmaydi.
//
// Env: FS_KEY, OWNER_EMAIL, OWNER_PASS_HASH, SESSION_SECRET, CLAUDE_EMAIL, CLAUDE_PASSWORD, MCP_TOKEN

import { createHash, createHmac, scrypt, timingSafeEqual } from "node:crypto";

export const PROJECT_ID = "mrabout";
export const MAX_FAILS = 3;
export const WINDOW_MS = 5 * 60_000;
export const SESSION_MS = 7 * 24 * 3600_000;
const MAX_LEVEL = 50;

// Blok muddatlari (QAT'IY jadval). Har 3 ta xatodan keyin keyingi qator ishlatiladi. Jadval tugagach (oxirgi blok o'tgach) blok yo'q.
// Qiymatni o'zgartirish uchun shu qatorlarni tahrirla (muddat hech qachon kamaymasin). Oy = 30 kun, yil = 365 kun.
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;
export const BLOCK_STEPS = [
  [30_000, "30 soniya"],
  [1 * MIN, "1 daqiqa"],
  [3 * MIN, "3 daqiqa"],
  [10 * MIN, "10 daqiqa"],
  [1.5 * HOUR, "1.5 soat"],
  [3 * HOUR, "3 soat"],
  [9 * HOUR, "9 soat"],
  [1.5 * DAY, "1.5 kun"],
  [3 * DAY, "3 kun"],
  [9 * DAY, "9 kun"],
  [1 * MONTH, "1 oy"],
  [3 * MONTH, "3 oy"],
  [6 * MONTH, "6 oy"],
  [1 * YEAR, "1 yil"],
  [2 * YEAR, "2 yil"],
  [4 * YEAR, "4 yil"],
  [10 * YEAR, "10 yil"],
  [100 * YEAR, "100 yil"],
  [1000 * YEAR, "1000 yil"],
];
// Firestore timestamp 0001..9999 yil oralig'ida bo'lishi shart (undan oshsa yozuv rad etiladi va login 503 beradi).
// Eng uzun blok (1000 yil) bundan ancha oldin tugaydi, bu faqat himoya chegarasi.
const MAX_UNTIL_MS = Date.UTC(9999, 11, 31);

// level = shu IP'ga hozirgacha qo'yilgan bloklar soni (0 -> birinchi blok).
// level jadval uzunligiga yetgach (oxirgi, 1000 yillik blok ham o'tgach) IP limitsiz: bloklanmaydi, urinishlar sanalmaydi.
export const blockDurationMs = (level) => BLOCK_STEPS[Math.max(0, level)]?.[0] ?? null;
export const isUnlimited = (level) => level >= BLOCK_STEPS.length;

// ---------------------------------------------------------------------------
// Kichik yordamchilar
// ---------------------------------------------------------------------------
export function send(res, status, obj, headers = {}) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(obj));
}

export function clientIp(req) {
  const xf = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xf || req.socket?.remoteAddress || "unknown";
}

export async function readJson(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === "string") return JSON.parse(req.body);
    if (Buffer.isBuffer(req.body)) return JSON.parse(req.body.toString("utf8"));
    return req.body;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

const sha = (v) => createHash("sha256").update(String(v).trim().toLowerCase()).digest();
const ipKey = (ip) => String(ip || "unknown").trim();

// ---------------------------------------------------------------------------
// Parol (scrypt) va email (hash) tekshiruvi
// ---------------------------------------------------------------------------
function scryptAsync(password, salt, len) {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, len, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? reject(e) : resolve(k)))
  );
}

// Format: scrypt$<salt hex>$<hash hex>   (tools/hash-password.mjs shuni yaratadi)
export async function hashPassword(password, saltHex) {
  const salt = Buffer.from(saltHex, "hex");
  const key = await scryptAsync(String(password).normalize("NFKC"), salt, 64);
  return `scrypt$${saltHex}$${key.toString("hex")}`;
}

async function verifyPassword(password, stored) {
  const parts = String(stored || "").split("$");
  // Tuzilmasa ham scrypt ishlaydi (vaqt farqi sizib chiqmasin), natija baribir false.
  const valid = parts.length === 3 && parts[0] === "scrypt";
  const saltHex = valid ? parts[1] : "00".repeat(16);
  const got = await scryptAsync(String(password).normalize("NFKC"), Buffer.from(saltHex, "hex"), 64);
  if (!valid) return false;
  const want = Buffer.from(parts[2], "hex");
  return want.length === got.length && timingSafeEqual(want, got);
}

// Email va parol HAR DOIM ikkalasi ham hisoblanadi: qaysi biri xato ekanini javob tezligidan bilib bo'lmasin.
async function credentialsOk(email, password) {
  const emailOk = timingSafeEqual(sha(email), sha(process.env.OWNER_EMAIL || ""));
  const passOk = await verifyPassword(password, process.env.OWNER_PASS_HASH);
  return emailOk && passOk;
}

// ---------------------------------------------------------------------------
// Claude akkaunti bilan Firestore (IP hisobi va yozuvlar uchun)
// ---------------------------------------------------------------------------
const DOCS = `projects/${PROJECT_ID}/databases/(default)/documents`;
export const REST = `https://firestore.googleapis.com/v1/${DOCS}`;
export const DOCS_PATH = DOCS;
const tokenCache = { token: null, exp: 0 };

async function getIdToken() {
  if (tokenCache.token && Date.now() < tokenCache.exp) return tokenCache.token;
  const r = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${process.env.FS_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: process.env.CLAUDE_EMAIL,
        password: process.env.CLAUDE_PASSWORD,
        returnSecureToken: true,
      }),
    }
  );
  if (!r.ok) throw new Error(`Firebase (Claude akkaunti) login xatosi: HTTP ${r.status}`);
  const d = await r.json();
  if (!d.idToken) throw new Error("Firebase login: idToken qaytmadi");
  tokenCache.token = d.idToken;
  tokenCache.exp = Date.now() + Math.max(60, Number(d.expiresIn || 3600) - 120) * 1000;
  return d.idToken;
}

export async function fsFetch(url, opts = {}, retried = false) {
  const t = await getIdToken();
  const r = await fetch(url, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}), Authorization: `Bearer ${t}` },
  });
  if ((r.status === 401 || r.status === 403) && !retried) {
    tokenCache.token = null;
    tokenCache.exp = 0;
    return fsFetch(url, opts, true);
  }
  return r;
}

export const key = () => `key=${process.env.FS_KEY}`;

// ---------------------------------------------------------------------------
// IP guard: Firestore (asosiy) + xotira (zaxira)
// Hujjat: ipguard/{id} = { hits: [timestamp...], blocked: bool, ts, level: int, until: timestamp|null }
// blocked=true va until o'tmagan bo'lsa bloklangan. until yo'q (eski hujjat) bo'lsa doimiy blok, qo'lda ochiladi.
// Har urinish TEKSHIRUVDAN OLDIN yoziladi (pre-charge), shuning uchun parallel so'rovlar bilan
// 3 tadan ko'p parolni sinab bo'lmaydi. Yozuv optimistik qulf (updateTime) bilan, poyga bo'lmaydi.
// ---------------------------------------------------------------------------
const parseDoc = (d) => ({
  blocked: d?.fields?.blocked?.booleanValue === true,
  hits: (d?.fields?.hits?.arrayValue?.values || []).map((v) => Date.parse(v.timestampValue)).filter(Number.isFinite),
  level: Math.max(0, Math.min(MAX_LEVEL, Number(d?.fields?.level?.integerValue) || 0)),
  until: d?.fields?.until?.timestampValue ? Date.parse(d.fields.until.timestampValue) : null,
  updateTime: d?.updateTime || null,
});

// Hozir bloklanganmi? (blok muddati tugagan bo'lsa, blocked=true qolsa ham ochiq)
const isActiveBlock = (g, now) => g.blocked && (g.until === null || !Number.isFinite(g.until) || g.until > now);

async function fsReadGuard(id) {
  const r = await fsFetch(`${REST}/ipguard/${id}?${key()}`);
  if (r.status === 404) return { blocked: false, hits: [], level: 0, until: null, updateTime: null };
  if (!r.ok) throw new Error(`guard get ${r.status}`);
  return parseDoc(await r.json());
}

async function fsWriteGuard(id, state, updateTime) {
  const nowIso = new Date().toISOString();
  const r = await fsFetch(`${REST}:commit?${key()}`, {
    method: "POST",
    body: JSON.stringify({
      writes: [{
        update: {
          name: `${DOCS}/ipguard/${id}`,
          fields: {
            hits: { arrayValue: { values: state.hits.map((t) => ({ timestampValue: new Date(t).toISOString() })) } },
            blocked: { booleanValue: state.blocked },
            level: { integerValue: String(state.level || 0) },
            until: state.until ? { timestampValue: new Date(state.until).toISOString() } : { nullValue: null },
            ts: { timestampValue: nowIso },
          },
        },
        currentDocument: updateTime ? { updateTime } : { exists: false },
      }],
    }),
  });
  if (r.ok) return true;
  const e = await r.json().catch(() => ({}));
  const st = String(e?.error?.status || "");
  if (r.status === 409 || st === "ABORTED" || st === "FAILED_PRECONDITION" || st === "ALREADY_EXISTS") return false;
  throw new Error(`guard write ${r.status}`);
}

const fsGuard = {
  async peek(id) {
    return isActiveBlock(await fsReadGuard(id), Date.now());
  },
  async charge(id) {
    for (let i = 0; i < 6; i++) {
      const cur = await fsReadGuard(id);
      const now = Date.now();
      if (isActiveBlock(cur, now)) return { blocked: true, until: cur.until };
      // Barcha bloklar o'tgan: eshik ochiq, hisob yuritilmaydi va hech narsa yozilmaydi.
      if (isUnlimited(cur.level)) return { blocked: false, unlimited: true };
      // Blok tugagan (yoki umuman bo'lmagan): hisob noldan. Daraja (level) saqlanadi.
      const hits = cur.blocked ? [] : cur.hits.filter((t) => t > now - WINDOW_MS);
      const count = hits.length + 1;
      let state;
      if (count >= MAX_FAILS) {
        const until = Math.min(now + blockDurationMs(cur.level), MAX_UNTIL_MS);
        state = { hits: [], blocked: true, level: Math.min(cur.level + 1, MAX_LEVEL), until };
      } else {
        state = { hits: [...hits, now], blocked: false, level: cur.level, until: null };
      }
      if (await fsWriteGuard(id, state, cur.updateTime)) return { blocked: false, count };
    }
    return { contended: true };
  },
  async reset(id) {
    for (let i = 0; i < 6; i++) {
      const cur = await fsReadGuard(id);
      // Limitsiz holat doimiy: to'g'ri login uni bekor qilmaydi (level saqlanadi).
      const level = isUnlimited(cur.level) ? cur.level : 0;
      if (await fsWriteGuard(id, { hits: [], blocked: false, level, until: null }, cur.updateTime)) return;
    }
  },
};

const guardReady = () => Boolean(process.env.FS_KEY && process.env.CLAUDE_EMAIL && process.env.CLAUDE_PASSWORD);

// FAIL-CLOSED: xotiradagi zaxira yo'q. Sabab: Vercel serverless'da instance har safar
// yangilanishi mumkin, shuning uchun xotiradagi hisob ishonchli emas — u orqali IP bloki
// "unutilib" ketishi mumkin edi. Shuning uchun Firestore ishlamasa yoki sozlanmagan bo'lsa,
// login butunlay TO'XTATILADI (503), zaif himoya bilan davom etishdan ko'ra.
async function guardCall(method, id, ...a) {
  if (!guardReady()) throw new Error("guard_not_configured");
  return fsGuard[method](id, ...a);
}

// Faqat sahifada formani ko'rsatish/berkitish uchun ishlatiladi (kosmetik).
// Xato bo'lsa "blocked emas" deb hisoblaydi — haqiqiy tekshiruv authenticate() ichida,
// u yerda xato bo'lsa kirish 503 bilan to'xtatiladi (pastga qara).
export async function isBlocked(req) {
  try {
    return Boolean(await guardCall("peek", ipKey(clientIp(req))));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Login vaqti: bitta doimiy hujjat, ikkita qat'iy maydon (before/now).
// Har muvaffaqiyatli login'da: eski "now" -> "before" bo'ladi, "now" hozirgi vaqt bo'ladi.
// Yangi hujjat yaratilmaydi, massiv o'smaydi — hujjat har doim shu ikki maydonni saqlaydi.
// ---------------------------------------------------------------------------
export async function recordLogin() {
  try {
    const cur = await fsFetch(`${REST}/meta/login?${key()}`);
    const beforeField = cur.ok ? (await cur.json())?.fields?.now || { nullValue: null } : { nullValue: null };
    await fsFetch(`${REST}:commit?${key()}`, {
      method: "POST",
      body: JSON.stringify({
        writes: [{
          update: {
            name: `${DOCS}/meta/login`,
            fields: {
              before: beforeField,
              now: { timestampValue: new Date().toISOString() },
            },
          },
        }],
      }),
    });
  } catch {
    /* yozib bo'lmasa ham login to'xtamasin, bu faqat statistika */
  }
}


// Qaytaradi: { ok:true } | { status, body }
// ---------------------------------------------------------------------------
export async function authenticate(req, email, password) {
  for (const k of ["OWNER_EMAIL", "OWNER_PASS_HASH"]) {
    if (!process.env[k]) return { status: 500, body: { error: `${k} sozlanmagan` } };
  }
  if (typeof email !== "string" || typeof password !== "string" || !email.trim() || !password) {
    return { status: 400, body: { error: "email va parol kerak" } };
  }
  if (password.length > 512 || email.length > 320) return { status: 400, body: { error: "noto'g'ri so'rov" } };

  const id = ipKey(clientIp(req));
  let c;
  try {
    c = await guardCall("charge", id);
  } catch (e) {
    // Firestore ishlamayapti / sozlanmagan — himoyasiz qoldirishdan ko'ra login'ni to'xtatamiz.
    // Sabab faqat server logiga yoziladi (Vercel -> Logs), mijozga ko'rsatilmaydi.
    console.error("[guard]", String(e?.message || e));
    return { status: 503, body: { error: "vaqtincha_ishlamayapti" } };
  }
  if (c.blocked) return { status: 403, body: { error: "bloklangan" } };
  if (c.contended) return { status: 429, body: { error: "juda_kop_urinish", retry_after_sec: 5 } };

  if (await credentialsOk(email, password)) {
    try {
      await guardCall("reset", id);
    } catch {
      /* muhim emas: reset o'tmasa keyingi urinish hisobi biroz noaniq bo'ladi, xavfsizlikka ta'sir yo'q */
    }
    return { ok: true };
  }
  if (c.unlimited) return { status: 401, body: { error: "notogri_parol", unlimited: true } };
  const left = MAX_FAILS - c.count;
  if (left <= 0) return { status: 403, body: { error: "bloklangan" } };
  return { status: 401, body: { error: "notogri_parol", attempts_left: left } };
}

// ---------------------------------------------------------------------------
// Sessiya cookie (HMAC imzo)
// ---------------------------------------------------------------------------
const sign = (exp) => createHmac("sha256", process.env.SESSION_SECRET || "").update(String(exp)).digest("hex");

export function sessionCookie() {
  const exp = Date.now() + SESSION_MS;
  return `${COOKIE}=${exp}.${sign(exp)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_MS / 1000}`;
}

export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

export function hasSession(req) {
  if (!process.env.SESSION_SECRET) return false;
  const raw = String(req.headers.cookie || "")
    .split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(`${COOKIE}=`));
  if (!raw) return false;
  const [exp, sig] = raw.slice(COOKIE.length + 1).split(".");
  if (!/^\d+$/.test(exp || "") || Number(exp) < Date.now() || !sig) return false;
  const want = Buffer.from(sign(exp), "hex");
  const got = Buffer.from(sig, "hex");
  return want.length === got.length && timingSafeEqual(want, got);
}
