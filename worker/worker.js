// Temp Text Store API — Cloudflare Worker.
// Everything stored here is ciphertext produced in the browser (AES-256-GCM); the server never sees keys.
//   /api/notes/*  one-off share links  -> Workers KV (expirationTtl)
//   /api/rooms/*  sync rooms           -> Durable Object `Room` (SQLite, strongly consistent, WebSocket push)
import { DurableObject } from 'cloudflare:workers';

const MAX_TTL = 3600; // 1 hour
const MIN_TTL = 60; // KV minimum
const MAX_BYTES = 10 * 1024 * 1024; // per note, after client-side gzip + encryption
const MAX_ROOM_NOTES = 200;
const MAX_ROOM_BYTES = 50 * 1024 * 1024;
const CHUNK = 1024 * 1024; // DO SQLite rows are capped at 2 MB
const ID_RE = /^[A-Za-z0-9_-]{22}$/;
const TOKEN_RE = /^[0-9a-f]{32}$/;
const ROOM_RE = /^[A-Za-z0-9_-]{43}$/; // 256-bit room id derived client-side from the sync code
const NOTE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

function corsHeaders(req, env) {
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const origin = req.headers.get('Origin') || '';
  if (!allowed.length || !(allowed.includes('*') || allowed.includes(origin))) return { Vary: 'Origin' };
  return {
    'Access-Control-Allow-Origin': allowed.includes('*') ? '*' : origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-TTL, X-Delete-Token',
    'Access-Control-Expose-Headers': 'X-Expires-At, X-Version',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

// Writes must come from the page itself (same origin) or an explicitly allowed origin.
// Browser-only gate: curl can forge Origin, so the rate limiter below is the real abuse control.
function originAllowed(req, env) {
  const origin = req.headers.get('Origin');
  if (!origin) return false;
  if (origin === new URL(req.url).origin) return true;
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim());
  return allowed.includes('*') || allowed.includes(origin);
}

function json(body, status, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...SECURITY_HEADERS, ...headers, 'Content-Type': 'application/json' },
  });
}

function blobResponse(body, headers) {
  return new Response(body, { headers: { ...SECURITY_HEADERS, ...headers, 'Content-Type': 'application/octet-stream' } });
}

function clampTtl(raw) {
  return Math.min(MAX_TTL, Math.max(MIN_TTL, parseInt(raw, 10) || MAX_TTL));
}

function newId() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function readBody(req) {
  if (Number(req.headers.get('Content-Length') || 0) > MAX_BYTES) return { error: json({ error: 'too large' }, 413) };
  const body = await req.arrayBuffer();
  if (body.byteLength === 0) return { error: json({ error: 'empty body' }, 400) };
  if (body.byteLength > MAX_BYTES) return { error: json({ error: 'too large' }, 413) };
  return { body };
}

function withCors(res, cors) {
  if (res.status === 101) return res; // WebSocket upgrade: headers are immutable
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
  return out;
}

