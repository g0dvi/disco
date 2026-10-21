// Разовый перенос старых заявок из Supabase в базу сервера, файлы скачиваются на диск.
// Повторный запуск пропускает уже перенесённые заявки.
// Запуск на сервере (данные для входа те же, что были в старой админке):
//   sudo -u disco env DATA_DIR=/srv/disco/data SB_EMAIL=... SB_PASSWORD=... node /srv/disco/app/import-supabase.js
// или вместо почты и пароля SB_SERVICE_KEY=... (Supabase → Project Settings → API → service_role)
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const {Readable} = require("node:stream");
const {pipeline} = require("node:stream/promises");
const {openDb, STATUSES} = require("./server.js");

const SB = "https://roolbmnfwenhkajgmvrh.supabase.co";
const ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJvb2xibW5md2VuaGthamdtdnJoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM5Mjg1NDEsImV4cCI6MjA4OTUwNDU0MX0.Av0eE_b5gPaHhoitDaR9N4sdt5ne6dik3r5NMX07T6g";

const json = v => typeof v === "string" ? JSON.parse(v) : v;
const str = v => String(v ?? "");

async function importFromSupabase({sbUrl = SB, anonKey = ANON, email, password, serviceKey, dataDir, log = console.log}) {
  let token = serviceKey;
  if (!token) {
    const r = await fetch(sbUrl + "/auth/v1/token?grant_type=password", {method: "POST",
      headers: {apikey: anonKey, "Content-Type": "application/json"}, body: JSON.stringify({email, password})});
    if (!r.ok) throw new Error("Supabase не пустил: неверная почта или пароль");
    token = (await r.json()).access_token;
  }
  const r = await fetch(sbUrl + "/rest/v1/requests?select=*&order=created_at.asc", {headers: {apikey: serviceKey || anonKey, Authorization: "Bearer " + token}});
  if (!r.ok) throw new Error("Supabase не отдал заявки: " + r.status + " " + await r.text());
  const rows = await r.json();

  const db = openDb(dataDir), filesDir = path.join(dataDir, "files");
  const exists = db.prepare("select 1 from requests where id = ?");
  const insert = db.prepare("insert into requests (id, created_at, grade, note, songs, banned, status) values (?, ?, ?, ?, ?, ?, ?)");
  const res = {imported: 0, skipped: 0, files: 0, missing: 0};
  try {
    for (const row of rows) {
      if (exists.get(row.id)) { res.skipped++; continue; }
      const songs = [];
      for (const s of json(row.songs) || []) {
        let file = null;
        if (s.url) {
          const name = crypto.randomUUID() + (path.extname(s.filename || new URL(s.url).pathname).toLowerCase() || ".mp3");
          const f = await fetch(s.url);
          if (f.ok) {
            await pipeline(Readable.fromWeb(f.body), fs.createWriteStream(path.join(filesDir, name)));
            file = name; res.files++;
          } else {
            res.missing++; log("  нет файла (" + f.status + "): " + s.url);
          }
        }
        songs.push({title: str(s.title), author: str(s.author), when: str(s.when), file, filename: s.filename || null});
      }
      const banned = (json(row.banned) || []).map(b => ({title: str(b.title), author: str(b.author)}));
      insert.run(row.id, new Date(row.created_at).toISOString(), row.grade ?? null, str(row.note),
        JSON.stringify(songs), JSON.stringify(banned), STATUSES.includes(row.status) ? row.status : null);
      res.imported++;
      log("перенесена заявка от " + row.created_at + ", песен: " + songs.length);
    }
  } finally { db.close(); }
  return res;
}

module.exports = {importFromSupabase};

if (require.main === module) {
  const env = process.env;
  if (!env.DATA_DIR || !(env.SB_SERVICE_KEY || (env.SB_EMAIL && env.SB_PASSWORD))) {
    console.error("Нужны DATA_DIR и SB_EMAIL + SB_PASSWORD (или SB_SERVICE_KEY)"); process.exit(1);
  }
  importFromSupabase({dataDir: env.DATA_DIR, email: env.SB_EMAIL, password: env.SB_PASSWORD, serviceKey: env.SB_SERVICE_KEY})
    .then(r => console.log(`Готово: перенесено ${r.imported}, уже были ${r.skipped}, файлов ${r.files}, не скачалось ${r.missing}`))
    .catch(e => { console.error(e.message); process.exit(1); });
}
