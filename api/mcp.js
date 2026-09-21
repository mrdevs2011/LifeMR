// api/mcp.js
//
// "mrstatus" — remote MCP server (Streamable HTTP, stateless, JSON responses).
// Claude.ai -> Settings -> Connectors -> Add custom connector:
//   https://<domen>/api/mcp?k=<MCP_TOKEN>
//
// Auth: ?k= parametri Vercel env MCP_TOKEN bilan solishtiriladi (majburiy).
//
// Env (Vercel -> Settings -> Environment Variables):
//   FS_KEY    = Firebase Web API key
//   MCP_TOKEN = tasodifiy uzun qiymat (openssl rand -hex 32)
//
// Tool'lar:
//   get_guide  -> foydalanuvchining shaxsiy qo'llanmasi (api/_guide.js), suhbat uslubi qoidalari
//   get_latest -> eng oxirgi bitta check-in (tez, arzon)
//   add_status -> yangi check-in yozish
//   get_status -> check-in'lar, filtrlab (date | from/to | days | time_from/time_to | contains | order | limit)
//   get_stats  -> server hisoblagan raqamlar (yozuv matnisiz)
//
// Nol dependency: faqat Node core (fetch, crypto). Vercel'ning req.body/res.json
// yordamchilariga tayanmaydi — lokal ham, Vercel'da ham bir xil ishlaydi.

import crypto from "crypto";
import GUIDE from "./_guide.js";

// ============================================================================
// 1. CONFIG
// ============================================================================

