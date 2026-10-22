// Each test gets its own client IP so the write rate limiter (30/min/IP) doesn't bleed across tests.
// Cloudflare overwrites CF-Connecting-IP in production, so this only works against `wrangler dev`.
export const freshIp = () => `10.${rnd()}.${rnd()}.${rnd()}`;
const rnd = () => Math.floor(Math.random() * 254) + 1;

export const room = () => {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(b).toString('base64url');
};

export function headersFor(baseURL, ip, extra = {}) {
  return { Origin: baseURL, 'CF-Connecting-IP': ip, ...extra };
}
