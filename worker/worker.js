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
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-TTL, X-Delete-Token',
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

export default {
  async fetch(req, env) {
    const cors = corsHeaders(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const m = new URL(req.url).pathname.match(/^\/api\/notes(?:\/([^/]+))?\/?$/);
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