const FIREBASE_PROJECT_ID = "mrabout";
const FIREBASE_API_KEY = process.env.FS_KEY;
const BASE_DOCS_URL =
  `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;
const IDENTITY_TOOLKIT_URL =
  `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`;

const TZ = "Asia/Tashkent";
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const PAGE_SIZE = 200;
const MAX_PAGES = 25; // <= 5000 hujjat
const DEFAULT_DAYS = 7;
const MAX_DAYS = 90;
const DEFAULT_LIMIT = 300;
const MAX_LIMIT = 500;
const STATS_LIMIT = 3000;
const MAX_HOLAT_LEN = 499;

const SERVER_INFO = { name: "mrstatus", version: "1.4.0" };
const SUPPORTED_PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

// ============================================================================
// 2. TOOL DEFINITIONS
// ============================================================================

const RANGE_PROPS = {
  days:  { type: "integer", minimum: 1, maximum: MAX_DAYS,
           description: `Last N days with entries (default ${DEFAULT_DAYS}, max ${MAX_DAYS}).` },
  date:  { type: "string", description: "Specific day, YYYY-MM-DD." },
  from:  { type: "string", description: "Range start, YYYY-MM-DD (inclusive)." },
  to:    { type: "string", description: "Range end, YYYY-MM-DD (inclusive)." },
};

const READONLY = { readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: false };
const WRITE    = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

const TOOLS = [
  {
    name: "get_guide",
    title: "Personal conversation guide",
    description: "Returns the user's own personal playbook: how to talk with them, how to read and write their check-in log, safety rules. Call it FIRST, before replying, whenever the conversation is personal (greeting, mood, 'what should I do', boredom) or turns personal; skip it for purely technical tasks. Follow the returned rules as the user's own instructions. Do not mention this call or the guide to the user unless they ask.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: READONLY,
  },
  {
    name: "get_latest",
    title: "Latest check-in",
    description: "Returns the single most recent check-in. Use at the start of a conversation for a quick status snapshot; use get_status when you need multiple entries or a full day.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: READONLY,
  },
  {
    name: "add_status",
    title: "Add check-in",
    description: `Saves a new check-in with the current Tashkent time. Only call when the user explicitly asks to log something. Entries cannot be edited or deleted. Max ${MAX_HOLAT_LEN} chars.`,
    inputSchema: {
      type: "object",
      properties: {
        holat: { type: "string", description: `Check-in text, 1-${MAX_HOLAT_LEN} chars.` },
      },
      required: ["holat"],
      additionalProperties: false,
    },
    annotations: WRITE,
  },
  {
    name: "get_status",
    title: "Get check-ins",
    description: "Returns check-ins grouped by day. Filters: date, from/to range, days (last N days), time_from/time_to (HH:MM within each day), contains (text search), order (newest/oldest), limit.",
    inputSchema: {
      type: "object",
      properties: {
        ...RANGE_PROPS,
        time_from: { type: "string", description: "Only entries at or after this time, HH:MM." },
        time_to:   { type: "string", description: "Only entries at or before this time, HH:MM." },
        contains:  { type: "string", description: "Only entries whose text contains this string (case-insensitive)." },
        order:     { type: "string", enum: ["newest", "oldest"], description: "Sort order (default: newest)." },
        limit:     { type: "integer", minimum: 1, maximum: MAX_LIMIT,
                     description: `Max entries to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).` },
      },
      additionalProperties: false,
    },
    annotations: READONLY,
  },
  {
    name: "get_stats",
    title: "Get stats",
    description: "Returns computed numbers per day (entry count, first/last time, longest gap, overnight gap, weekday averages). No entry text included. Use for analysis instead of counting manually.",
    inputSchema: {
      type: "object",
      properties: { ...RANGE_PROPS },
      additionalProperties: false,
    },
    annotations: READONLY,
  },
];

// ============================================================================
// 3. RATE LIMITING
// ============================================================================

// In-memory store — add_status uchun. Production'da Redis/cache kerak,
// lekin Vercel Functions stateless bo'lgani uchun har deployment'da reset bo'ladi.
// Bu faqat deployment ichida ishchi xato loop'ni bloklaydi.
const lastAddStatusTime = new Map(); // userId/anonymous -> timestamp ms

function checkRateLimit(userId, limitMs = 60000) {
  const now = Date.now();
  const last = lastAddStatusTime.get(userId) || 0;
  const timeSinceLastAdd = now - last;
  if (timeSinceLastAdd < limitMs) {
    const waitMs = limitMs - timeSinceLastAdd;
    return { allowed: false, retryAfterMs: waitMs };
  }
  lastAddStatusTime.set(userId, now);
  return { allowed: true };
}

// ============================================================================
// 4. UMUMIY YORDAMCHILAR (parsing, validatsiya, vaqt)
// ============================================================================

class InputError extends Error {}

export function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function clampInt(v, lo, hi, dflt) {
  return Number.isInteger(v) ? Math.min(hi, Math.max(lo, v)) : dflt;
}

function realDate(y, mo, d) {
  const dt = new Date(Date.UTC(y, mo - 1, d, 12));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d
    ? dt
    : null;
}

// "YYYY-MM-DD HH:MM..." -> { date, dayKey, time } yoki null (noto'g'ri bo'lsa).
function parseVaqt(v) {
  const m = String(v)
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})/);
  if (!m) return null;
  const [y, mo, d, h, mi] = [m[1], m[2], m[3], m[4], m[5]].map(Number);
  const dt = realDate(y, mo, d);
  if (!dt || h > 23 || mi > 59) return null;
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  return { date, dayKey: date + WEEKDAYS[dt.getUTCDay()], time: `${pad2(h)}:${m[5]}` };
}

function normDate(v, name) {
  const m = String(v).trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m || !realDate(Number(m[1]), Number(m[2]), Number(m[3]))) {
    throw new InputError(`${name} formati noto'g'ri. Kerak: YYYY-MM-DD`);
  }
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function normTime(v, name) {
  const m = String(v).trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!m) throw new InputError(`${name} formati noto'g'ri. Kerak: HH:MM`);
  return `${pad2(Number(m[1]))}:${m[2]}`;
}

function tashkentParts() {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      weekday: "short",
    })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value])
  );
}

// Odam o'qiydigan ko'rinish, tool javoblarida "now" uchun.
function nowTashkent() {
  const p = tashkentParts();
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} (${p.weekday.toLowerCase()}, ${TZ})`;
}