// ---- Durable Object: one instance per sync room ----
export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY, v INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        size INTEGER NOT NULL, chunks INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT NOT NULL, seq INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (id, seq));
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, n INTEGER NOT NULL);
    `);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  purgeExpired() {
    const now = Date.now();
    const expired = this.sql.exec('SELECT id FROM notes WHERE expires_at <= ?', now).toArray();
    for (const { id } of expired) {
      this.sql.exec('DELETE FROM chunks WHERE id = ?', id);
      this.sql.exec('DELETE FROM notes WHERE id = ?', id);
    }
    return expired.length;
  }

  nextVersion() {
    this.sql.exec("INSERT INTO meta (k, n) VALUES ('seq', 1) ON CONFLICT (k) DO UPDATE SET n = n + 1");
    return this.sql.exec("SELECT n FROM meta WHERE k = 'seq'").one().n;
  }

  async scheduleAlarm() {
    const row = this.sql.exec('SELECT MIN(expires_at) AS t FROM notes').one();
    if (row.t) await this.ctx.storage.setAlarm(row.t);
    else await this.ctx.storage.deleteAlarm();
  }

  broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(data); } catch { /* socket closing */ }
    }
  }

  list() {
    this.purgeExpired();
    return this.sql.exec('SELECT id, v, expires_at AS expiresAt, size FROM notes ORDER BY v').toArray();
  }

  get(id) {
    const note = this.sql.exec('SELECT v, expires_at, chunks FROM notes WHERE id = ? AND expires_at > ?', id, Date.now()).toArray()[0];
    if (!note) return null;
    const parts = this.sql.exec('SELECT data FROM chunks WHERE id = ? ORDER BY seq', id).toArray();
    const total = parts.reduce((n, p) => n + p.data.byteLength, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { out.set(new Uint8Array(p.data), off); off += p.data.byteLength; }
    return { body: out, v: note.v, expiresAt: note.expires_at };
  }

  async put(id, body, ttl) {
    this.purgeExpired();
    const others = this.sql.exec('SELECT COUNT(*) AS c, COALESCE(SUM(size), 0) AS s FROM notes WHERE id != ?', id).one();
    if (others.c >= MAX_ROOM_NOTES) return { error: 'room full (notes)', status: 409 };
    if (others.s + body.byteLength > MAX_ROOM_BYTES) return { error: 'room full (bytes)', status: 409 };
    const bytes = new Uint8Array(body);
    const chunks = Math.ceil(bytes.byteLength / CHUNK);
    const expiresAt = Date.now() + ttl * 1000;
    const v = this.ctx.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM chunks WHERE id = ?', id);
      for (let i = 0; i < chunks; i++) {
        this.sql.exec('INSERT INTO chunks (id, seq, data) VALUES (?, ?, ?)', id, i, bytes.slice(i * CHUNK, (i + 1) * CHUNK).buffer);
      }
      const ver = this.nextVersion();
      this.sql.exec(
        `INSERT INTO notes (id, v, expires_at, size, chunks) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET v = excluded.v, expires_at = excluded.expires_at, size = excluded.size, chunks = excluded.chunks`,
        id, ver, expiresAt, bytes.byteLength, chunks);
      return ver;
    });
    await this.scheduleAlarm();
    this.broadcast({ type: 'changed', v });
    return { id, v, expiresAt };
  }

  async remove(id) {
    const existed = this.ctx.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM chunks WHERE id = ?', id);
      return this.sql.exec('DELETE FROM notes WHERE id = ?', id).rowsWritten > 0;
    });
    if (existed) {
      const v = this.nextVersion();
      await this.scheduleAlarm();
      this.broadcast({ type: 'changed', v });
    }
  }

  async alarm() {
    if (this.purgeExpired()) this.broadcast({ type: 'changed', v: this.nextVersion() });
    await this.scheduleAlarm();
  }

  // WebSocket push: the browser only learns "something changed" and then pulls the list.
  async fetch(req) {
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    if (this.ctx.getWebSockets().length >= 50) return new Response('too many sockets', { status: 429 });
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage() { /* clients don't send anything except auto-answered pings */ }

  webSocketClose(ws, code) {
    try { ws.close(code, 'bye'); } catch { /* already closed */ }
  }
}

async function handleRoom(req, env, room, id, sub) {
  if (!ROOM_RE.test(room)) return json({ error: 'bad room' }, 400);
  const stub = env.ROOMS.get(env.ROOMS.idFromName(room));

  if (sub === 'ws') {
    if (req.method !== 'GET' || !originAllowed(req, env)) return json({ error: 'origin not allowed' }, 403);
    return stub.fetch(req);
  }
  if (id !== undefined && !NOTE_ID_RE.test(id)) return json({ error: 'bad id' }, 400);

  if (req.method === 'GET' && id === undefined) return json({ notes: await stub.list() }, 200);

  if (req.method === 'GET') {
    const note = await stub.get(id);
    if (!note) return json({ error: 'not found' }, 404);
    return blobResponse(note.body, { 'X-Version': String(note.v), 'X-Expires-At': String(note.expiresAt) });
  }

  if (req.method === 'PUT') {
    const { body, error } = await readBody(req);
    if (error) return error;
    const res = await stub.put(id, body, clampTtl(req.headers.get('X-TTL')));
    return res.error ? json({ error: res.error }, res.status) : json(res, 200);
  }

  if (req.method === 'DELETE' && id) {
    await stub.remove(id);
    return new Response(null, { status: 204, headers: SECURITY_HEADERS });
  }

  return json({ error: 'method not allowed' }, 405);
}

async function handleShare(req, env, id) {
  if (id !== undefined && !ID_RE.test(id)) return json({ error: 'bad id' }, 400);

  if (req.method === 'POST' && id === undefined) {
    const token = req.headers.get('X-Delete-Token') || '';
    if (!TOKEN_RE.test(token)) return json({ error: 'X-Delete-Token must be 32 hex chars' }, 400);
    const { body, error } = await readBody(req);
    if (error) return error;
    const ttl = clampTtl(req.headers.get('X-TTL'));
    const expiresAt = Date.now() + ttl * 1000;
    const newKey = newId();
    await env.NOTES.put(newKey, body, { expirationTtl: ttl, metadata: { expiresAt, token } });
    return json({ id: newKey, expiresAt }, 201);
  }

  if (req.method === 'GET' && id) {
    const { value, metadata } = await env.NOTES.getWithMetadata(id, { type: 'arrayBuffer' });
    // KV expiry is eventually consistent; enforce the exact deadline here too.
    if (!value || !metadata || metadata.expiresAt <= Date.now()) return json({ error: 'not found' }, 404);
    return blobResponse(value, { 'X-Expires-At': String(metadata.expiresAt) });
  }

  if (req.method === 'DELETE' && id) {
    const { value, metadata } = await env.NOTES.getWithMetadata(id, { type: 'stream' });
    if (value) await value.cancel();
    if (!metadata) return new Response(null, { status: 204, headers: SECURITY_HEADERS });
    if (req.headers.get('X-Delete-Token') !== metadata.token) return json({ error: 'forbidden' }, 403);
    await env.NOTES.delete(id);
    return new Response(null, { status: 204, headers: SECURITY_HEADERS });
  }

  return json({ error: 'method not allowed' }, 405);
}

export default {
  async fetch(req, env) {
    // accept either binding name (wrangler.toml uses NOTES; dashboard-generated config uses KV_BINDING)
    env = { ...env, NOTES: env.NOTES || env.KV_BINDING };
    const cors = corsHeaders(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (!env.NOTES || !env.ROOMS) return json({ error: 'server misconfigured: NOTES (KV) / ROOMS (DO) binding missing' }, 500, cors);

    const isWrite = req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE';
    if (isWrite) {
      if (!originAllowed(req, env)) return json({ error: 'origin not allowed' }, 403, cors);
      if (env.WRITE_LIMITER) {
        const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
        const { success } = await env.WRITE_LIMITER.limit({ key: ip });
        if (!success) return json({ error: 'rate limited — thử lại sau 1 phút' }, 429, { ...cors, 'Retry-After': '60' });
      }
    }

    const path = new URL(req.url).pathname;
    let res;
    const r = path.match(/^\/api\/rooms\/([^/]+)(?:\/([^/]+))?(?:\/(ws))?\/?$/);
    const s = path.match(/^\/api\/notes(?:\/([^/]+))?\/?$/);
    if (r && r[2] === 'ws' && !r[3]) res = await handleRoom(req, env, r[1], undefined, 'ws');
    else if (r && !r[3]) res = await handleRoom(req, env, r[1], r[2]);
    else if (s) res = await handleShare(req, env, s[1]);
    else res = json({ error: 'not found' }, 404);
    return withCors(res, cors);
  },
};
