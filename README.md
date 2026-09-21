# MRstatus

Shaxsiy check-in (kayfiyat/holat) logi — brauzerdan yozib, Claude orqali o'qib bo'ladi.

## Fayllar

- `index.html` — MRstatus sahifasi (parol bilan himoyalangan, Firestore'dan real-vaqtda o'qiydi)
- `api/mcp.js` — Claude uchun remote MCP server (`get_guide`, `get_latest`, `get_status`, `get_stats`, `add_status`)
- `api/_guide.js` — Claude'ning asosiy qo'llanmasi (suhbat uslubi va qoidalar). `get_guide` tool'i shuni qaytaradi. **Qoidalarni o'zgartirish shu faylda.**
- `api/mcp-link.js` — `/mcp` sahifasi uchun: parolni serverda tekshirib, connector URL'ini qaytaradi
- `firestore.rules` — Firestore xavfsizlik qoidalari (Firebase Console'da alohida publish qilinadi)
- `mcp/index.html` — connector URL sahifasi (`/mcp`): parolni serverda tekshirtirib, `MCP_TOKEN` li URL'ni ko'rsatadi
- `instruction.md` — Claude Preferences'ga qo'yiladigan QISQA matn. Har accountga bir marta qo'yiladi va keyin o'zgarmaydi
- `instruction-tests.md` — instruction.md ni sinash ro'yxati (faqat o'zing uchun, Claude'ga qo'yilmaydi)

## 1. Vercel Environment Variables (`FS_KEY` va `MCP_TOKEN` ikkalasi majburiy)

Vercel → loyiha → Settings → Environment Variables:

| Nomi | Qiymati | Izoh |
|---|---|---|
| `FS_KEY` | Firebase Web API key (Firebase Console → Project settings → Web app) | Firestore REST so'rovlari uchun |
| `MCP_TOKEN` | tasodifiy uzun qiymat: `openssl rand -hex 32` | Connector URL'dagi maxfiy kalit. Paroldan mustaqil, shuning uchun parol almashsa ham URL o'zgarmaydi |

`MCP_TOKEN` yo'q bo'lsa `/api/mcp` va `/api/mcp-link` `500` qaytaradi. Eski "hash rejimi" olib tashlandi: hash Firestore'da hamma o'qiy oladigan joyda turgani uchun u aslida himoyasiz edi.

Token almashtirsang, URL'ni `/mcp` sahifasidan qayta olib, hamma Claude accountlarga yangilash kerak.

O'zgartirgach **Redeploy** qil.

## 2. Deploy

Repo'ni GitHub'ga push qil — Vercel avtomatik deploy qiladi.

Tekshiruv: brauzerda `https://<domen>/api/mcp?k=<MCP_TOKEN>` ochilsa `405` chiqishi kerak.
- `401` = key xato
- `404` = fayl deploy bo'lmagan
- `500` = `MCP_TOKEN` yoki `FS_KEY` Vercel'da o'rnatilmagan

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

Hash'ni faqat Firebase Console'dan o'zgartirasan (rules client'dan yozishni taqiqlaydi). Parolni keyinchalik o'zgartirish uchun shu hash'ni yangilash yetarli — frontend va Claude
ikkalasi ham navbatdagi so'rovda avtomatik yangi hash'dan foydalanadi.

## 4. Claude accountlarni ulash (har accountga bir marta)

1. Brauzerda `https://<domen>/mcp` ni och va parolni kiriting. Connector URL ko'rinadi.
2. Claude → Settings → Connectors → Add custom connector. Name: `mrstatus`, URL: sahifadagi manzil.
3. `instruction.md` matnini shu accountning Preferences'iga qo'y va yangi chat och.

Hamma accountda URL bir xil, `instruction.md` ham bir xil. Shundan keyin ularga qayta tegish shart emas.

## 5. Qoidalarni o'zgartirish (accountlarga tegmasdan)

