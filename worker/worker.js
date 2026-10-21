// Temp Text Store API — Cloudflare Worker + KV.
// Stores opaque (client-side AES-GCM encrypted) blobs; KV expirationTtl deletes them server-side.
const MAX_TTL = 3600; // 1 hour
const MIN_TTL = 60; // KV minimum
const MAX_BYTES = 25 * 1024 * 1024; // KV value limit
const ID_RE = /^[A-Za-z0-9_-]{22}$/;
const TOKEN_RE = /^[0-9a-f]{32}$/;

function corsHeaders(req, env) {
  const allowed = (env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean);
  const origin = req.headers.get('Origin') || '';
  return {
    'Access-Control-Allow-Origin': allowed.includes('*') ? '*' : allowed.includes(origin) ? origin : allowed[0],
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-TTL, X-Delete-Token, X-Version',
    'Access-Control-Expose-Headers': 'X-Expires-At',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function originAllowed(req, env) {
  const allowed = (env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim());
  return allowed.includes('*') || allowed.includes(req.headers.get('Origin') || '');
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function newId() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ---- sync rooms ----
// Room id = 256-bit value derived client-side from the sync code (the AES key is derived separately
// and never leaves the browser). Index key i:<room> lists {id, v, expiresAt, size}; blobs live at n:<room>:<id>.
const ROOM_RE = /^[A-Za-z0-9_-]{43}$/;
const NOTE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_ROOM_NOTES = 500;

async function readIndex(env, room) {
  const now = Date.now();
  const idx = (await env.NOTES.get(`i:${room}`, { type: 'json' })) || [];
  return idx.filter((e) => e.expiresAt > now);
}

async function writeIndex(env, room, idx) {
  if (!idx.length) return env.NOTES.delete(`i:${room}`);
  const maxExp = Math.max(...idx.map((e) => e.expiresAt));
  const ttl = Math.max(MIN_TTL, Math.ceil((maxExp - Date.now()) / 1000));
  await env.NOTES.put(`i:${room}`, JSON.stringify(idx), { expirationTtl: ttl });
}

async function handleRoom(req, env, cors, room, id) {
  if (!ROOM_RE.test(room)) return json({ error: 'bad room' }, 400, cors);
  if (id !== undefined && !NOTE_ID_RE.test(id)) return json({ error: 'bad id' }, 400, cors);
  if ((req.method === 'PUT' || req.method === 'DELETE') && !originAllowed(req, env)) {
    return json({ error: 'origin not allowed' }, 403, cors);
  }

  if (req.method === 'GET' && id === undefined) {
    return json({ notes: await readIndex(env, room) }, 200, cors);
  }

  if (req.method === 'GET') {
    const { value, metadata } = await env.NOTES.getWithMetadata(`n:${room}:${id}`, { type: 'arrayBuffer' });
    if (!value || !metadata || metadata.expiresAt <= Date.now()) return json({ error: 'not found' }, 404, cors);
    return new Response(value, {
      headers: { ...cors, 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Expires-At': String(metadata.expiresAt) },
    });
  }

  if (req.method === 'PUT') {
    if (Number(req.headers.get('Content-Length') || 0) > MAX_BYTES) return json({ error: 'too large' }, 413, cors);
    const body = await req.arrayBuffer();
    if (body.byteLength === 0) return json({ error: 'empty body' }, 400, cors);
    if (body.byteLength > MAX_BYTES) return json({ error: 'too large' }, 413, cors);
    const v = Number(req.headers.get('X-Version'));
    if (!Number.isFinite(v) || v <= 0) return json({ error: 'X-Version required' }, 400, cors);
    const ttl = Math.min(MAX_TTL, Math.max(MIN_TTL, parseInt(req.headers.get('X-TTL'), 10) || MAX_TTL));
    const expiresAt = Date.now() + ttl * 1000;
    const idx = (await readIndex(env, room)).filter((e) => e.id !== id);
    if (idx.length >= MAX_ROOM_NOTES) return json({ error: 'room full' }, 409, cors);
    await env.NOTES.put(`n:${room}:${id}`, body, { expirationTtl: ttl, metadata: { expiresAt } });
    idx.push({ id, v, expiresAt, size: body.byteLength });
    await writeIndex(env, room, idx);
    return json({ id, v, expiresAt }, 200, cors);
  }

  if (req.method === 'DELETE' && id) {
    await env.NOTES.delete(`n:${room}:${id}`);
    const idx = await readIndex(env, room);
    const rest = idx.filter((e) => e.id !== id);
    if (rest.length !== idx.length) await writeIndex(env, room, rest);
    return new Response(null, { status: 204, headers: cors });
  }

  return json({ error: 'method not allowed' }, 405, cors);
}

export default {
  async fetch(req, env) {
    // accept either binding name (wrangler.toml uses NOTES; dashboard-generated config uses KV_BINDING)
    env = { ...env, NOTES: env.NOTES || env.KV_BINDING };
    if (!env.NOTES) return json({ error: 'KV binding missing (NOTES or KV_BINDING)' }, 500, {});
    const cors = corsHeaders(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const path = new URL(req.url).pathname;
    const r = path.match(/^\/api\/rooms\/([^/]+)(?:\/([^/]+))?\/?$/);
    if (r) return handleRoom(req, env, cors, r[1], r[2]);

    const m = path.match(/^\/api\/notes(?:\/([^/]+))?\/?$/);
    if (!m) return json({ error: 'not found' }, 404, cors);
    const id = m[1];
    if (id !== undefined && !ID_RE.test(id)) return json({ error: 'bad id' }, 400, cors);

    if (req.method === 'POST' && id === undefined) {
      // Browser-origin gate only (curl can bypass); keeps other sites off your quota.
      if (!originAllowed(req, env)) return json({ error: 'origin not allowed' }, 403, cors);
      const token = req.headers.get('X-Delete-Token') || '';
      if (!TOKEN_RE.test(token)) return json({ error: 'X-Delete-Token must be 32 hex chars' }, 400, cors);
      if (Number(req.headers.get('Content-Length') || 0) > MAX_BYTES) return json({ error: 'too large' }, 413, cors);
      const body = await req.arrayBuffer();
      if (body.byteLength === 0) return json({ error: 'empty body' }, 400, cors);
      if (body.byteLength > MAX_BYTES) return json({ error: 'too large' }, 413, cors);
      const ttl = Math.min(MAX_TTL, Math.max(MIN_TTL, parseInt(req.headers.get('X-TTL'), 10) || MAX_TTL));
      const expiresAt = Date.now() + ttl * 1000;
      const newKey = newId();
      await env.NOTES.put(newKey, body, { expirationTtl: ttl, metadata: { expiresAt, token } });
      return json({ id: newKey, expiresAt }, 201, cors);
    }

    if (req.method === 'GET' && id) {
      const { value, metadata } = await env.NOTES.getWithMetadata(id, { type: 'arrayBuffer' });
      // KV expiry is eventually consistent; enforce the exact deadline here too.
      if (!value || !metadata || metadata.expiresAt <= Date.now()) return json({ error: 'not found' }, 404, cors);
      return new Response(value, {
        headers: {
          ...cors,
          'Content-Type': 'application/octet-stream',
          'Cache-Control': 'no-store',
          'X-Expires-At': String(metadata.expiresAt),
        },
      });
    }

    if (req.method === 'DELETE' && id) {
      const { value, metadata } = await env.NOTES.getWithMetadata(id, { type: 'stream' });
      if (value) await value.cancel();
      if (!metadata) return new Response(null, { status: 204, headers: cors });
      if (req.headers.get('X-Delete-Token') !== metadata.token) return json({ error: 'forbidden' }, 403, cors);
      await env.NOTES.delete(id);
      return new Response(null, { status: 204, headers: cors });
    }

    return json({ error: 'method not allowed' }, 405, cors);
  },
};
