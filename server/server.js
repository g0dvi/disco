// Бэкенд дискотеки: принимает песни кусками, хранит заявки в SQLite, файлы на диске.
// Запуск: DATA_DIR=/srv/disco/data ADMIN_PASSWORD=... SECRET=... PUBLIC_URL=https://bratoyd.fun node server.js
// Caddy на том же домене раздаёт страницы сайта и файлы из DATA_DIR/files (server/Caddyfile)
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const {DatabaseSync} = require("node:sqlite");

const MB = 1024 * 1024;
const AUDIO = /\.(mp3|wav|ogg|oga|opus|m4a|aac|flac|wma|webm)$/i;
const STATUSES = [null, "ok", "no", "maybe"];

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
const fail = (status, message, extra) => { throw new HttpError(status, message, extra); };
const str = (v, max = 300) => String(v ?? "").trim().slice(0, max);

function send(res, status, data) {
  res.writeHead(status, {"Content-Type": "application/json; charset=utf-8"});
  res.end(JSON.stringify(data));
}

// Читает тело целиком, но не больше limit байт
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    req.on("data", c => {
      size += c.length;
      if (size > limit) { req.removeAllListeners("data"); req.resume(); reject(new HttpError(400, "Слишком большой кусок данных")); }
      else parts.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", reject);
  });
}

async function readJson(req) {
  try { return JSON.parse((await readBody(req, MB)).toString("utf8")); }
  catch (e) { throw e instanceof HttpError ? e : new HttpError(400, "Неверные данные"); }
}

// В songs лежит JSON [{title, author, when, file, filename}], file — имя в DATA_DIR/files
function openDb(dataDir) {
  fs.mkdirSync(path.join(dataDir, "tmp"), {recursive: true});
  fs.mkdirSync(path.join(dataDir, "files"), {recursive: true});
  const db = new DatabaseSync(path.join(dataDir, "disco.db"));
  db.exec(`
    create table if not exists requests (id text primary key, created_at text not null, grade text, note text,
      songs text not null, banned text not null, status text);
    create table if not exists uploads (id text primary key, name text not null, size integer not null, created_at integer not null);`);
  return db;
}