Claude'ning suhbat uslubi va barcha qoidalari `api/_guide.js` ichida. O'zgartirish:

1. `api/_guide.js` dagi matnni tahrirla. Matn ichida backtick, `${` va teskari slash ishlatma.
2. Push qil. Vercel deploy qilgach, barcha accountlarda yangi qoidalar keyingi suhbatdan ishlaydi.

`instruction.md` (Preferences'dagi matn) faqat `get_guide` tool nomiga tayanadi. Tool nomini o'zgartirmasang, uni qayta qo'yish kerak emas.

## 6. Odat qatlami (sayt)

- Tepada oxirgi 7 kun ritmi (nuqtalar) va `n/7 kun · energiya ~x`. Yozish zahoti bugungi nuqta to'lib ko'rinadi. Zanjir uzilishi yoki jazo yo'q, faqat oxirgi 7 kun ko'rinadi.
- Tez yozish tugmalari va energiya (1-5): yuborishda matn oxiriga ` :N` qo'shiladi (guide aynan shu belgini o'qiydi).
- Eslatma qatori: yakshanbadan boshqa kunlari 13:00-17:00 da va har kuni 20:00-23:00 da, oxirgi yozuvdan yetarli vaqt o'tgan bo'lsa. Vaqtlarni `index.html` ichidagi `updateHabit()` da o'zgartirasan.
- Kun chegarasi guide bilan bir xil: 00:00-04:59 dagi yozuv oldingi kunga hisoblanadi.
- Eng katta odat tugmasi: saytni telefon bosh ekraniga qo'sh (Add to Home Screen). Ilova kabi ochiladi.
- Claude tomonida ham yengil turtki bor (`_guide.js`, 10-bo'lim, "Odat turtkisi"): suhbatda ko'pi bilan bir marta, aybdor qilmasdan.

## Xavfsizlik haqida eslatma

- `MCP_TOKEN` va `FS_KEY`ni kodga, chatga yoki skrinshotga hech qachon qo'yma.
- `index.html` ichidagi Firebase `apiKey` — bu Firebase'ning **public web config** kaliti,
  maxfiy emas; himoya `firestore.rules` orqali ta'minlanadi. `FS_KEY` (server tomonidagi
  REST kaliti) va `MCP_TOKEN` esa haqiqiy maxfiy qiymatlar — faqat Vercel env'da tursin.
- `MCP_TOKEN` connector URL'ni himoya qiladi, lekin Firestore'ning o'zi hali ochiq: `checkins` va `config/access` o'qish hammaga ruxsat, ya'ni REST orqali loglarni to'g'ridan-to'g'ri o'qish mumkin, anonim token bilan esa `checkins`ga yozish ham mumkin. `config/access` yozish yopilgan (faqat Firebase Console'dan o'zgaradi). To'liq yopish uchun: Firebase Auth (email/parol, bitta akkaunt) + rules'da uid tekshiruvi (KEYINGI QADAM).
- Firestore rules hozircha `checkins` o'qishiga hamma uchun ochiq ruxsat beradi (frontend
  auth'siz real-time o'qiydi degan mantiq bilan) — yozish esa auth va validatsiya talab qiladi.

## Troubleshooting

| Xato | Yechim |
|---|---|
| `unauthorized` (Claude) | Connector URL'idagi `k=` `MCP_TOKEN` bilan mos emas . URL'ni `/mcp` sahifasidan qayta ol |
| `Parol o'rnatilmagan` | Firestore'da `config/access` hujjati yo'q — hash'ni qo'sh |
| `FS_KEY sozlanmagan` | `FS_KEY`ni Vercel env'ga qo'sh, redeploy qil |
| Parol gate xatosi (frontend) | `config/access` hujjatida `hash` maydoni to'g'rimi, tekshir |
| Auth xatosi | Firebase Console → Authentication → Sign-in method → Anonymous yoqilganmi tekshir |