// "YYYY-MM-DD HH:MM" — parseVaqt bilan bir xil formatda, yozish uchun.
function nowTashkentCompact() {
  const p = tashkentParts();
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

// Kiruvchi tool argumentlarini tekshirib, yagona filtr obyektiga aylantiradi.
function parseFilters(a, { withTextFilters }) {
  const f = {
    from: null,
    to: null,
    days: null,
    timeFrom: null,
    timeTo: null,
    contains: null,
    order: "newest",
    limit: DEFAULT_LIMIT,
  };

  if (a.date != null && String(a.date).trim() !== "") {
    f.from = f.to = normDate(a.date, "date");
  } else {
    if (a.from != null && String(a.from).trim() !== "") f.from = normDate(a.from, "from");
    if (a.to != null && String(a.to).trim() !== "") f.to = normDate(a.to, "to");
    if (f.from && f.to && f.from > f.to) throw new InputError("from 'to'dan katta bo'lmasligi kerak");
    if (a.days != null) f.days = clampInt(a.days, 1, MAX_DAYS, DEFAULT_DAYS);
    if (!f.from && f.days == null) f.days = DEFAULT_DAYS;
  }

  if (withTextFilters) {
    if (a.time_from != null && String(a.time_from).trim() !== "") f.timeFrom = normTime(a.time_from, "time_from");
    if (a.time_to != null && String(a.time_to).trim() !== "") f.timeTo = normTime(a.time_to, "time_to");
    if (f.timeFrom && f.timeTo && f.timeFrom > f.timeTo) {
      throw new InputError("time_from time_to'dan katta bo'lmasligi kerak");
    }
    if (typeof a.contains === "string" && a.contains.trim()) {
      f.contains = a.contains.trim().slice(0, 100).toLowerCase();
    }
    if (a.order === "oldest") f.order = "oldest";
    f.limit = clampInt(a.limit, 1, MAX_LIMIT, DEFAULT_LIMIT);
  } else {
    f.limit = STATS_LIMIT;
  }
  return f;
}

function describeFilters(f) {
  const q = {};
  if (f.from) q.from = f.from;
  if (f.to) q.to = f.to;
  if (f.days) q.days = f.days;
  if (f.timeFrom) q.time_from = f.timeFrom;
  if (f.timeTo) q.time_to = f.timeTo;
  if (f.contains) q.contains = f.contains;
  q.order = f.order;
  return q;
}

// ============================================================================
// 4. FIRESTORE QATLAMI (o'qish / yozish)
// ============================================================================

async function firestoreListPage(pageSize, pageToken) {
  let url =
    `${BASE_DOCS_URL}/checkins?key=${FIREBASE_API_KEY}` +
    `&orderBy=timestamp%20desc&pageSize=${pageSize}`;
  if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;

  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`Firestore xatosi: HTTP ${r.status}`);
  return r.json();
}

// config/access hujjatidan parol hash'ini o'qiydi (frontend bilan bir xil manba).
// Rules: allow read: if true — token shart emas.
export async function fetchConfigHash() {
  const url = `${BASE_DOCS_URL}/config/access?key=${FIREBASE_API_KEY}`;
  const r = await fetch(url, { cache: "no-store" });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Config o'qishda xato: HTTP ${r.status}`);
  const data = await r.json();
  return data.fields?.hash?.stringValue || null;
}

function docToEntry(doc) {
  const fields = doc.fields || {};
  const p = parseVaqt(fields.vaqt?.stringValue || "");
  if (!p) return null;
  return { ...p, holat: (fields.holat?.stringValue || "").slice(0, 500) };
}

async function fetchLatest() {
  const data = await firestoreListPage(1, null);
  const doc = (data.documents || [])[0];
  if (!doc) return null;
  const e = docToEntry(doc);
  if (!e) return null;
  return { date: e.date, weekday: e.dayKey.slice(10), vaqt: e.time, holat: e.holat };
}

// Firestore'ni timestamp desc bo'yicha sahifalab o'qiydi va kerakli ma'lumot
// yig'ilishi bilan TO'XTAYDI. Qaytadi: { groups: Map(dayKey -> entries), count, truncated }.
async function fetchRange(f) {
  const groups = new Map(); // tartib: eng yangi kun birinchi, kun ichida ham eng yangi birinchi
  let count = 0;
  let complete = false;
  let capped = false;
  let pageToken = null;

  outer: for (let page = 0; page < MAX_PAGES; page++) {
    const data = await firestoreListPage(PAGE_SIZE, pageToken);
    const docs = data.documents || [];

    for (const doc of docs) {
      const e = docToEntry(doc);
      if (!e) continue;

      if (f.to && e.date > f.to) continue; // hali kerakli oraliqqa yetmadik
      if (f.from && e.date < f.from) { complete = true; break outer; }

      if (f.timeFrom && e.time < f.timeFrom) continue;
      if (f.timeTo && e.time > f.timeTo) continue;

      if (f.contains && !e.holat.toLowerCase().includes(f.contains)) continue;

      if (!groups.has(e.dayKey)) {
        if (f.days && groups.size >= f.days) { complete = true; break outer; }
        groups.set(e.dayKey, []);
      }
      if (count >= f.limit) { capped = true; break outer; }
      groups.get(e.dayKey).push({ vaqt: e.time, holat: e.holat });
      count++;
    }

    pageToken = data.nextPageToken || null;
    if (!pageToken || docs.length === 0) { complete = true; break; }
  }

  return { groups, count, truncated: capped || !complete };
}

function arrange(groups, order) {
  const entries = [...groups.entries()];
  if (order === "oldest") {
    entries.reverse();
    for (const [, list] of entries) list.reverse();
  }
  return Object.fromEntries(entries);
}

