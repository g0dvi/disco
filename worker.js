// Бэкенд для index.html и admin.html: Cloudflare Worker между сайтом и Supabase.
// Вставить целиком в Cloudflare: Workers → disco → Edit code → Deploy
const SB = "https://roolbmnfwenhkajgmvrh.supabase.co";
const KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJvb2xibW5md2VuaGthamdtdnJoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM5Mjg1NDEsImV4cCI6MjA4OTUwNDU0MX0.Av0eE_b5gPaHhoitDaR9N4sdt5ne6dik3r5NMX07T6g";
const PUB = SB + "/storage/v1/object/public/songs/";
const MAX = 50 * 1024 * 1024;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Range",
  "Access-Control-Max-Age": "86400",
};
const json = (data, status = 200) => new Response(JSON.stringify(data), {status, headers: {...CORS, "Content-Type": "application/json"}});
// Админские запросы идут в Supabase с токеном организатора, права проверяет сама база (setup.sql)
const sb = (path, req, init = {}) => fetch(SB + path, {...init, headers: {apikey: KEY, Authorization: req.headers.get("Authorization") || "Bearer " + KEY, ...init.headers}});

export default {
  async fetch(req) {
    if (req.method === "OPTIONS") return new Response(null, {status: 204, headers: CORS});
    try {
      const url = new URL(req.url), p = url.pathname;
      if ((p === "/api/submit" || p === "/") && req.method === "POST") return await submit(req);
      if (p === "/api/login" && req.method === "POST") return await login(req);
      if (p === "/api/requests" && req.method === "GET") return await list(req, url.origin);
      const m = p.match(/^\/api\/requests\/([0-9a-f-]{36})$/);
      if (m && req.method === "PATCH") return await patch(req, m[1]);
      if (m && req.method === "DELETE") return await remove(req, m[1]);
      const f = p.match(/^\/files\/([\w-]+\.[a-z0-9]+)$/i);
      if (f && req.method === "GET") return await file(req, f[1]);
      return json({error: "Не найдено"}, 404);
    } catch (e) {
      return json({error: "Ошибка сервера: " + e.message}, 500);
    }
  },
};

async function submit(req) {
  const form = await req.formData();
  const grade = form.get("grade");
  if (grade !== "5-7" && grade !== "8-11") return json({error: "Выбери класс: 5–7 или 8–11."}, 400);
  let list, banned;
  try { list = JSON.parse(form.get("songs") || "[]"); banned = JSON.parse(form.get("banned") || "[]"); }
  catch { return json({error: "Неверные данные заявки."}, 400); }
  if (!Array.isArray(list) || !Array.isArray(banned)) return json({error: "Неверные данные заявки."}, 400);

  const songs = [];
  for (const [i, s] of list.entries()) {
    const f = form.get("file_" + i);
    let url = null;
    if (f && typeof f !== "string") {
      if (f.size > MAX) return json({error: "Файл «" + f.name + "» больше 50 МБ."}, 413);
      const ext = (f.name.match(/\.[a-z0-9]+$/i) || [".mp3"])[0].toLowerCase();
      const path = crypto.randomUUID() + ext;
      const up = await sb("/storage/v1/object/songs/" + path, req, {method: "POST", headers: {Authorization: "Bearer " + KEY, "Content-Type": f.type || "audio/mpeg"}, body: f});
      if (!up.ok) return json({error: "Не удалось загрузить файл «" + f.name + "»."}, 502);
      url = PUB + path;
    }
    songs.push({title: String(s.title || ""), author: String(s.author || ""), when: String(s.when || ""), url, filename: url ? f.name : null});
  }
  banned = banned.map(b => ({title: String(b.title || ""), author: String(b.author || "")}));

  const res = await sb("/rest/v1/requests", req, {method: "POST",
    headers: {Authorization: "Bearer " + KEY, "Content-Type": "application/json", Prefer: "return=minimal"},
    body: JSON.stringify({grade, note: String(form.get("note") || ""), songs, banned})});
  if (!res.ok) return json({error: "Сервер не принял заявку. Попробуй ещё раз."}, 502);
  return json({ok: true});
}

async function login(req) {
  const {email, password} = await req.json();
  const r = await sb("/auth/v1/token?grant_type=password", req, {method: "POST",
    headers: {Authorization: "Bearer " + KEY, "Content-Type": "application/json"}, body: JSON.stringify({email, password})});
  if (!r.ok) return json({error: "Неверная почта или пароль"}, 401);
  return json({token: (await r.json()).access_token});
}

async function list(req, origin) {
  const r = await sb("/rest/v1/requests?select=*&order=created_at.desc", req);
  if (!r.ok) return json({error: "Нужно войти заново"}, r.status === 401 || r.status === 403 ? 401 : 502);
  // Ссылки на файлы отдаём через воркер, чтобы не ходить к supabase.co напрямую
  const rows = (await r.json()).map(row => ({...row,
    songs: (row.songs || []).map(s => s.url && s.url.startsWith(PUB) ? {...s, url: origin + "/files/" + s.url.slice(PUB.length)} : s)}));
  return json(rows);
}

async function patch(req, id) {
  const {status} = await req.json();
  if (![null, "ok", "no", "maybe"].includes(status)) return json({error: "Неверный статус"}, 400);
  const r = await sb("/rest/v1/requests?id=eq." + id, req, {method: "PATCH",
    headers: {"Content-Type": "application/json", Prefer: "return=representation"}, body: JSON.stringify({status})});
  // Без входа база не меняет ни одной строки, но отвечает 200 с пустым списком
  if (!r.ok || !(await r.json()).length) return json({error: "Нужно войти заново"}, 401);
  return json({ok: true});
}

async function remove(req, id) {
  const r = await sb("/rest/v1/requests?id=eq." + id, req, {method: "DELETE", headers: {Prefer: "return=representation"}});
  if (!r.ok || !(await r.json()).length) return json({error: "Нужно войти заново"}, 401);
  return json({ok: true});
}

async function file(req, name) {
  const range = req.headers.get("Range");
  const r = await fetch(PUB + name, {headers: range ? {Range: range} : {}});
  const h = new Headers(CORS);
  for (const k of ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "Cache-Control"]) if (r.headers.has(k)) h.set(k, r.headers.get(k));
  return new Response(r.body, {status: r.status, headers: h});
}
