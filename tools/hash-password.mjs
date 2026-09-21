// Parolingdan scrypt hash yaratadi (Vercel env OWNER_PASS_HASH uchun).
//   node tools/hash-password.mjs
// Parol yashirin so'raladi (terminal tarixiga tushmaydi). Ekranga faqat hash chiqadi.
import { randomBytes } from "node:crypto";
import { hashPassword } from "../api/_lib.js";

function askHidden(q) {
  return new Promise((resolve) => {
    process.stdout.write(q);
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      let buf = "";
      stdin.setEncoding("utf8");
      stdin.on("data", (c) => (buf += c));
      stdin.on("end", () => resolve(buf.replace(/\r?\n$/, "")));
      return;
    }
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let s = "";
    stdin.on("data", function onData(ch) {
      for (const c of ch) {
        if (c === "\r" || c === "\n" || c === "\u0004") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener("data", onData);
          process.stdout.write("\n");
          return resolve(s);
        }
        if (c === "\u0003") process.exit(1);
        if (c === "\u007f") s = s.slice(0, -1);
        else s += c;
      }
    });
  });
}

const p1 = await askHidden("Parol: ");
if (p1.length < 12) { console.error("Parol juda qisqa (kamida 12, yaxshisi 16+ belgi)."); process.exit(1); }
if (process.stdin.isTTY) {
  const p2 = await askHidden("Parolni takrorla: ");
  if (p1 !== p2) { console.error("Mos kelmadi."); process.exit(1); }
}
console.log("\nOWNER_PASS_HASH =");
console.log(await hashPassword(p1, randomBytes(16).toString("hex")));