function createApp(opts) {
  const cfg = {maxFile: 200 * MB, chunkMax: 16 * MB, minFree: 1024 * MB, uploadTtl: 24 * 3600e3, tokenTtl: 30 * 24 * 3600e3, ...opts};
  const tmpDir = path.join(cfg.dataDir, "tmp"), filesDir = path.join(cfg.dataDir, "files");
  const db = openDb(cfg.dataDir);
  const q = {
    addUpload: db.prepare("insert into uploads (id, name, size, created_at) values (?, ?, ?, ?)"),
    getUpload: db.prepare("select * from uploads where id = ?"),
    dropUpload: db.prepare("delete from uploads where id = ?"),
    oldUploads: db.prepare("select id from uploads where created_at < ?"),
    addRequest: db.prepare("insert into requests (id, created_at, grade, note, songs, banned) values (?, ?, ?, ?, ?, ?)"),
    listRequests: db.prepare("select * from requests order by created_at desc, rowid desc"),
    getRequest: db.prepare("select * from requests where id = ?"),
    setStatus: db.prepare("update requests set status = ? where id = ?"),
    dropRequest: db.prepare("delete from requests where id = ?"),
  };

  const sign = exp => crypto.createHmac("sha256", cfg.secret).update(String(exp)).digest("base64url");
  const sha = s => crypto.createHash("sha256").update(String(s)).digest();
  function requireAdmin(req) {
    const [exp, sig] = (req.headers.authorization || "").replace(/^Bearer /, "").split(".");
    const good = sig && Buffer.byteLength(sig) === Buffer.byteLength(sign(exp)) && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(sign(exp)));
    if (!good || !(Number(exp) > Date.now())) fail(401, "Нужно войти заново");
  }

  const failedLogins = new Map();
  const clientIp = req => (req.headers["x-forwarded-for"] || "").split(",").pop().trim() || req.socket.remoteAddress;

  const tmpPath = id => path.join(tmpDir, id);
  const fileUrl = file => file ? cfg.publicUrl + "/files/" + file : null;
  function uploadOf(id, status = 404) {
    const u = typeof id === "string" && q.getUpload.get(id);
    if (!u) fail(status, "Файл не найден, прикрепи его ещё раз");
    return u;
  }

  const routes = {
    "POST /api/uploads": async req => {
      const {name, size} = await readJson(req);
      if (typeof name !== "string" || !AUDIO.test(name)) fail(400, "Можно загружать только аудиофайлы");
      if (!Number.isSafeInteger(size) || size <= 0) fail(400, "Пустой файл");
      if (size > cfg.maxFile) fail(413, "Файл «" + name + "» больше " + Math.round(cfg.maxFile / MB) + " МБ");
      const st = fs.statfsSync(cfg.dataDir);
      if (st.bavail * st.bsize - size < cfg.minFree) fail(507, "На сервере закончилось место, напиши организатору");
      const id = crypto.randomUUID();
      fs.writeFileSync(tmpPath(id), "");
      q.addUpload.run(id, str(name, 200), size, Date.now());
      return [201, {id}];
    },
    "GET /api/uploads/:id": async (req, id) => {
      const u = uploadOf(id);
      return [200, {offset: fs.statSync(tmpPath(u.id)).size, size: u.size}];
    },
    "PATCH /api/uploads/:id": async (req, id) => {
      const u = uploadOf(id);
      const offset = fs.statSync(tmpPath(u.id)).size;
      if (Number(req.headers["upload-offset"]) !== offset) { req.resume(); fail(409, "Сдвиг не совпадает", {offset}); }
      const chunk = await readBody(req, Math.min(cfg.chunkMax, u.size - offset));
      fs.appendFileSync(tmpPath(u.id), chunk);
      return [200, {offset: offset + chunk.length}];
    },
    "POST /api/submit": async req => {
      const body = await readJson(req);
      if (body.grade !== "5-7" && body.grade !== "8-11") fail(400, "Выбери класс: 5–7 или 8–11.");
      if (!Array.isArray(body.songs) || !Array.isArray(body.banned) || body.songs.length > 100 || body.banned.length > 100) fail(400, "Неверные данные");
      const ready = body.songs.map(s => {
        if (!s.upload) return null;
        const u = uploadOf(s.upload, 400);
        if (fs.statSync(tmpPath(u.id)).size !== u.size) fail(400, "Файл «" + u.name + "» ещё не загрузился");
        return u;
      });
      const songs = body.songs.map((s, i) => {
        const u = ready[i];
        let file = null;
        if (u) {
          file = u.id + path.extname(u.name).toLowerCase();
          fs.renameSync(tmpPath(u.id), path.join(filesDir, file));
          q.dropUpload.run(u.id);
        }
        return {title: str(s.title), author: str(s.author), when: str(s.when, 50), file, filename: u ? u.name : null};
      });
      const banned = body.banned.map(b => ({title: str(b.title), author: str(b.author)}));
      q.addRequest.run(crypto.randomUUID(), new Date().toISOString(), body.grade, str(body.note, 5000), JSON.stringify(songs), JSON.stringify(banned));
      return [200, {ok: true}];
    },
    "POST /api/login": async req => {
      const ip = clientIp(req), now = Date.now();
      const f = failedLogins.get(ip);
      if (f && f.until > now && f.count >= 10) fail(429, "Слишком много попыток, подожди 15 минут");
      const {password} = await readJson(req);
      if (!crypto.timingSafeEqual(sha(password), sha(cfg.adminPassword))) {
        failedLogins.set(ip, f && f.until > now ? {...f, count: f.count + 1} : {count: 1, until: now + 15 * 60e3});
        fail(401, "Неверный пароль");
      }
      const exp = now + cfg.tokenTtl;
      return [200, {token: exp + "." + sign(exp)}];
    },
    "GET /api/requests": async req => {
      requireAdmin(req);
      return [200, q.listRequests.all().map(r => ({...r,
        songs: JSON.parse(r.songs).map(({file, ...s}) => ({...s, url: fileUrl(file)})),
        banned: JSON.parse(r.banned)}))];
    },
    "PATCH /api/requests/:id": async (req, id) => {
      requireAdmin(req);
      const {status} = await readJson(req);
      if (!STATUSES.includes(status)) fail(400, "Неверный статус");
      if (!q.setStatus.run(status, id).changes) fail(404, "Заявка не найдена");
      return [200, {ok: true}];
    },
    "DELETE /api/requests/:id": async (req, id) => {
      requireAdmin(req);
      const r = q.getRequest.get(id) || fail(404, "Заявка не найдена");
      for (const s of JSON.parse(r.songs)) if (s.file) fs.rmSync(path.join(filesDir, s.file), {force: true});
      q.dropRequest.run(id);
      return [200, {ok: true}];
    },
  };

  // API работает только для страниц с того же домена, разрешений для чужих сайтов (CORS) нет
  const server = http.createServer(async (req, res) => {
    try {
      const {pathname} = new URL(req.url, "http://x");
      const m = pathname.match(/^(\/api\/(?:uploads|requests))\/([0-9a-f-]{36})$/);
      const route = m ? routes[req.method + " " + m[1] + "/:id"] : routes[req.method + " " + pathname];
      if (!route) fail(404, "Не найдено");
      const [status, data] = await route(req, m && m[2]);
      send(res, status, data);
    } catch (e) {
      if (!(e instanceof HttpError)) console.error(e);
      e instanceof HttpError ? send(res, e.status, {error: e.message, ...e.extra}) : send(res, 500, {error: "Ошибка сервера"});
    }
  });

  // Удаляет недогруженные файлы, которые так и не попали в заявку
  function cleanup(now = Date.now()) {
    for (const {id} of q.oldUploads.all(now - cfg.uploadTtl)) {
      fs.rmSync(tmpPath(id), {force: true});
      q.dropUpload.run(id);
    }
  }

  return {server, db, cleanup};
}

module.exports = {createApp, openDb, STATUSES};

if (require.main === module) {
  const env = process.env;
  for (const k of ["DATA_DIR", "ADMIN_PASSWORD", "SECRET", "PUBLIC_URL"]) if (!env[k]) { console.error("Не задана переменная " + k); process.exit(1); }
  const app = createApp({dataDir: env.DATA_DIR, adminPassword: env.ADMIN_PASSWORD, secret: env.SECRET, publicUrl: env.PUBLIC_URL.replace(/\/$/, "")});
  const port = Number(env.PORT || 8080);
  app.server.listen(port, "127.0.0.1", () => console.log("disco: слушаю 127.0.0.1:" + port));
  app.cleanup();
  setInterval(() => app.cleanup(), 3600e3).unref();
}
