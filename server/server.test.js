// Запуск: node --test server/*.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {createApp} = require("./server.js");

const PUBLIC = "https://disco.example.ru";
const PASSWORD = "correct horse";

async function start(t, opts = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "disco-test-"));
  const app = createApp({dataDir, adminPassword: PASSWORD, secret: "s3cret", publicUrl: PUBLIC, ...opts});
  await new Promise(r => app.server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + app.server.address().port;
  t.after(() => { app.server.close(); app.db.close(); fs.rmSync(dataDir, {recursive: true, force: true}); });
  const call = (p, init = {}) => fetch(base + p, init);
  const json = (p, method, body, headers = {}) => call(p, {method, headers: {"Content-Type": "application/json", ...headers}, body: JSON.stringify(body)});
  return {app, dataDir, call, json};
}

async function upload(s, bytes, name = "song.mp3", chunk = 3) {
  const r = await s.json("/api/uploads", "POST", {name, size: bytes.length, type: "audio/mpeg"});
  assert.equal(r.status, 201);
  const {id} = await r.json();
  for (let off = 0; off < bytes.length; off += chunk) {
    const c = await s.call("/api/uploads/" + id, {method: "PATCH", headers: {"Upload-Offset": String(off)}, body: bytes.subarray(off, off + chunk)});
    assert.equal(c.status, 200, await c.clone().text());
  }
  return id;
}

async function login(s) {
  const r = await s.json("/api/login", "POST", {password: PASSWORD});
  assert.equal(r.status, 200);
  return {Authorization: "Bearer " + (await r.json()).token};
}

const submit = (s, body) => s.json("/api/submit", "POST", {grade: "8-11", note: "", songs: [], banned: [], ...body});

test("other sites get no CORS permission, the API is same-origin only", async t => {
  const s = await start(t);
  const pre = await s.call("/api/requests/x", {method: "OPTIONS", headers: {Origin: "https://evil.example", "Access-Control-Request-Method": "PATCH"}});
  assert.equal(pre.headers.get("access-control-allow-origin"), null);
  const r = await s.call("/api/uploads", {method: "POST", headers: {Origin: "https://evil.example", "Content-Type": "application/json"}, body: JSON.stringify({name: "a.mp3", size: 1})});
  assert.equal(r.headers.get("access-control-allow-origin"), null);
});

test("errors are JSON", async t => {
  const s = await start(t);
  const r = await s.call("/nope");
  assert.equal(r.status, 404);
  assert.ok((await r.json()).error);
});

test("file uploads in chunks and reports its offset", async t => {
  const s = await start(t);
  const bytes = Buffer.from("0123456789");
  const id = await upload(s, bytes);
  const r = await s.call("/api/uploads/" + id);
  assert.deepEqual(await r.json(), {offset: 10, size: 10});
  assert.deepEqual(fs.readFileSync(path.join(s.dataDir, "tmp", id)), bytes);
});

test("chunk at the wrong offset is refused with the real offset", async t => {
  const s = await start(t);
  const {id} = await (await s.json("/api/uploads", "POST", {name: "a.mp3", size: 10})).json();
  await s.call("/api/uploads/" + id, {method: "PATCH", headers: {"Upload-Offset": "0"}, body: "abcd"});
  const r = await s.call("/api/uploads/" + id, {method: "PATCH", headers: {"Upload-Offset": "2"}, body: "xx"});
  assert.equal(r.status, 409);
  assert.equal((await r.json()).offset, 4);
});

test("chunk past the declared size is refused and not written", async t => {
  const s = await start(t);
  const {id} = await (await s.json("/api/uploads", "POST", {name: "a.mp3", size: 4})).json();
  const r = await s.call("/api/uploads/" + id, {method: "PATCH", headers: {"Upload-Offset": "0"}, body: "abcdef"});
  assert.equal(r.status, 400);
  assert.equal(fs.statSync(path.join(s.dataDir, "tmp", id)).size, 0);
});

test("only audio files are accepted", async t => {
  const s = await start(t);
  const r = await s.json("/api/uploads", "POST", {name: "virus.exe", size: 10});
  assert.equal(r.status, 400);
});

test("files over the size limit are refused up front", async t => {
  const s = await start(t, {maxFile: 100});
  const r = await s.json("/api/uploads", "POST", {name: "big.wav", size: 101});
  assert.equal(r.status, 413);
  assert.match((await r.json()).error, /МБ/);
});

test("uploads stop when the disk is nearly full", async t => {
  const s = await start(t, {minFree: Number.MAX_SAFE_INTEGER});
  const r = await s.json("/api/uploads", "POST", {name: "a.mp3", size: 10});
  assert.equal(r.status, 507);
});

test("submit needs a grade", async t => {
  const s = await start(t);
  const r = await submit(s, {grade: ""});
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /класс/);
});

test("submit refuses an unfinished upload", async t => {
  const s = await start(t);
  const {id} = await (await s.json("/api/uploads", "POST", {name: "a.mp3", size: 10})).json();
  const r = await submit(s, {songs: [{title: "t", upload: id}]});
  assert.equal(r.status, 400);
});

