// api/download-status-json.js
// Legacy endpoint. Yangi format (kunlar bo‘yicha guruhlangan).
// Tavsiya: /api/download-status/{ts} ishlating.
// Bu fayl eski havolalar ishlashi uchun saqlanadi.

import crypto from "crypto";

const FIREBASE_PROJECT_ID = "mrabout";
const FIREBASE_API_KEY = "AIzaSyAvvkcbKlbrplbh29m2MmVfiypvlGAEglg";
const BASE_DOCS_URL =
  `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MAX_PAGES = 10;
const PAGE_SIZE = 1000;

function daysInMonth(year, month) {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month];
}

function isValidYMD(year, month, day) {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return false;
  if (!Number.isInteger(month) || month < 1 || month > 12) return false;
  if (!Number.isInteger(day) || day < 1) return false;
  return day <= daysInMonth(year, month);
}

function sha256Hex(str) {
  return crypto.createHash("sha256").update(String(str), "utf8").digest("hex");
}

function weekdayFromYMD(year, month, day) {
  const d = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  return WEEKDAYS[d.getUTCDay()];
}

function parseVaqt(vaqt) {
  const m = String(vaqt)
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::\d{2})?/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hourNum = Number(m[4]);
  const minuteNum = Number(m[5]);
  if (!isValidYMD(year, month, day)) return null;
  if (hourNum < 0 || hourNum > 23 || minuteNum < 0 || minuteNum > 59) return null;
  const weekday = weekdayFromYMD(year, month, day);
  const dayKey =
    `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}${weekday}`;
  return {
    dayKey,
    time: `${String(hourNum).padStart(2, "0")}:${String(minuteNum).padStart(2, "0")}`,
  };
}

function groupByDay(checkins) {
  const groups = Object.create(null);
  const order = [];
  for (const item of checkins) {
    if (!item || typeof item.vaqt !== "string") continue;
    const parsed = parseVaqt(item.vaqt);
    if (!parsed) continue;
    const { dayKey, time } = parsed;
    if (!Object.prototype.hasOwnProperty.call(groups, dayKey)) {
      groups[dayKey] = [];
      order.push(dayKey);
    }
    groups[dayKey].push({
      vaqt: time,
      holat: typeof item.holat === "string" ? item.holat : "",
    });
  }
  const result = {};
  for (const key of order) result[key] = groups[key];
  return result;
}

async function fetchAllCheckins() {
  const all = [];
  let pageToken = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    let url =
      `${BASE_DOCS_URL}/checkins?key=${FIREBASE_API_KEY}` +
      `&orderBy=timestamp%20desc&pageSize=${PAGE_SIZE}`;
    if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Firestore xato: ${res.status}`);
    const data = await res.json();
    const docs = data.documents || [];
    for (const d of docs) {
      const fields = d.fields || {};
      all.push({
        vaqt: fields.vaqt?.stringValue || "",
        holat: fields.holat?.stringValue || "",
      });
    }
    pageToken = data.nextPageToken || null;
    if (!pageToken || docs.length === 0) break;
  }
  return all;
}

async function verifyPass(pass) {
  const res = await fetch(
    `${BASE_DOCS_URL}/config/access?key=${FIREBASE_API_KEY}`
  );
  if (!res.ok) return true;
  const data = await res.json();
  const correctHash = data?.fields?.hash?.stringValue;
  if (!correctHash) return true;
  if (!pass) return false;
  return sha256Hex(pass) === correctHash;
}

export default async function handler(req, res) {
  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate"
  );
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method && req.method !== "GET" && req.method !== "HEAD") {
    res.status(405).json({ xato: "faqat GET" });
    return;
  }

  try {
    if (!(await verifyPass(req.query.pass))) {
      res.status(401).json({
        xato: "parol noto'g'ri yoki yo'q. ?pass=... qo'sh",
      });
      return;
    }
    const grouped = groupByDay(await fetchAllCheckins());
    if (req.method === "HEAD") {
      res.status(200).end();
      return;
    }
    res.status(200).send(JSON.stringify(grouped, null, 2));
  } catch (e) {
    res.status(500).json({ xato: e && e.message ? e.message : String(e) });
  }
}
