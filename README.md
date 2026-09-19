# MRstatus

Shaxsiy check-in (kayfiyat/holat) logi — brauzerdan yozib, Claude orqali o'qib bo'ladi.

## Fayllar

- `index.html` — MRstatus sahifasi (parol bilan himoyalangan, Firestore'dan real-vaqtda o'qiydi)
- `api/mcp.js` — Claude uchun remote MCP server (`get_latest`, `get_status`, `get_stats`, `add_status`)
- `firestore.rules` — Firestore xavfsizlik qoidalari (Firebase Console'da alohida publish qilinadi)
- `instruction.md` — Claude Preferences'ga qo'yiladigan matn (faqat Claude'ning o'zi uchun, setup emas)

## 1. Vercel Environment Variables (2 ta, ikkalasi ham majburiy)

Vercel → loyiha → Settings → Environment Variables:

| Nomi | Qiymati | Izoh |
|---|---|---|
| `FS_KEY` | Firebase Web API key (Firebase Console → Project settings → Web app) | Firestore REST so'rovlari uchun |

`MCP_SECRET` endi **kerak emas** — MCP auth ham frontend bilan bir xil: Firestore `config/access.hash` orqali tekshiriladi. Parolni o'zgartirish uchun faqat Firestore'dagi hash'ni yangilash yetarli.

O'zgartirgach **Redeploy** qil.

## 2. Deploy

Repo'ni GitHub'ga push qil — Vercel avtomatik deploy qiladi.

Tekshiruv: brauzerda `https://<domen>/api/mcp?k=<MCP_SECRET>` ochilsa `405` chiqishi kerak.
- `401` = key xato
- `404` = fayl deploy bo'lmagan
- `500` = `MCP_SECRET` yoki `FS_KEY` Vercel'da o'rnatilmagan

## 3. Firestore — parol o'rnatish (bir martalik)

Frontend'ga kirish paroli Firestore'da saqlanadi (Vercel env'da emas), shuning uchun
parolni o'zgartirish uchun qayta deploy shart emas.

1. Parolning SHA-256 hash'ini hisobla:
   ```bash
   echo -n "sening-parol" | sha256sum
   ```
2. Firebase Console → Firestore → `config` collection → `access` document:
   ```json
   { "hash": "<yuqoridagi hash>" }
   ```

Parolni keyinchalik o'zgartirish uchun shu hash'ni yangilash yetarli — frontend va Claude
ikkalasi ham navbatdagi so'rovda avtomatik yangi hash'dan foydalanadi.

## 4. Claude connector

```
Settings → Connectors → Add custom connector
Name: mrstatus
URL: https://<domen>/api/mcp?k=<MCP_SECRET>
```

So'ng `instruction.md` matnini Claude Preferences'ga qo'y va yangi chat och.

## Xavfsizlik haqida eslatma

- `MCP_SECRET` va `FS_KEY`ni kodga, chatga yoki skrinshotga hech qachon qo'yma.
- `index.html` ichidagi Firebase `apiKey` — bu Firebase'ning **public web config** kaliti,
  maxfiy emas; himoya `firestore.rules` orqali ta'minlanadi. `FS_KEY` (server tomonidagi
  REST kaliti) va `MCP_SECRET` esa haqiqiy maxfiy qiymatlar — faqat Vercel env'da tursin.
- Firestore rules hozircha `checkins` o'qishiga hamma uchun ochiq ruxsat beradi (frontend
  auth'siz real-time o'qiydi degan mantiq bilan) — yozish esa auth va validatsiya talab qiladi.

## Troubleshooting

| Xato | Yechim |
|---|---|
| `unauthorized` (Claude) | Connector URL'idagi `k=` Firestore `config/access.hash` bilan mos emas |
| `Parol o'rnatilmagan` | Firestore'da `config/access` hujjati yo'q — hash'ni qo'sh |
| `FS_KEY sozlanmagan` | `FS_KEY`ni Vercel env'ga qo'sh, redeploy qil |
| Parol gate xatosi (frontend) | `config/access` hujjatida `hash` maydoni to'g'rimi, tekshir |
| Auth xatosi | Firebase Console → Authentication → Sign-in method → Anonymous yoqilganmi tekshir |
