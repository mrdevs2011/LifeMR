# LifeMR

Shaxsiy check-in (kayfiyat/holat) logi. Brauzerdan yozasan, Claude orqali o'qiladi.

## Xavfsizlik modeli (qisqa)

Hamma narsa **serverdan** o'tadi: sayt ham, `/mcp` sahifasi ham, Claude ham.
- **Login bitta:** sayt (`/`) va `/mcp` bir xil `authenticate()` dan o'tadi va IP hisobi butun domen uchun bitta (`ipguard`). Sahifaga bog'liq emas.
- **IP bloklash:** 5 daqiqa ichida 3 ta noto'g'ri urinish = IP vaqtincha bloklanadi. Muddat qat'iy jadvaldan olinadi (`api/_lib.js` dagi `BLOCK_STEPS`): 30 soniya, 1, 3, 10 daqiqa, 1.5, 3, 9 soat, 1.5, 3, 9 kun, 1, 3, 6 oy, 1, 2, 4, 10, 100, 1000 yil. Blok tugagach yana 3 ta xato = jadvaldagi keyingi qator. 1000 yillik blok ham o'tgach IP endi hech qachon bloklanmaydi (eshik ochiq, limit yo'q, urinishlar sanalmaydi). To'g'ri login darajani 0 ga qaytaradi (limitsiz holatdan tashqari). Urinishlar orasi 5 daqiqadan oshsa, eskisi hisobdan chiqadi. Blok IP bo'yicha (brauzer yoki qurilma bo'yicha emas): shu IP'dan kiradigan barcha hisoblar, ochiq turgan sessiyalar ham (boshqa qurilmada) keyingi so'rovdayoq bloklangan ekranga tushadi. Ekranda qolgan vaqt soniyalab orqaga sanaladi, sahifa yangilansa ham davom etadi va tugagach o'zi login'ga (sessiya bor bo'lsa saytga) qaytadi. IP o'zgarsa (boshqa tarmoq, mobil internet, VPN) blok ta'sir qilmaydi.
- **Email** env'da (`OWNER_EMAIL`), solishtirish SHA-256 hash orqali. **Parol** scrypt hash (`OWNER_PASS_HASH`), parolning o'zi hech qayerda yo'q.
- **Sessiya:** imzolangan httpOnly cookie (7 kun). Brauzerda localStorage/IndexedDB ishlatilmaydi.
- **Firestore rules:** faqat Claude akkaunti (server shu bilan kiradi). Boshqa hech kim to'g'ridan-to'g'ri kira olmaydi.
- Claude'ning o'zi serverga `MCP_TOKEN` li URL orqali kiradi.

## Fayllar

- `index.html`: sayt. Server orqali kirasan (`/api/login`), yozuvlar har 10 soniyada yangilanadi. Odat qatlami (7 kunlik ritm, tez yozish, eslatma) ham shu yerda.
- `api/mcp.js`: Claude uchun remote MCP server (`get_guide`, `get_latest`, `get_status`, `get_stats`, `add_status`, `get_schedule`, `set_schedule`).
- `api/_guide.js`: Claude'ning asosiy qo'llanmasi (suhbat uslubi va qoidalar). **Qoidalarni o'zgartirish shu faylda.**
- `api/_lib.js`: umumiy qatlam (login, IP hisobi, sessiya). `api/login.js`, `api/logout.js`, `api/checkins.js`: sayt uchun. `api/mcp-link.js`: `/mcp` uchun (bir xil login).
- `tools/hash-password.mjs`: parolingdan `OWNER_PASS_HASH` yaratadi (`node tools/hash-password.mjs`).
- `firestore.rules`: Firestore qoidalari (UID ruxsat ro'yxati). Firebase Console'da alohida Publish qilinadi.
- `mcp/index.html`: connector URL sahifasi (`/mcp`).
- `instruction.md`: Claude Preferences'ga qo'yiladigan QISQA matn (har accountga bir marta).
- `instruction-tests.md`: sinov ro'yxati (faqat o'zing uchun).

## 1. Firebase sozlash (bir martalik)

1. **Authentication → Sign-in method:** `Email/Password` ni yoq.
2. **Authentication → Users → Add user** (ikkita akkaunt):
   - **OWNER:** sening emailing va uzun parol (16+ belgi, passphrase). Bu sayt va `/mcp` uchun.
   - **CLAUDE:** o'zing o'ylab topgan email (haqiqiy bo'lishi shart emas, hech qayerda yozib qo'yma, faqat Vercel env'da tursin) va uzun tasodifiy parol (`openssl rand -hex 24`).
3. Users jadvalidagi ikkala **User UID**ni nusxala. `firestore.rules` ichidagi `OWNER_UID` va `CLAUDE_UID` o'rniga yoz, keyin **Firestore → Rules** ga qo'yib **Publish** qil.
4. Hammasi ishlagandan keyin: **Sign-in method → Anonymous**ni o'chir va Firestore'dagi eski `config/access` hujjatini o'chir (kerak emas, rules uni baribir yopadi).

UID'lar sir emas (parol emas), lekin baribir chatga tashlash shart emas.

## 2. Vercel Environment Variables (hammasi majburiy)

Vercel → loyiha → Settings → Environment Variables:

| Nomi | Qiymati | Izoh |
|---|---|---|
| `FS_KEY` | Firebase Web API key (Project settings → Web app) | Firebase REST so'rovlari |
| `MCP_TOKEN` | `openssl rand -hex 32` | Connector URL'dagi maxfiy kalit |
| `OWNER_EMAIL` | sening emailing | Faqat shu yerda turadi; solishtirish hash orqali |
| `OWNER_PASS_HASH` | `node tools/hash-password.mjs` chiqargan qator | **Sensitive**. Parolning scrypt hash'i |
| `SESSION_SECRET` | `openssl rand -hex 32` | **Sensitive**. Cookie imzosi. Almashtirsang barcha sessiyalar tugaydi |
| `CLAUDE_EMAIL` | Claude akkauntining emaili | Server Firestore'ga shu bilan kiradi |
| `CLAUDE_PASSWORD` | Claude akkauntining paroli | **Sensitive** |

O'zgartirgach **Redeploy** qil. Env yangi deploy'siz o'qilmaydi.

## 3. Deploy va tekshiruv

Repo'ni GitHub'ga push qil: Vercel avtomatik deploy qiladi.

- Brauzerda `https://<domen>/api/mcp?k=<MCP_TOKEN>` ochilsa `405` chiqishi kerak.
  - `401` = key xato, `404` = fayl deploy bo'lmagan, `500` = env yetishmayapti.
- Sayt: `https://<domen>/` da email va parol bilan kir. Sessiya httpOnly cookie'da.
- 5 daqiqa ichida 3 ta xato = IP bloklanadi (muddati `BLOCK_STEPS` jadvalidan). Muddatdan oldin ochish yoki darajani nolga tushirish: Firebase Console → Firestore → `ipguard` → hujjatni o'chir. Eski (`until`siz) bloklangan hujjatlar doimiy qoladi, ularni ham shunday ochasan.

## 4. Claude accountlarni ulash (har accountga bir marta)

1. `https://<domen>/mcp` ni och, email va parolingni yoz. Connector URL yopiq (`••••`) ko'rinadi, **Nusxa olish** ni bos.
2. Claude → Settings → Connectors → Add custom connector. Name: `lifemr`, URL: nusxa olingan manzil. OAuth maydonlarini bo'sh qoldir.
3. `instruction.md` matnini shu accountning Preferences'iga qo'y va yangi chat och.

## 5. Qoidalarni o'zgartirish (accountlarga tegmasdan)

Claude'ning suhbat uslubi va barcha qoidalari `api/_guide.js` ichida.

1. `api/_guide.js` dagi matnni tahrirla. Matn ichida backtick, `${` va teskari slash ishlatma.
2. Push qil. Deploy'dan keyin barcha accountlarda yangi qoidalar keyingi suhbatdan ishlaydi.

`instruction.md` faqat `get_guide` tool nomiga tayanadi. Tool nomini o'zgartirmasang, uni qayta qo'yish kerak emas.

## 6. Odat qatlami (sayt)

- Tepada oxirgi 7 kun ritmi (nuqtalar) va `n/7 kun · energiya ~x`. Yozish zahoti bugungi nuqta to'lib ko'rinadi. Zanjir uzilishi yoki jazo yo'q.
- Tez yozish tugmalari va energiya (1-5): yuborishda matn oxiriga ` :N` qo'shiladi (guide aynan shu belgini o'qiydi).
- Eslatma qatori: yakshanbadan boshqa kunlari 13:00-17:00 da va har kuni 20:00-23:00 da, oxirgi yozuvdan yetarli vaqt o'tgan bo'lsa. Vaqtlarni `index.html` ichidagi `updateHabit()` da o'zgartirasan.
- Kun chegarasi guide bilan bir xil: 00:00-04:59 dagi yozuv oldingi kunga hisoblanadi.
- Saytni telefon bosh ekraniga qo'sh (Add to Home Screen): ilova kabi ochiladi.
- Claude tomonida ham yengil turtki bor (`_guide.js`, 10-bo'lim, "Odat turtkisi").

## 7. Dars jadvali va vaqtlar (sayt)

- `Vaqt` ustuni: har dars uchun boshlanish (tepada) va tugash (pastda), oddiy tahrirlanadigan katak. `+5` keyingi darsgacha tanaffus: vaqtlardan hisoblanadi, saqlanmaydi.
- Jadvalda kodga yozilgan qiymat yo'q: vaqtlar ham, dars matnlari ham faqat Firestore'dan o'qiladi. Katak bo'sh bo'lsa, bo'sh ko'rinadi (placeholder ham yo'q). Boshlang'ich (seed) vaqtlar olib tashlangan: bo'sh ustunni o'zing yozasan, yoki Claude'ga `set_schedule` (`bell_times`) bilan yozdirasan.
- Vaqtlar `jadval/main` ichidagi `cells` xaritasida `start_<n>` / `end_<n>` kalitlari bilan turadi. `api/jadval.js` ham, `api/mcp.js` ham shu kalitlarni bilishi shart (ikkalasi ham butun xaritani almashtirib yozadi). Claude `get_schedule` da har dars vaqtini, `bell_times` ni va hisoblangan `break_after_min` (saytdagi `+5`) ni ko'radi. `set_schedule` esa kataklar (`changes`) bilan birga vaqtlarni ham (`bell_times`: dars raqami + `start`/`end`, masalan `8:50`) o'zgartira oladi. Berilmagan maydon o'zgarmaydi, bo'sh matn tozalaydi, tugash boshlanishdan keyin bo'lmasa rad etadi.
- `firestore.rules` dagi `cells.size()` chegarasi 64 (48 katak + 16 vaqt kaliti). Rules'ni Firebase Console'da alohida **Publish** qilish shart, aks holda jadval to'lganda saqlash rad etiladi.

## Xavfsizlik eslatmalari

- `MCP_TOKEN`, `CLAUDE_PASSWORD`, `FS_KEY`ni kodga, chatga yoki skrinshotga hech qachon qo'yma. Faqat Vercel env'da tursin.
- `index.html` ichidagi Firebase `apiKey` public web config kaliti, maxfiy emas: himoya rules orqali.
- **Eng zaif halqa: parolingning uzunligi.** Uzun passphrase (16+ belgi), boshqa joyda ishlatilmagan. Parolni almashtirish: `node tools/hash-password.mjs`, yangi hash'ni `OWNER_PASS_HASH`ga qo'y, Redeploy.
- Claude akkaunti buzilsa: Firebase → Users'da uni o'chir yoki parolini almashtir, Vercel'da `CLAUDE_PASSWORD`ni yangila, Redeploy. Saytga ta'sir qilmaydi.
- `MCP_TOKEN` sizib chiqsa: yangisini yarat, Vercel'da almashtir, Redeploy, `/mcp`dan yangi URL olib accountlarga qo'y.

## Troubleshooting

| Xato | Yechim |
|---|---|
| `unauthorized` (Claude) | Connector URL'idagi `k=` `MCP_TOKEN` bilan mos emas. URL'ni `/mcp` sahifasidan qayta ol |
| `MCP_TOKEN sozlanmagan` / `OWNER_EMAIL sozlanmagan` / `FS_KEY sozlanmagan` | Vercel env'ga qo'sh, Redeploy qil |
| `CLAUDE_EMAIL yoki CLAUDE_PASSWORD sozlanmagan` | Vercel env'ga qo'sh, Redeploy qil |
| Claude'da `Firebase login xatosi` | `CLAUDE_EMAIL`/`CLAUDE_PASSWORD` Firebase'dagi akkaunt bilan mos emas yoki Email/Password yoqilmagan |
| Claude'da `Firestore ruxsat bermadi` | `firestore.rules`dagi `CLAUDE_UID` noto'g'ri yoki rules Publish qilinmagan |
| Saytda "server xatosi: ... sozlanmagan" | Shu env'ni Vercel'ga qo'sh, Redeploy qil |
| Doim "email yoki parol noto'g'ri" | `OWNER_EMAIL` yoki `OWNER_PASS_HASH` mos emas (hash'ni aynan shu parol bilan qayta yarat) |
| Sayt: "email yoki parol noto'g'ri" | Firebase → Users'dagi email/parolni tekshir; Email/Password yoqilganmi? |
| `/mcp`da "noto'g'ri parol" | Parol OWNER akkauntining Firebase paroli bo'lishi kerak va `OWNER_EMAIL` env shu emailga teng bo'lishi kerak |
