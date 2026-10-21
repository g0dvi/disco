// Запуск: node --test server/*.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const {importFromSupabase} = require("./import-supabase.js");
const {openDb} = require("./server.js");

const MP3 = Buffer.from("old mp3 bytes");
const OLD = [
  {id: "11111111-1111-4111-8111-111111111111", created_at: "2026-10-16T15:55:01.123456+00:00", grade: "5-7", note: "первая", status: "ok",
    songs: [{title: "A", author: "B", when: "Медляк", url: "SB/storage/v1/object/public/songs/aaa.mp3", filename: "Моя песня.mp3"}, {title: "C", author: "", when: "", url: null, filename: null}],
    banned: [{title: "X", author: "Y"}]},
  {id: "22222222-2222-4222-8222-222222222222", created_at: "2026-10-17T10:00:00+00:00", grade: "8-11", note: null, status: null,
    songs: [{title: "lost", url: "SB/storage/v1/object/public/songs/missing.mp3", filename: "lost.mp3"}], banned: null},
];

async function fakeSupabase(t) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push(req.method + " " + req.url);
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/auth/v1/token") {
      let body = "";
      req.on("data", c => body += c).on("end", () => {
        const {email, password} = JSON.parse(body);
        if (req.headers.apikey !== "ANON" || email !== "org@school.ru" || password !== "pw") { res.writeHead(400); return res.end("{}"); }
        res.writeHead(200, {"Content-Type": "application/json"}); res.end(JSON.stringify({access_token: "USER_TOKEN"}));
      });
      return;
    }
    if (url.pathname === "/rest/v1/requests") {
      if (req.headers.authorization !== "Bearer USER_TOKEN") { res.writeHead(401); return res.end("{}"); }
      res.writeHead(200, {"Content-Type": "application/json"});
      return res.end(JSON.stringify(OLD).replaceAll("SB/", base + "/"));
    }
    if (url.pathname === "/storage/v1/object/public/songs/aaa.mp3") { res.writeHead(200, {"Content-Type": "audio/mpeg"}); return res.end(MP3); }
    res.writeHead(404); res.end();
  });
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + srv.address().port;
  t.after(() => srv.close());
  return {base, seen};
}

function tmpData(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "disco-import-"));
  t.after(() => fs.rmSync(dataDir, {recursive: true, force: true}));
  return dataDir;
}

const rowsOf = dataDir => { const db = openDb(dataDir); try { return db.prepare("select * from requests order by created_at").all(); } finally { db.close(); } };

test("old requests are copied with their dates, statuses and files", async t => {
  const sb = await fakeSupabase(t), dataDir = tmpData(t);
  const res = await importFromSupabase({sbUrl: sb.base, anonKey: "ANON", email: "org@school.ru", password: "pw", dataDir, log: () => {}});
  assert.deepEqual({imported: res.imported, skipped: res.skipped, files: res.files, missing: res.missing}, {imported: 2, skipped: 0, files: 1, missing: 1});

  const [first, second] = rowsOf(dataDir);
  assert.equal(first.id, OLD[0].id);
  assert.equal(first.created_at, "2026-10-16T15:55:01.123Z");
  assert.equal(first.grade, "5-7"); assert.equal(first.note, "первая"); assert.equal(first.status, "ok");
  const songs = JSON.parse(first.songs);
  assert.match(songs[0].file, /^[0-9a-f-]{36}\.mp3$/);
  assert.equal(songs[0].filename, "Моя песня.mp3"); assert.equal(songs[0].when, "Медляк");
  assert.deepEqual(fs.readFileSync(path.join(dataDir, "files", songs[0].file)), MP3);
  assert.deepEqual(songs[1], {title: "C", author: "", when: "", file: null, filename: null});
  assert.deepEqual(JSON.parse(first.banned), [{title: "X", author: "Y"}]);

  assert.equal(second.note, ""); assert.equal(second.status, null); assert.deepEqual(JSON.parse(second.banned), []);
  assert.deepEqual(JSON.parse(second.songs), [{title: "lost", author: "", when: "", file: null, filename: "lost.mp3"}]);
});

test("running the import twice does not duplicate anything", async t => {
  const sb = await fakeSupabase(t), dataDir = tmpData(t);
  const opts = {sbUrl: sb.base, anonKey: "ANON", email: "org@school.ru", password: "pw", dataDir, log: () => {}};
  await importFromSupabase(opts);
  const again = await importFromSupabase(opts);
  assert.equal(again.imported, 0); assert.equal(again.skipped, 2);
  assert.equal(rowsOf(dataDir).length, 2);
  assert.equal(fs.readdirSync(path.join(dataDir, "files")).length, 1);
});

test("wrong Supabase password stops before touching the database", async t => {
  const sb = await fakeSupabase(t), dataDir = tmpData(t);
  await assert.rejects(importFromSupabase({sbUrl: sb.base, anonKey: "ANON", email: "org@school.ru", password: "nope", dataDir, log: () => {}}), /пароль/);
  assert.equal(rowsOf(dataDir).length, 0);
});

test("service key can be used instead of a login", async t => {
  const sb = await fakeSupabase(t), dataDir = tmpData(t);
  await assert.rejects(importFromSupabase({sbUrl: sb.base, anonKey: "ANON", serviceKey: "WRONG", dataDir, log: () => {}}), /401/);
  assert.ok(!sb.seen.some(s => s.startsWith("POST /auth")));
});
