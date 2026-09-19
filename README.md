# MRstatus

- `index.html` — MRstatus sahifasi (Firebase Firestore'dan o'qiydi)
- `api/mcp.js` — Claude uchun remote MCP server (tool'lar: `get_status`, `get_stats`, `get_latest`, `add_status`)
- `firestore.rules` — Firestore qoidalari (Firebase console'da alohida publish qilinadi)
- `instruction.md` — Claude Preferences'ga qo'yiladigan matn

## Deploy
1. Repo'ni GitHub'ga push qil, Vercel avtomatik deploy qiladi.
2. Vercel -> Settings -> Environment Variables: `MCP_SECRET` (kamida 16 belgi,
   tavsiya: 32+ random). O'zgartirgach Redeploy qil.
3. Tekshiruv: brauzerda `https://<domen>/api/mcp?k=<MCP_SECRET>` -> `405` chiqishi kerak
   (401 = key xato, 404 = fayl deploy bo'lmagan, 500 = MCP_SECRET yo'q).
4. Claude -> Settings -> Connectors -> Add custom connector:
   `https://<domen>/api/mcp?k=<MCP_SECRET>`
5. `instruction.md` matnini Preferences'ga qo'y, yangi chat och.

## Ehtiyot
- `MCP_SECRET`ni kodga, chatga yoki skrinshotga qo'yma.
- Firestore rules hozircha `checkins` o'qishiga hamma uchun ruxsat beradi.