test("submitted request shows up in admin with a playable file link", async t => {
  const s = await start(t);
  const id = await upload(s, Buffer.from("music!"), "My Song.MP3");
  const r = await submit(s, {note: "привет", songs: [{title: "A", author: "B", when: "Медляк", upload: id}, {title: "C"}], banned: [{title: "X", author: "Y"}]});
  assert.equal(r.status, 200, await r.clone().text());

  const rows = await (await s.call("/api/requests", {headers: await login(s)})).json();
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.grade, "8-11"); assert.equal(row.note, "привет"); assert.equal(row.status, null);
  assert.ok(row.id && row.created_at);
  assert.equal(row.songs[0].title, "A"); assert.equal(row.songs[0].when, "Медляк");
  assert.equal(row.songs[0].filename, "My Song.MP3");
  assert.match(row.songs[0].url, /^https:\/\/disco\.example\.ru\/files\/[0-9a-f-]{36}\.mp3$/);
  assert.deepEqual(fs.readFileSync(path.join(s.dataDir, "files", row.songs[0].url.split("/").pop())), Buffer.from("music!"));
  assert.equal(row.songs[1].url, null);
  assert.deepEqual(row.banned, [{title: "X", author: "Y"}]);
});

test("an upload can be used in only one request", async t => {
  const s = await start(t);
  const id = await upload(s, Buffer.from("abc"));
  assert.equal((await submit(s, {songs: [{upload: id}]})).status, 200);
  assert.equal((await submit(s, {songs: [{upload: id}]})).status, 400);
});

test("admin list is newest first", async t => {
  const s = await start(t);
  await submit(s, {note: "first"});
  await submit(s, {note: "second"});
  const rows = await (await s.call("/api/requests", {headers: await login(s)})).json();
  assert.deepEqual(rows.map(r => r.note), ["second", "first"]);
});

test("admin endpoints need a valid token", async t => {
  const s = await start(t);
  assert.equal((await s.call("/api/requests")).status, 401);
  assert.equal((await s.call("/api/requests", {headers: {Authorization: "Bearer 9999999999999.forged"}})).status, 401);
  assert.equal((await s.json("/api/login", "POST", {password: "wrong"})).status, 401);
});

test("expired token is refused", async t => {
  const s = await start(t, {tokenTtl: -1000});
  assert.equal((await s.call("/api/requests", {headers: await login(s)})).status, 401);
});

test("login is rate limited after repeated failures", async t => {
  const s = await start(t);
  for (let i = 0; i < 10; i++) await s.json("/api/login", "POST", {password: "wrong"});
  const r = await s.json("/api/login", "POST", {password: PASSWORD});
  assert.equal(r.status, 429);
});

test("admin sets and clears status", async t => {
  const s = await start(t);
  await submit(s, {});
  const auth = await login(s);
  const [row] = await (await s.call("/api/requests", {headers: auth})).json();
  assert.equal((await s.json("/api/requests/" + row.id, "PATCH", {status: "ok"}, auth)).status, 200);
  assert.equal((await (await s.call("/api/requests", {headers: auth})).json())[0].status, "ok");
  assert.equal((await s.json("/api/requests/" + row.id, "PATCH", {status: null}, auth)).status, 200);
  assert.equal((await (await s.call("/api/requests", {headers: auth})).json())[0].status, null);
  assert.equal((await s.json("/api/requests/" + row.id, "PATCH", {status: "lol"}, auth)).status, 400);
  assert.equal((await s.json("/api/requests/" + row.id, "PATCH", {status: "ok"})).status, 401);
});

test("deleting a request removes its files", async t => {
  const s = await start(t);
  const id = await upload(s, Buffer.from("abc"));
  await submit(s, {songs: [{upload: id}]});
  const auth = await login(s);
  const [row] = await (await s.call("/api/requests", {headers: auth})).json();
  const file = path.join(s.dataDir, "files", row.songs[0].url.split("/").pop());
  assert.ok(fs.existsSync(file));
  assert.equal((await s.call("/api/requests/" + row.id, {method: "DELETE", headers: auth})).status, 200);
  assert.ok(!fs.existsSync(file));
  assert.deepEqual(await (await s.call("/api/requests", {headers: auth})).json(), []);
});

test("cleanup drops abandoned uploads but keeps fresh ones", async t => {
  const s = await start(t, {uploadTtl: 1000});
  const old = await upload(s, Buffer.from("old"));
  s.app.cleanup(Date.now() + 2000);
  assert.ok(!fs.existsSync(path.join(s.dataDir, "tmp", old)));
  assert.equal((await s.call("/api/uploads/" + old)).status, 404);
  const fresh = await upload(s, Buffer.from("new"));
  s.app.cleanup(Date.now());
  assert.ok(fs.existsSync(path.join(s.dataDir, "tmp", fresh)));
});