// Yozish uchun Firestore rules `request.auth != null` talab qiladi, shuning
// uchun har chaqiriqda Identity Toolkit orqali bir martalik anonim token
// olinadi (CLI skript ham xuddi shunday ishlaydi).
async function anonIdToken() {
  const r = await fetch(IDENTITY_TOOLKIT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ returnSecureToken: true }),
  });
  if (!r.ok) throw new Error(`Anonim login xatosi: HTTP ${r.status}`);
  const data = await r.json();
  if (!data.idToken) throw new Error("Anonim login: idToken qaytmadi");
  return data.idToken;
}

async function createCheckin(holat) {
  const idToken = await anonIdToken();
  const vaqt = nowTashkentCompact();
  const r = await fetch(`${BASE_DOCS_URL}/checkins`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${idToken}`,
    },
    body: JSON.stringify({
      fields: {
        vaqt: { stringValue: vaqt },
        holat: { stringValue: holat },
        timestamp: { timestampValue: new Date().toISOString() },
      },
    }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`Yozib bo'lmadi: HTTP ${r.status} ${t.slice(0, 200)}`);
  }
  return { vaqt, holat };
}

// ============================================================================
// 5. STATISTIKA HISOBLASH
// ============================================================================

function toMin(t) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function fmtMin(min) {
  const v = Math.round(min);
  return `${pad2(Math.floor(v / 60))}:${pad2(v % 60)}`;
}

function dayDiff(a, b) {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

function avg(nums) {
  return nums.length ? nums.reduce((s, n) => s + n, 0) / nums.length : null;
}

function computeStats(groups) {
  const days = [...groups.entries()]
    .map(([dayKey, es]) => {
      const mins = es.map((e) => toMin(e.vaqt)).sort((x, y) => x - y);
      let longest = 0;
      for (let i = 1; i < mins.length; i++) longest = Math.max(longest, mins[i] - mins[i - 1]);
      return {
        date: dayKey.slice(0, 10),
        weekday: dayKey.slice(10),
        entries: mins.length,
        firstMin: mins[0],
        lastMin: mins[mins.length - 1],
        longestGap: longest,
      };
    })
    .sort((x, y) => (x.date < y.date ? -1 : 1)); // eskisi birinchi

  for (let i = 0; i < days.length; i++) {
    const prev = days[i - 1];
    days[i].overnightGap =
      prev && dayDiff(prev.date, days[i].date) === 1
        ? 1440 - prev.lastMin + days[i].firstMin
        : null;
  }

  const byWeekday = {};
  for (const wd of ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]) {
    const ds = days.filter((d) => d.weekday === wd);
    if (!ds.length) continue;
    byWeekday[wd] = {
      days: ds.length,
      avg_entries: Number(avg(ds.map((d) => d.entries)).toFixed(1)),
      avg_first: fmtMin(avg(ds.map((d) => d.firstMin))),
      avg_last: fmtMin(avg(ds.map((d) => d.lastMin))),
    };
  }

  const overnight = days.map((d) => d.overnightGap).filter((v) => v != null);
  const total = days.reduce((s, d) => s + d.entries, 0);

  return {
    summary: {
      days_with_entries: days.length,
      total_entries: total,
      avg_entries_per_day: days.length ? Number((total / days.length).toFixed(1)) : null,
      avg_first_entry: days.length ? fmtMin(avg(days.map((d) => d.firstMin))) : null,
      avg_last_entry: days.length ? fmtMin(avg(days.map((d) => d.lastMin))) : null,
      avg_overnight_gap_min: overnight.length ? Math.round(avg(overnight)) : null,
    },
    by_weekday: byWeekday,
    days: days.map((d) => ({
      date: d.date,
      weekday: d.weekday,
      entries: d.entries,
      first: fmtMin(d.firstMin),
      last: fmtMin(d.lastMin),
      longest_gap_min: d.longestGap,
      overnight_gap_min_from_prev_day: d.overnightGap,
    })),
  };
}

// ============================================================================
// 6. TOOL ISHGA TUSHIRISH
// ============================================================================

const textResult = (obj) => ({
  content: [{ type: "text", text: JSON.stringify(obj, null, 2) }],
});
const errorResult = (msg) => ({ content: [{ type: "text", text: msg }], isError: true });

async function handleGetGuide() {
  return { content: [{ type: "text", text: GUIDE }] };
}

async function handleGetLatest() {
  const entry = await fetchLatest();
  return textResult({ now: nowTashkent(), entry });
}

