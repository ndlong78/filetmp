import { test, expect } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { freshIp, room, headersFor } from './helpers.js';

test.describe('static site', () => {
  test('serves page with security headers, hides server files', async ({ request }) => {
    const res = await request.get('/');
    expect(res.status()).toBe(200);
    const csp = res.headers()['content-security-policy'] || '';
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers()['x-content-type-options']).toBe('nosniff');
    expect((await request.get('/app.js')).status()).toBe(200);
    for (const p of ['/worker/worker.js', '/wrangler.toml', '/package.json', '/tests/api.spec.js']) {
      expect((await request.get(p)).status(), p).toBe(404);
    }
  });
});

test.describe('rooms (Durable Object)', () => {
  test('put / list / get / versions / delete', async ({ request, baseURL }) => {
    const r = room();
    const h = headersFor(baseURL, freshIp());
    expect(await (await request.get(`/api/rooms/${r}`)).json()).toEqual({ notes: [] });

    const p1 = await request.put(`/api/rooms/${r}/note-aaaa`, { headers: { ...h, 'X-TTL': '120' }, data: Buffer.from('one') });
    expect(p1.status()).toBe(200);
    const { v: v1 } = await p1.json();
    const p2 = await request.put(`/api/rooms/${r}/note-aaaa`, { headers: { ...h, 'X-TTL': '120' }, data: Buffer.from('two') });
    const { v: v2 } = await p2.json();
    expect(v2).toBeGreaterThan(v1); // server-assigned, monotonic

    const list = (await (await request.get(`/api/rooms/${r}`)).json()).notes;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'note-aaaa', v: v2, size: 3 });
    const g = await request.get(`/api/rooms/${r}/note-aaaa`);
    expect(await g.text()).toBe('two');
    expect(g.headers()['x-version']).toBe(String(v2));

    expect((await request.delete(`/api/rooms/${r}/note-aaaa`, { headers: h })).status()).toBe(204);
    expect((await (await request.get(`/api/rooms/${r}`)).json()).notes).toEqual([]);
    expect((await request.get(`/api/rooms/${r}/note-aaaa`)).status()).toBe(404);
  });

  test('concurrent writes from different clients never drop a note', async ({ request, baseURL }) => {
    const r = room();
    const ids = Array.from({ length: 12 }, (_, i) => `concurrent-${i}`);
    await Promise.all(ids.map((id) =>
      request.put(`/api/rooms/${r}/${id}`, { headers: { ...headersFor(baseURL, freshIp()), 'X-TTL': '120' }, data: Buffer.from(id) })));
    const list = (await (await request.get(`/api/rooms/${r}`)).json()).notes;
    expect(list.map((n) => n.id).sort()).toEqual([...ids].sort());
    expect(new Set(list.map((n) => n.v)).size).toBe(ids.length); // distinct versions
  });

  test('multi-chunk blob (> 2 MB SQLite row cap) round-trips intact', async ({ request, baseURL }) => {
    const r = room();
    const blob = randomBytes(3 * 1024 * 1024 + 123);
    const put = await request.put(`/api/rooms/${r}/bignote1`, { headers: { ...headersFor(baseURL, freshIp()), 'X-TTL': '120' }, data: blob });
    expect(put.status()).toBe(200);
    const got = Buffer.from(await (await request.get(`/api/rooms/${r}/bignote1`)).body());
    expect(got.equals(blob)).toBe(true);
  });

  test('rejects bad input, foreign origins and oversize bodies', async ({ request, baseURL }) => {
    const r = room();
    const ip = freshIp();
    expect((await request.get('/api/rooms/short')).status()).toBe(400);
    expect((await request.put(`/api/rooms/${r}/x`, { headers: headersFor(baseURL, ip), data: 'a' })).status()).toBe(400);
    expect((await request.put(`/api/rooms/${r}/note-bbbb`, { headers: { 'CF-Connecting-IP': ip }, data: 'a' })).status()).toBe(403);
    expect((await request.put(`/api/rooms/${r}/note-bbbb`, { headers: { Origin: 'https://evil.example', 'CF-Connecting-IP': ip }, data: 'a' })).status()).toBe(403);
    const big = Buffer.alloc(10 * 1024 * 1024 + 1);
    expect((await request.put(`/api/rooms/${r}/note-bbbb`, { headers: headersFor(baseURL, ip), data: big })).status()).toBe(413);
  });

  test('rate limits writes per IP', async ({ request, baseURL }) => {
    const r = room();
    const h = { ...headersFor(baseURL, freshIp()), 'X-TTL': '120' };
    const codes = [];
    for (let i = 0; i < 35; i++) codes.push((await request.put(`/api/rooms/${r}/ratelimit-${i}`, { headers: h, data: 'x' })).status());
    expect(codes.slice(0, 30).every((c) => c === 200)).toBe(true);
    expect(codes).toContain(429);
  });
});

test.describe('share links (KV)', () => {
  test('create / read / delete with token', async ({ request, baseURL }) => {
    const h = headersFor(baseURL, freshIp());
    const token = 'a'.repeat(32);
    const c = await request.post('/api/notes', { headers: { ...h, 'X-TTL': '120', 'X-Delete-Token': token }, data: Buffer.from('shared') });
    expect(c.status()).toBe(201);
    const { id } = await c.json();
    expect(await (await request.get(`/api/notes/${id}`)).text()).toBe('shared');
    expect((await request.delete(`/api/notes/${id}`, { headers: { ...h, 'X-Delete-Token': 'b'.repeat(32) } })).status()).toBe(403);
    expect((await request.delete(`/api/notes/${id}`, { headers: { ...h, 'X-Delete-Token': token } })).status()).toBe(204);
    expect((await request.get(`/api/notes/${id}`)).status()).toBe(404);
  });
});