async function handleAddStatus(a) {
  const rl = checkRateLimit("add_status_api", 60000);
  if (!rl.allowed) {
    throw new InputError(`Too fast — wait ${Math.ceil(rl.retryAfterMs / 1000)}s before next check-in.`);
  }
  const holat = typeof a.holat === "string" ? a.holat.trim() : "";
  if (!holat) throw new InputError("holat is required");
  if (holat.length > MAX_HOLAT_LEN) {
    throw new InputError(`holat exceeds ${MAX_HOLAT_LEN} chars`);
  }
  const saved = await createCheckin(holat);
  return textResult({ ok: true, saved });
}

async function handleGetStatus(a) {
  const f = parseFilters(a, { withTextFilters: true });
  const { groups, count, truncated } = await fetchRange(f);
  return textResult({
    now: nowTashkent(),
    query: describeFilters(f),
    total_entries: count,
    days_returned: groups.size,
    truncated,
    checkins: arrange(groups, f.order),
  });
}

async function handleGetStats(a) {
  const f = parseFilters(a, { withTextFilters: false });
  const { groups, truncated } = await fetchRange(f);
  return textResult({
    now: nowTashkent(),
    query: describeFilters(f),
    truncated,
    ...computeStats(groups),
  });
}

const TOOL_HANDLERS = {
  get_guide: () => handleGetGuide(),
  get_latest: (a) => handleGetLatest(a),
  add_status: (a) => handleAddStatus(a),
  get_status: (a) => handleGetStatus(a),
  get_stats: (a) => handleGetStats(a),
};

async function callTool(name, args) {
  const a = args && typeof args === "object" ? args : {};
  const fn = TOOL_HANDLERS[name];
  if (!fn) return errorResult(`Noma'lum tool: ${name}`);
  try {
    return await fn(a);
  } catch (e) {
    if (e instanceof InputError) return errorResult(e.message);
    return errorResult(`Status olinmadi: ${e?.message || e}`);
  }
}

// ============================================================================
// 7. JSON-RPC QATLAMI
// ============================================================================

const rpcOk = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcErr = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

async function handleMessage(msg) {
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") {
    return rpcErr(msg?.id ?? null, -32600, "Invalid Request");
  }
  // Notification (id yo'q) yoki klientdan kelgan javob (method yo'q) -> javob shart emas.
  if (msg.id === undefined || typeof msg.method !== "string") return null;

  switch (msg.method) {
    case "initialize": {
      const asked = msg.params?.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOLS.includes(asked)
        ? asked
        : SUPPORTED_PROTOCOLS[1];
      return rpcOk(msg.id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: "mrstatus: the user's personal check-in log. For personal conversations call get_guide first and follow it.",
      });
    }
    case "ping":
      return rpcOk(msg.id, {});
    case "tools/list":
      return rpcOk(msg.id, { tools: TOOLS });
    case "tools/call": {
      const name = msg.params?.name;
      if (typeof name !== "string") return rpcErr(msg.id, -32602, "Invalid params: name");
      return rpcOk(msg.id, await callTool(name, msg.params?.arguments));
    }
    default:
      return rpcErr(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

// ============================================================================
// 8. HTTP QATLAMI
// ============================================================================

async function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === "string") return JSON.parse(req.body);
    if (Buffer.isBuffer(req.body)) return JSON.parse(req.body.toString("utf8"));
    return req.body;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(obj === undefined ? "" : JSON.stringify(obj));
}

export default async function handler(req, res) {
  if (!process.env.FS_KEY) {
    return send(res, 500, { error: "FS_KEY sozlanmagan" });
  }

  // ?k= faqat Vercel env MCP_TOKEN bilan solishtiriladi. Token paroldan mustaqil va maxfiy.
  // (Eski rejim k = config/access.hash edi, lekin hash Firestore'da hamma o'qiy oladigan joyda
  // turgani uchun u aslida himoyasiz edi, shuning uchun olib tashlandi.)
  const envToken = process.env.MCP_TOKEN;
  if (!envToken) return send(res, 500, { error: "MCP_TOKEN sozlanmagan" });

  const url = new URL(req.url, "http://localhost");
  const candidate = url.searchParams.get("k") || "";
  if (!safeEqual(candidate, envToken)) return send(res, 401, { error: "unauthorized" });

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return send(res, 405, { error: "Faqat POST (SSE stream yo'q)" });
  }

  let body;
  try {
    body = await readBody(req);
  } catch {
    return send(res, 400, rpcErr(null, -32700, "Parse error"));
  }

  if (Array.isArray(body)) {
    const replies = (await Promise.all(body.map(handleMessage))).filter(Boolean);
    return replies.length ? send(res, 200, replies) : send(res, 202);
  }

  const reply = await handleMessage(body);
  return reply ? send(res, 200, reply) : send(res, 202);
}
